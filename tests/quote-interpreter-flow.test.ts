import { describe, expect, it, vi } from "vitest";
import type { AuditClaim, AuditLease, AuditRepository } from "../src/audit.js";
import { appendApprovedQuotePreparations } from "../src/quote-preparation.js";
import { QUOTE_TEXTS, type QuoteBeginResult, type QuoteCloseInput, type QuoteReadResult, type SessionItem } from "../src/quote-session.js";
import { resolveQuoteSessionsConfig } from "../src/quote-session-turns.js";
import { createStudyInterpreter, type InterpreterClient, type InterpreterRun } from "../src/study-interpreter.js";
import { createTextHandler } from "../src/text-handler.js";
import { processTurns, type IncomingTurn } from "../src/turns.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";
import { CATALOG, COLESTEROL, GLUCOSA, HEMOGRAMA, study, TRIGLICERIDOS, TSH_ECLIA, TSH_NEO } from "./support/study-catalog.js";
import type { CatalogStudy } from "../src/types.js";

// Cotizaciones inteligentes por texto, de extremo a extremo SIN base de datos real: mensaje -> sesión -> resolvedor exacto -> intérprete (cliente simulado, ninguna llamada a OpenAI) -> cotización con precios
// del catálogo. La sesión de cotización es un doble con estado que imita al repositorio real.

const LEASE: AuditLease = { owner: "owner-0000001", fence: 1 };
const KEY = "a".repeat(64);
const FROM = "59170000000";

type Item = { mention: string; outcome: "MATCH" | "AMBIGUOUS" | "NOT_FOUND"; confidence: "HIGH" | "LOW"; studyIds: string[] };
const output = (items: Item[], wantsQuote = false) => JSON.stringify({ isQuoteRequest: true, wantsQuote, items });
const match = (mention: string, id: string, confidence: "HIGH" | "LOW" = "HIGH"): Item => ({ mention, outcome: "MATCH", confidence, studyIds: [id] });
const missing = (mention: string): Item => ({ mention, outcome: "NOT_FOUND", confidence: "HIGH", studyIds: [] });
// Un modelo que busca cada mención con la herramienta y la clasifica según lo que encontró.
const searchingModel = (queries: string[], wantsQuote = false) => (run: InterpreterRun) =>
  output(
    queries.map((query) => {
      const found = JSON.parse(run.runTool("search_studies", { query })).results as Array<{ id: string; score: number }>;
      return found.length > 0 && found[0]!.score >= 0.7 ? match(query, found[0]!.id) : missing(query);
    }),
    wantsQuote
  );

// Repositorio de sesiones con estado (una sesión abierta por contacto).
function sessionAudit() {
  let n = 0;
  let session: { id: string; items: SessionItem[] } | undefined;
  let sessions = 0;
  const closes: QuoteCloseInput[] = [];
  const repo = {
    claim: vi.fn(async (): Promise<AuditClaim> => ({ kind: "claimed", runId: `run-${++n}`, lease: LEASE, takeover: false })),
    renewLease: vi.fn(async () => true), recordIgnored: vi.fn(async () => undefined), recordEvidence: vi.fn(async () => undefined), recordFailure: vi.fn(async () => undefined),
    reserveSend: vi.fn(async (): Promise<string> => "reserved"), confirmSend: vi.fn(async (): Promise<string> => "proceed"), recordReply: vi.fn(async () => undefined), releaseTurn: vi.fn(async () => undefined),
    quoteBegin: vi.fn(async (_run: string, _lease: AuditLease, input: { kind: "TEXT" | "IMAGE"; result?: Omit<SessionItem, "id" | "seq" | "kind" | "status"> & { status: SessionItem["status"] } }): Promise<QuoteBeginResult> => {
      if (!session) session = { id: `s${++sessions}`, items: [] };
      const result = input.result!;
      const item: SessionItem = { id: `i${session.items.length + 1}`, seq: session.items.length + 1, kind: "TEXT", status: result.status, studyIds: result.studyIds, ambiguous: result.ambiguous, unresolved: result.unresolved, reasons: result.reasons };
      session.items.push(item);
      return { status: "created", itemId: item.id, sessionId: session.id, itemStatus: item.status, position: session.items.length, studyIds: item.studyIds, unresolved: item.unresolved, ambiguousGroups: item.ambiguous.length };
    }),
    quoteFinish: vi.fn(async () => undefined),
    quoteRead: vi.fn(async (): Promise<QuoteReadResult> => (session ? { state: "ready", sessionId: session.id, items: session.items.map((item) => ({ ...item })) } : { state: "none" })),
    quoteClose: vi.fn(async (_run: string, _lease: AuditLease, input: QuoteCloseInput) => {
      closes.push(input);
      session = undefined;
      return { status: "closed" as const, outcome: input.outcome };
    }),
    quoteLastStudies: vi.fn(async () => [] as string[])
  };
  return { repo: repo as unknown as AuditRepository & typeof repo, closes, open: () => session };
}

// Conocimiento aprobado simulado: solo los estudios de `approved` tienen preparación.
function fakeKnowledge(approved: Record<string, { fastingHours: number }>) {
  const getStudyPreparation = vi.fn(async (ids: readonly string[]) => ({
    status: "PARTIAL",
    items: ids.map((id) =>
      approved[id]
        ? { studyId: id, result: { status: "AVAILABLE", data: { studyId: id, prepState: "HAS_PREPARATION", fastingHours: approved[id]!.fastingHours }, provenance: [{ kind: "STUDY_PREPARATION", key: `study:${id}`, version: 1, contentHash: "h".repeat(64) }] } }
        : { studyId: id, result: { status: "UNAVAILABLE", reason: "NO_APPROVED_DATA" } }
    )
  }));
  return { knowledge: { getStudyPreparation } as never, getStudyPreparation };
}

function world(options: { interpret?: (run: InterpreterRun) => string | Promise<string>; noInterpreter?: boolean; approved?: Record<string, { fastingHours: number }>; catalog?: CatalogStudy[] } = {}) {
  const { repo, closes, open } = sessionAudit();
  const sends: string[] = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  const runs: InterpreterRun[] = [];
  const client: InterpreterClient = {
    run: vi.fn(async (run) => {
      runs.push(run);
      return { text: await (options.interpret ?? (() => output([])))(run), rounds: 2, toolCalls: 1 };
    })
  };
  const interpreter = options.noInterpreter ? undefined : createStudyInterpreter({ client, model: "modelo-de-prueba", log: (event, data) => logs.push([event, data]) });
  const prep = fakeKnowledge(options.approved ?? {});
  const traces: unknown[] = [];
  const deps: QuoteDeps = {
    downloadImage: vi.fn(async () => ({ bytes: new Uint8Array() })),
    loadCatalog: vi.fn(async () => structuredClone(options.catalog ?? CATALOG)),
    analyze: vi.fn(async () => { throw new Error("no se usa"); }),
    sendText: vi.fn(async (_to: string, body: string) => { sends.push(body); return { providerMessageId: "wamid.out" }; }),
    log: (event, data) => logs.push([event, data]),
    audit: repo,
    leaseRenewIntervalMs: 3_600_000,
    ...(options.approved
      ? { quotePreparations: async (quote, studyIds, catalog) => appendApprovedQuotePreparations({ quote, studyIds, catalog, knowledge: prep.knowledge, trace: async (refs) => { traces.push(refs); return true; } }) }
      : {}),
    turns: {
      contactKeyFor: () => KEY,
      busyRetries: 1, busyDelayMs: 1, sleep: async () => undefined,
      handlers: { text: createTextHandler({ log: () => undefined }) },
      quoteSessions: resolveQuoteSessionsConfig({ waitRetries: 0, sleep: async () => undefined, ...(interpreter ? { interpreter } : {}) })
    }
  };
  let counter = 0;
  const say = async (body: string) => {
    const turn: IncomingTurn = { messageId: `wamid.in${++counter}`, from: FROM, kind: "TEXT", text: body };
    await processTurns([turn], deps);
    return sends.at(-1)!;
  };
  return { say, sends, repo, closes, open, client, runs, logs, prep, traces };
}

const quotedLines = (closes: QuoteCloseInput[]) => {
  const quoted = closes.find((close) => close.outcome === "QUOTED");
  return quoted && quoted.outcome === "QUOTED" ? quoted : undefined;
};

describe("cotización por texto con el intérprete", () => {
  it("entiende un error de ortografía y una abreviatura y cotiza con los precios del catálogo", async () => {
    const w = world({ interpret: searchingModel(["glucoza", "bh"], true) });
    const reply = await w.say("cotízame glucoza y bh");
    const quote = quotedLines(w.closes)!;
    expect(quote.lines.map((line) => line.name).sort()).toEqual([GLUCOSA.name, HEMOGRAMA.name].sort());
    // El precio y el total los calcula el backend con el catálogo, nunca el modelo.
    expect(quote.lines.find((line) => line.studyId === GLUCOSA.id)!.priceBs).toBe(GLUCOSA.priceBs);
    expect(quote.totalBs).toBe(GLUCOSA.priceBs + HEMOGRAMA.priceBs);
    expect(reply).toContain("GLUCOSA");
    expect(reply).toContain("HEMOGRAMA COMPLETO AUTOMATIZADO");
    expect(reply).not.toContain("Interpreté");
    expect(reply).toContain(GLUCOSA.name);
    // «bh» ya lo había identificado el resolvedor exacto: no se presenta como interpretación ni como repetido.
    expect(reply).not.toContain("«bh»");
    expect(reply).not.toContain("repetiste");
  });

  it("si un estudio no existe, dice cuál falta y cotiza los disponibles sin inventar nada", async () => {
    const w = world({ interpret: searchingModel(["hemograma", "tomografia"], true) });
    const reply = await w.say("cotízame hemograma y tomografia");
    const quote = quotedLines(w.closes)!;
    expect(quote.lines.map((line) => line.studyId)).toEqual([HEMOGRAMA.id]);
    expect(quote.totalBs).toBe(HEMOGRAMA.priceBs);
    expect(reply).toContain("No encontré en nuestro catálogo: «tomografia».");
    expect(reply).toContain("HEMOGRAMA COMPLETO AUTOMATIZADO");
    expect(reply).not.toMatch(/tomograf[^.]*\s—\s/i);
    // La solicitud en sesión quedó limpia: lo que no existe no bloquea ni deja dudas.
    expect(w.repo.quoteBegin).toHaveBeenCalledWith(expect.anything(), LEASE, expect.objectContaining({ result: expect.objectContaining({ status: "RESOLVED", unresolved: 0, studyIds: [HEMOGRAMA.id] }) }));
  });

  it("si TODO lo pedido falta, lo dice y no abre ni toca la solicitud", async () => {
    const w = world({ interpret: searchingModel(["tomografia"], true) });
    const reply = await w.say("quiero cotizar una tomografia");
    expect(reply).toContain("No encontré en nuestro catálogo: «tomografia».");
    expect(reply).toContain("envíame una foto de tu receta");
    expect(w.repo.quoteBegin).not.toHaveBeenCalled();
    expect(w.closes).toEqual([]);
  });

  it("un pedido natural cuyo estudio no existe en el catálogo (perfil lipídico) se informa y se cotiza el resto", async () => {
    const w = world({ interpret: (run) => output([missing("perfil lipidico"), ...(JSON.parse(run.runTool("search_studies", { query: "glucosa" })).results[0] ? [match("glucosa", GLUCOSA.id)] : [])], true) });
    const reply = await w.say("mi mamá quiere hacerse el perfil lipidico y la glucosa");
    expect(quotedLines(w.closes)!.lines.map((line) => line.studyId)).toEqual([GLUCOSA.id]);
    expect(reply).toContain("«perfil lipidico»");
  });

  it("un modelo que inventa un estudio (nunca lo buscó) no consigue una cotización: se pide el nombre exacto", async () => {
    const w = world({ interpret: () => output([match("zzqxv", TRIGLICERIDOS.id)], true) });
    const reply = await w.say("cotiza zzqxv");
    expect(w.closes).toEqual([]);
    expect(reply).toContain(QUOTE_TEXTS.ask_unresolved);
  });

  it("poca seguridad del modelo tampoco se cotiza", async () => {
    const w = world({ interpret: (run) => { const id = JSON.parse(run.runTool("search_studies", { query: "glucoza" })).results[0].id; return output([match("zzqxv", id, "LOW")], true); } });
    const reply = await w.say("cotiza zzqxv");
    expect(w.closes).toEqual([]);
    expect(reply).toContain(QUOTE_TEXTS.ask_unresolved);
  });

  it("si el modelo dice que no existe algo que el catálogo sí tiene, no se le dice al paciente que falta: se le ofrecen las opciones", async () => {
    const w = world({ interpret: () => output([missing("glucosa")], true) });
    const reply = await w.say("cotiza zzqxv");
    expect(w.closes).toEqual([]);
    expect(reply).not.toContain("No encontré en nuestro catálogo");
    expect(reply).toContain(QUOTE_TEXTS.ask_option_intro);
    expect(reply).toContain("1. GLUCOSA");
  });

  it("acumula en varios mensajes: anota lo interpretado y cotiza al decir listo", async () => {
    const w = world({ interpret: searchingModel(["glucoza"]) });
    const ack = await w.say("glucoza");
    expect(ack).not.toContain("Interpreté");
    expect(ack).toContain(GLUCOSA.name);
    expect(ack).toContain(QUOTE_TEXTS.confirm_done);
    expect(w.closes).toEqual([]);
    const reply = await w.say("listo");
    expect(quotedLines(w.closes)!.totalBs).toBe(GLUCOSA.priceBs);
    expect(reply).toContain("GLUCOSA");
  });

  it("varias opciones válidas: pregunta con las del catálogo y, al elegir, cotiza lo elegido", async () => {
    const ANTI_SS = study(51, "ANTI-DNA ss (Simple Cadena) IgG (Elisa)", [], 90);
    const ANTI_DS = study(52, "ANTI-DNA ds (Doble Cadena) IgG (Elisa)", [], 95);
    const w = world({ catalog: [...CATALOG, ANTI_SS, ANTI_DS], noInterpreter: true });
    const ask = await w.say("cotiza anti-dna");
    expect(ask).toContain(QUOTE_TEXTS.ask_option_intro);
    expect(ask).toMatch(/1. ANTI-DNA/);
    expect(w.closes).toEqual([]);
    const chosen = await w.say("2");
    expect(chosen).toContain("Estudios anotados:");
    await w.say("listo");
    expect(quotedLines(w.closes)!.lines).toHaveLength(1);
  });

  it("si el paciente no dice el método, se asume el más rápido (ECLIA) y se le dice; si lo dice, se respeta", async () => {
    const w = world({ noInterpreter: true });
    const reply = await w.say("cotiza tsh");
    expect(reply).toContain("TSH (ECLIA)");
    expect(reply).not.toContain("NEONATAL");
    expect(reply).not.toContain("Interpreté");
    expect(quotedLines(w.closes)!.lines.map((line) => line.studyId)).toEqual([TSH_ECLIA.id]);
    const neonatal = world({ noInterpreter: true });
    await neonatal.say("cotiza tsh neonatal");
    expect(quotedLines(neonatal.closes)!.lines.map((line) => line.studyId)).toEqual([TSH_NEO.id]);
  });

  it("si el intérprete falla, el mensaje se procesa como siempre (sin interpretación)", async () => {
    const w = world({ interpret: () => { throw new Error("modelo caído"); } });
    const reply = await w.say("cotiza zzqxv");
    expect(w.client.run).toHaveBeenCalled();
    expect(reply).toContain("No encontré en nuestro catálogo: «zzqxv»");
    expect(w.closes).toEqual([]);
  });

  it("un error de ortografía lo resuelve la búsqueda por parecido sin gastar el modelo, y se le dice al paciente cómo se interpretó", async () => {
    const w = world({ interpret: searchingModel([]) });
    const reply = await w.say("cotiza glucoza");
    expect(w.client.run).not.toHaveBeenCalled();
    expect(reply).toContain("GLUCOSA");
    // Lo interpretado ya no se repite al paciente (12-nov): la cotización muestra el nombre, el precio, las indicaciones y el tiempo de entrega.
    expect(reply).not.toContain("Interpreté");
    expect(quotedLines(w.closes)!.totalBs).toBe(GLUCOSA.priceBs);
  });

  it("sin intérprete configurado el comportamiento es el de siempre y el modelo no existe", async () => {
    const w = world({ noInterpreter: true });
    const reply = await w.say("cotiza zzqxv");
    expect(reply).toContain("No encontré en nuestro catálogo: «zzqxv»");
    expect(w.client.run).not.toHaveBeenCalled();
  });

  it("una lista clara que el resolvedor exacto ya entiende no gasta una llamada al modelo", async () => {
    const w = world({ interpret: searchingModel([]) });
    const reply = await w.say("cotízame hemograma y glucosa");
    expect(w.client.run).not.toHaveBeenCalled();
    expect(quotedLines(w.closes)!.totalBs).toBe(HEMOGRAMA.priceBs + GLUCOSA.priceBs);
    expect(reply).not.toContain("Interpreté");
  });

  it("lo médico nunca llega al intérprete", async () => {
    const w = world({ interpret: searchingModel(["glucoza"], true) });
    await w.say("tengo diabetes y quiero cotizar glucoza");
    expect(w.client.run).not.toHaveBeenCalled();
    expect(w.closes).toEqual([]);
  });

  it("el modelo ve candidatos sin precios, y nada del mensaje del paciente se registra", async () => {
    const w = world({ interpret: searchingModel(["glucoza"], true) });
    await w.say("cotiza glucoza");
    expect(JSON.stringify(w.runs.map((run) => run.runTool("search_studies", { query: "glucosa" })))).not.toMatch(/price|precio|\b30\b/i);
    expect(JSON.stringify(w.logs)).not.toContain("glucoza");
  });
});

describe("lista real con dudas: se pregunta con opciones y se puede elegir más de una", () => {
  const VDRL = study(31, "TEST VDRL ( Semi Cuantitativo)", [], 60);
  const HEP_AG = study(32, "HEPATITIS B ANTIGENO DE SUP. (PRUEBA RAPIDA)", [], 65);
  const HEP_AC = study(33, "HEPATITIS B ANTICUERPO DE SUP. PRUEBA RAPIDA", [], 66);
  const catalog = [...CATALOG, VDRL, HEP_AG, HEP_AC];
  it("anota lo claro, pregunta solo la hepatitis con opciones numeradas, acepta «1 y 2» y cotiza todo", async () => {
    const w = world({ catalog, noInterpreter: true });
    const ask = await w.say("HEMATOLOGIA\n* Hemograma Completo\nQUIMICA SANGUINEA\n* Glicemia (Basal)\nSEROLOGIA\n* V.D.R.L\n* Hepatitis B Ag.De Sup (P. Rápida)");
    // directo a la pregunta, sin repetir lo ya identificado (se verá en la cotización)
    expect(ask).not.toContain("Estudios anotados");
    expect(ask).not.toContain("Interpreté");
    expect(ask).toContain(QUOTE_TEXTS.ask_option_intro);
    expect(ask).toContain("1. HEPATITIS B ANTIGENO");
    expect(ask).toContain("2. HEPATITIS B ANTICUERPO");
    expect(ask).toContain(QUOTE_TEXTS.ask_option_outro);
    expect(w.closes).toEqual([]);
    const chosen = await w.say("1 y 2");
    expect(chosen).toContain("Estudios anotados:");
    expect(chosen).toContain(QUOTE_TEXTS.confirm_done);
    await w.say("sí");
    const quoted = quotedLines(w.closes)!;
    expect(quoted.lines.map((line) => line.studyId).sort()).toEqual([HEMOGRAMA, GLUCOSA, VDRL, HEP_AG, HEP_AC].map((item) => item.id).sort());
    expect(quoted.totalBs).toBe(HEMOGRAMA.priceBs + GLUCOSA.priceBs + VDRL.priceBs + HEP_AG.priceBs + HEP_AC.priceBs);
  });
  it("una opción fuera de la lista se rechaza sin perder lo anotado", async () => {
    const w = world({ catalog, noInterpreter: true });
    await w.say("Hemograma, Hepatitis B Ag.De Sup (P. Rápida)");
    const invalid = await w.say("1 y 5");
    expect(invalid).toContain(QUOTE_TEXTS.choose_invalid);
    expect(w.closes).toEqual([]);
  });
});

describe("requisitos y preparaciones: solo con datos aprobados", () => {
  const FOOTER = "Respóndenos por este chat para continuar.";

  it("con preparación aprobada la agrega, después de la nota y antes del pie, y registra el rastro", async () => {
    const w = world({ interpret: searchingModel(["glucoza", "tomografia"], true), approved: { [GLUCOSA.id]: { fastingHours: 8 } } });
    const reply = await w.say("cotiza glucoza y tomografia");
    expect(reply).toContain("PREPARACIÓN Y AYUNO");
    expect(reply).toContain("Ayuno: 8 horas");
    const positions = [reply.indexOf("GLUCOSA —"), reply.indexOf("No encontré en nuestro catálogo"), reply.indexOf("PREPARACIÓN Y AYUNO"), reply.indexOf(FOOTER)];
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(w.traces).toHaveLength(1);
    // Solo se consultó la preparación de lo COTIZADO: nunca de lo que falta.
    expect(w.prep.getStudyPreparation).toHaveBeenCalledWith([GLUCOSA.id], expect.anything());
  });

  it("sin datos aprobados muestra solo estudios y precios: nada de preparación ni requisitos inventados", async () => {
    const w = world({ interpret: searchingModel(["glucoza", "hemograma"], true), approved: {} });
    const reply = await w.say("cotiza glucoza y hemograma");
    expect(reply).toContain("GLUCOSA");
    expect(reply).toContain("HEMOGRAMA");
    expect(reply).not.toMatch(/PREPARACI|ayuno|requisit|indicaci/i);
    expect(w.traces).toEqual([]);
  });

  it("con datos aprobados solo de algunos estudios, muestra esos y avisa sin inventar lo demás", async () => {
    const w = world({ interpret: searchingModel(["glucoza", "hemograma"], true), approved: { [GLUCOSA.id]: { fastingHours: 8 } } });
    const reply = await w.say("cotiza glucoza y hemograma");
    expect(reply).toContain("Ayuno: 8 horas");
    expect(reply).toContain("la preparación aún no está confirmada por este canal");
    expect(reply.match(/Ayuno:/g)).toHaveLength(1);
  });

  it("una cotización con colesterol aprobado y otro estudio inexistente no pierde nada de lo cotizado", async () => {
    const w = world({ interpret: searchingModel(["colesterol", "resonancia magnetica"], true), approved: { [COLESTEROL.id]: { fastingHours: 12 } } });
    const reply = await w.say("cotiza colesterol y resonancia magnetica");
    expect(quotedLines(w.closes)!.lines.map((line) => line.studyId)).toEqual([COLESTEROL.id]);
    expect(reply).toContain("Ayuno: 12 horas");
    expect(reply).toContain("«resonancia magnetica»");
  });
});

describe("feedback del piloto (31/10/2026)", () => {
  // Un modelo que corrige la ortografía antes de buscar, como el real.
  const correcting = (corrections: Record<string, string>, wantsQuote = false) => (run: InterpreterRun) =>
    output(
      Object.entries(corrections).map(([mention, query]) => {
        const found = JSON.parse(run.runTool("search_studies", { query })).results as Array<{ id: string; score: number }>;
        return found.length > 0 && found[0]!.score >= 0.7 ? match(mention, found[0]!.id) : missing(mention);
      }),
      wantsQuote
    );

  it("«Hemogtana y tomografía» (con errores) llega al intérprete, cotiza el hemograma e informa la tomografía", async () => {
    const w = world({ interpret: correcting({ Hemogtana: "hemograma", tomografía: "tomografia" }) });
    const reply = await w.say("Hemogtana y tomografía");
    expect(w.client.run).toHaveBeenCalledTimes(1);
    expect(reply).toContain("Estudios anotados: HEMOGRAMA COMPLETO AUTOMATIZADO.");
    expect(reply).not.toContain("Interpreté");
    expect(reply).toContain("No encontré en nuestro catálogo: «tomografía».");
  });

  it("no inventa: con un nombre que no se parece a nada, el modelo no recibe candidatos y no se cotiza", async () => {
    const w = world({ interpret: correcting({ Zzxqwv: "zzxqwv" }) });
    const reply = await w.say("Zzxqwv y tomografía");
    expect(w.closes).toEqual([]);
    expect(reply).not.toMatch(/Bs/);
  });

  it("«Quiero colesterol y triglicéridos» (pedido claro) se cotiza directamente, sin pedir SÍ", async () => {
    const w = world({ interpret: correcting({ colesterol: "colesterol", triglicéridos: "trigliceridos" }) });
    const reply = await w.say("Quiero colesterol y triglicéridos");
    expect(quotedLines(w.closes)!.lines.map((line) => line.studyId).sort()).toEqual([COLESTEROL.id, TRIGLICERIDOS.id].sort());
    expect(reply).toContain("Total de los estudios cotizados");
    expect(reply).not.toContain(QUOTE_TEXTS.confirm_done);
  });

  it("nombrar o agregar estudios sin pedirlos sigue acumulando y preguntando «¿Eso es todo?», y luego se puede agregar más", async () => {
    const w = world({ interpret: correcting({ glucoza: "glucosa" }) });
    expect(await w.say("glucoza")).toContain(QUOTE_TEXTS.confirm_done);
    expect(await w.say("y también hemograma")).toContain(QUOTE_TEXTS.confirm_done);
    expect(w.closes).toEqual([]);
    await w.say("quiero colesterol");
    expect(quotedLines(w.closes)!.lines).toHaveLength(3);
  });

  it("la cotización de texto es compacta: sin líneas en blanco entre encabezado, estudios y total, y conserva precios, total e indicaciones", async () => {
    const w = world({ interpret: correcting({ glucoza: "glucosa", tomografia: "tomografia" }, true), approved: { [GLUCOSA.id]: { fastingHours: 8 } } });
    const reply = await w.say("cotiza glucoza y tomografia");
    const lines = reply.split("\n");
    expect(lines[0]).toBe("🩺 *PlusMedik* · Cotización");
    expect(lines[1]).toMatch(/GLUCOSA — Bs 30$/);
    expect(lines[2]).toMatch(/^💰 \*Total de los estudios cotizados: Bs 30\*$/);
    expect(reply).not.toMatch(/\n\n\n/);
    expect(reply).toContain("• Ayuno: 8 horas.");
    expect(reply).not.toContain("Interpreté");
    expect(reply).toContain("No encontré en nuestro catálogo: «tomografia».");
    expect(lines.at(-1)).toBe("Respóndenos por este chat para continuar. 😊");
    // Más corta que la versión con espacios de antes.
    expect(lines.filter((line) => line === "").length).toBeLessThanOrEqual(4);
  });

  it("sin datos aprobados la cotización compacta trae solo estudios, total y pie", async () => {
    const w = world({ interpret: correcting({ glucoza: "glucosa" }, true), approved: {} });
    const reply = await w.say("cotiza glucoza");
    expect(reply.split("\n").filter((line) => line !== "")).toEqual(["🩺 *PlusMedik* · Cotización", "🍬 GLUCOSA — Bs 30", "💰 *Total de los estudios cotizados: Bs 30*", "Respóndenos por este chat para continuar. 😊"]);
  });
});
