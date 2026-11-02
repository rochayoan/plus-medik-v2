import { describe, expect, it, vi } from "vitest";
import type { AnalysisResult } from "../src/analyze.js";
import type { AuditClaim, AuditLease, AuditRepository } from "../src/audit.js";
import type { Produced, TurnContext } from "../src/guarded-turn.js";
import { deferClosing, groupByContact, mergeContactTurns, mergeProduced } from "../src/turn-batch.js";
import { processTurns, type IncomingTurn, type TurnHandlers, type TurnReply } from "../src/turns.js";
import { TECHNICAL_ISSUE_MESSAGE, type QuoteDeps } from "../src/whatsapp-quote.js";

// Buffering nativo de Kapso (lotes de 15 s: batch:true + data[]) SIN base de datos: la fusión de mensajes y de respuestas (funciones puras) y el procesamiento de un lote con una
// auditoría simulada, que permite comprobar EXACTAMENTE qué corrida reserva el envío, cuál se cierra sin respuesta y dónde cae el rastro. La garantía contra PostgreSQL real
// (pausa humana, tope de 5 respuestas, duplicados, sesiones de cotización) está en tests/kapso-batch-e2e.test.ts.

const LEASE: AuditLease = { owner: "owner-0000001", fence: 1 };
const KEY = "a".repeat(64);
const PHONE = "59170000000";
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]);
const quoteOf = (name: string, priceBs: number) => ({ decision: "AUTO_SAFE", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], outcome: "AUTO_COMPLETE", publicQuote: { studies: [{ name, priceBs }], totalBs: priceBs, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" } }) as AnalysisResult;

const text = (messageId: string, body: string, overrides: Partial<IncomingTurn> = {}): IncomingTurn => ({ messageId, from: PHONE, kind: "TEXT", text: body, ...overrides });
const image = (messageId: string, overrides: Partial<IncomingTurn> = {}): IncomingTurn => ({ messageId, from: PHONE, kind: "IMAGE", mediaId: `media-${messageId}`, ...overrides });
const reply = (body: string, overrides: Partial<Extract<Produced, { kind: "reply" }>> = {}): Produced => ({ kind: "reply", body, result: "conversation", processingStatus: "COMPLETED", stale: "NEWER_TURN", ...overrides });

describe("groupByContact", () => {
  it("separa por contacto y conserva el orden de llegada dentro de cada uno", () => {
    const groups = groupByContact([{ from: "a", n: 1 }, { from: "b", n: 2 }, { from: "a", n: 3 }, { from: "b", n: 4 }, { from: "c", n: 5 }]);
    expect(groups.map((group) => group.map((item) => item.n))).toEqual([[1, 3], [2, 4], [5]]);
  });
});

describe("mergeContactTurns: varios textos de un lote son una sola solicitud", () => {
  const never = () => false;
  const always = () => true;

  it("une los textos seguidos en el orden en que llegaron; el turno efectivo es el último (id e instante)", () => {
    const units = mergeContactTurns([text("m1", "hola", { timestamp: 10 }), text("m2", "quiero glucosa", { timestamp: 11 }), text("m3", "y hemograma", { timestamp: 12 })], never);
    expect(units).toHaveLength(1);
    expect(units[0]!.turn).toMatchObject({ messageId: "m3", kind: "TEXT", text: "hola\nquiero glucosa\ny hemograma", timestamp: 12 });
    expect(units[0]!.members.map((member) => member.messageId)).toEqual(["m1", "m2", "m3"]);
  });

  it("un texto suelto queda idéntico (misma referencia)", () => {
    const only = text("m1", "hola");
    const [unit] = mergeContactTurns([only], never);
    expect(unit!.turn).toBe(only);
    expect(unit!.members).toEqual([only]);
  });

  it("las fotos no cortan la serie de textos y conservan su orden; el texto unido ocupa el lugar del último texto", () => {
    const units = mergeContactTurns([text("t1", "uno"), image("i1"), text("t2", "dos"), image("i2")], never);
    expect(units.map((unit) => unit.turn.messageId)).toEqual(["i1", "t2", "i2"]);
    expect(units[1]!.turn.text).toBe("uno\ndos");
    expect(units[0]!.members).toHaveLength(1);
  });

  it("con textos 'solitarios' (sesiones de cotización) cada texto es su propia solicitud", () => {
    const units = mergeContactTurns([text("t1", "glucosa"), text("t2", "tsh"), text("t3", "listo")], always);
    expect(units.map((unit) => unit.turn.text)).toEqual(["glucosa", "tsh", "listo"]);
  });

  it("un texto solitario corta la serie: lo de antes y lo de después no se mezclan", () => {
    const units = mergeContactTurns([text("t1", "a"), text("t2", "b"), text("t3", "listo"), text("t4", "c"), text("t5", "d")], (body) => body === "listo");
    expect(units.map((unit) => unit.turn.text)).toEqual(["a\nb", "listo", "c\nd"]);
  });

  it("los mensajes de otro tipo nunca se unen", () => {
    const units = mergeContactTurns([{ messageId: "o1", from: PHONE, kind: "OTHER" }, { messageId: "o2", from: PHONE, kind: "OTHER" }, text("t1", "hola")], never);
    expect(units.map((unit) => unit.turn.messageId)).toEqual(["o1", "o2", "t1"]);
  });
});

describe("mergeProduced: todas las respuestas de un lote salen en UN mensaje", () => {
  it("sin respuestas no hay nada que enviar", () => {
    expect(mergeProduced([{ kind: "none" }, { kind: "none" }])).toEqual({ produced: { kind: "none" }, included: [false, false] });
    expect(mergeProduced([]).produced).toEqual({ kind: "none" });
  });

  it("una sola respuesta pasa tal cual", () => {
    const only = reply("hola", { signature: "GREETING" });
    const merged = mergeProduced([{ kind: "none" }, only]);
    expect(merged.produced).toBe(only);
    expect(merged.included).toEqual([false, true]);
  });

  it("conserva todas las respuestas en orden, separadas por una línea en blanco, y el resultado de más peso gana (cotización > conversación)", () => {
    const merged = mergeProduced([reply("Cotización 1", { result: "quoted", stale: "NONE" }), reply("Hola, ¿en qué te ayudo?", { signature: "GREETING" }), reply("Cotización 2", { result: "quoted", stale: "NONE" })]);
    expect(merged.produced).toMatchObject({ kind: "reply", body: "Cotización 1\n\nHola, ¿en qué te ayudo?\n\nCotización 2", result: "quoted", stale: "NONE", signature: "GREETING" });
    expect(merged.included).toEqual([true, true, true]);
  });

  it("no repite textos idénticos pero cuenta como incluido el que se repitió", () => {
    const merged = mergeProduced([reply("misma", { result: "no_quote" }), reply("misma", { result: "no_quote" })]);
    expect(merged.produced).toMatchObject({ body: "misma" });
    expect(merged.included).toEqual([true, true]);
  });

  it("un acuse de la sesión se descarta si lo sustituye otro acuse más nuevo", () => {
    const merged = mergeProduced([reply("anoté la foto 1", { signature: "QUOTE_ADDED:1" }), reply("anoté la foto 2", { signature: "QUOTE_ADDED:2" })]);
    expect(merged.produced).toMatchObject({ body: "anoté la foto 2" });
    expect(merged.included).toEqual([false, true]);
  });

  it("un acuse de la sesión se descarta si lo sustituye una cotización", () => {
    const merged = mergeProduced([reply("anoté la foto 1", { signature: "QUOTE_ADDED:1" }), reply("la cotización", { result: "quoted", stale: "NONE" })]);
    expect(merged.produced).toMatchObject({ body: "la cotización", result: "quoted" });
    expect(merged.included).toEqual([false, true]);
  });

  it("una pregunta de aclaración NO se descarta si lo único que sigue es una respuesta de información (si no, el paciente nunca vería las opciones)", () => {
    const merged = mergeProduced([reply("¿Cuál de estas opciones?", { signature: "QUOTE_ASK:2" }), reply("Abrimos de 8 a 12", { signature: "INFO_REQUEST:HOURS" })]);
    expect(merged.produced).toMatchObject({ body: "¿Cuál de estas opciones?\n\nAbrimos de 8 a 12", result: "conversation" });
    expect(merged.included).toEqual([true, true]);
  });

  it("el aviso técnico de una foto que falló se conserva junto a la cotización de otra y marca el estado FAILED", () => {
    const merged = mergeProduced([reply(TECHNICAL_ISSUE_MESSAGE, { result: "technical_issue", processingStatus: "FAILED" }), reply("Cotización", { result: "quoted", stale: "NONE" })]);
    expect(merged.produced).toMatchObject({ kind: "reply", result: "quoted", processingStatus: "FAILED", stale: "NONE" });
    expect((merged.produced as { body: string }).body).toContain(TECHNICAL_ISSUE_MESSAGE);
    expect((merged.produced as { body: string }).body).toContain("Cotización");
  });

  it("solo avisos técnicos: el resultado sigue siendo technical_issue y puede quedar obsoleto", () => {
    const merged = mergeProduced([reply(TECHNICAL_ISSUE_MESSAGE, { result: "technical_issue", processingStatus: "FAILED" }), reply("otro aviso", { result: "technical_issue", processingStatus: "FAILED" })]);
    expect(merged.produced).toMatchObject({ result: "technical_issue", stale: "NEWER_TURN" });
  });

  it("tope de longitud de WhatsApp: se descartan primero los mensajes que no son cotización y una cotización nunca se recorta", () => {
    const quote = (n: number) => reply(`Cotización ${n} ${"x".repeat(1500)}`, { result: "quoted", stale: "NONE" });
    const merged = mergeProduced([reply("y".repeat(1200), { signature: "GREETING" }), quote(1), quote(2)]);
    const body = (merged.produced as { body: string }).body;
    expect(body.length).toBeLessThanOrEqual(3900);
    expect(body).toContain("Cotización 1");
    expect(body).toContain("Cotización 2");
    expect(merged.included).toEqual([false, true, true]);
  });
});

describe("deferClosing: el turno que responde no cierra su corrida mientras haya algo por enviar", () => {
  function fakeContext(guarded = true) {
    const calls: string[] = [];
    const ctx: TurnContext = { guarded, seq: 3, persist: vi.fn(async (stage: string) => { calls.push(stage); return guarded; }) };
    return { ctx, calls };
  }

  it("aplaza «close» e «image»; el resto se escribe de inmediato", async () => {
    const { ctx, calls } = fakeContext();
    const deferred = deferClosing(ctx);
    expect(await deferred.ctx.persist("quote_begin", async () => undefined)).toBe(true);
    expect(await deferred.ctx.persist("close", async () => undefined)).toBe(true);
    expect(await deferred.ctx.persist("image", async () => undefined)).toBe(true);
    expect(calls).toEqual(["quote_begin"]);
    expect(deferred.ctx.seq).toBe(3);
    await deferred.flush();
    expect(calls).toEqual(["quote_begin", "close", "image"]);
    await deferred.flush();
    expect(calls).toEqual(["quote_begin", "close", "image"]);
  });

  it("sin auditoría (corrida sin guarda) no aplaza nada", async () => {
    const { ctx, calls } = fakeContext(false);
    expect(await deferClosing(ctx).ctx.persist("close", async () => undefined)).toBe(false);
    expect(calls).toEqual(["close"]);
  });
});

// ───────────────────────────── processTurns con auditoría simulada ─────────────────────────────

type ClaimFn = (ref: { messageId: string }) => AuditClaim | Promise<AuditClaim>;

function fakeAudit(options: { claim?: ClaimFn; fold?: boolean } = {}) {
  const runs = new Map<string, string>();
  let n = 0;
  const repo = {
    claim: vi.fn(async (ref: { messageId: string }): Promise<AuditClaim> => {
      if (options.claim) {
        const claim = await options.claim(ref);
        if (claim.kind === "claimed") runs.set(claim.runId, ref.messageId);
        return claim;
      }
      const runId = `run-${++n}`;
      runs.set(runId, ref.messageId);
      return { kind: "claimed", runId, lease: LEASE, takeover: false };
    }),
    renewLease: vi.fn(async () => true),
    recordIgnored: vi.fn(async (_runId: string, _reason: string, _lease?: AuditLease) => undefined),
    recordEvidence: vi.fn(async (_runId: string, ..._rest: unknown[]) => undefined),
    recordFailure: vi.fn(async (_runId: string, ..._rest: unknown[]) => undefined),
    reserveSend: vi.fn(async (_runId: string, _kind: string, _lease: AuditLease, _options?: unknown): Promise<string> => "reserved"),
    confirmSend: vi.fn(async (): Promise<string> => "proceed"),
    recordReply: vi.fn(async () => undefined),
    ...(options.fold ? { foldTurn: vi.fn(async (_runId: string, _lease: AuditLease) => undefined) } : {})
  };
  const messageOf = (runId: string) => runs.get(runId);
  return { repo: repo as unknown as AuditRepository & typeof repo & { foldTurn: ReturnType<typeof vi.fn> }, messageOf };
}

function setup(options: { handlers?: TurnHandlers; analyze?: QuoteDeps["analyze"]; quote?: Partial<QuoteDeps>; claim?: ClaimFn; fold?: boolean; turns?: Partial<NonNullable<QuoteDeps["turns"]>> } = {}) {
  const { repo, messageOf } = fakeAudit({ claim: options.claim, fold: options.fold });
  const sends: string[] = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  const deps: QuoteDeps = {
    downloadImage: vi.fn(async () => ({ bytes: jpeg })),
    loadCatalog: vi.fn(async () => []),
    analyze: options.analyze ?? vi.fn(async () => quoteOf("HEMOGRAMA", 45)),
    sendText: vi.fn(async (_to: string, body: string) => { sends.push(body); return { providerMessageId: "wamid.out" }; }),
    log: (event, data) => logs.push([event, data]),
    audit: repo,
    leaseRenewIntervalMs: 3_600_000,
    turns: { contactKeyFor: () => KEY, busyRetries: 3, busyDelayMs: 1, sleep: async () => undefined, handlers: options.handlers, ...options.turns },
    ...options.quote
  };
  const logged = (name: string) => logs.filter(([event]) => event === name).map(([, data]) => data);
  // qué mensaje de qué corrida: ayuda a leer las llamadas a la auditoría
  const reservedFor = () => repo.reserveSend.mock.calls.map((call) => messageOf(call[0] as string));
  const ignoredFor = () => repo.recordIgnored.mock.calls.map((call) => [messageOf(call[0] as string), call[1]] as const);
  return { deps, audit: repo, sends, logged, messageOf, reservedFor, ignoredFor };
}

const answer = (body: string, extra: Partial<TurnReply> = {}): TurnHandlers["text"] => async () => ({ body, ...extra });

describe("processTurns: varios textos en un lote", () => {
  it("tres textos del mismo contacto = UNA solicitud: el manejador recibe el texto unido en orden, se envía UNA respuesta y hay UNA reserva", async () => {
    const seen: string[] = [];
    const t = setup({ handlers: { text: async (turn) => { seen.push(turn.text!); return { body: "respuesta única" }; } } });
    const reports = await processTurns([text("m1", "hola"), text("m2", "quiero saber el horario"), text("m3", "y la dirección")], t.deps);
    expect(seen).toEqual(["hola\nquiero saber el horario\ny la dirección"]);
    expect(t.sends).toEqual(["respuesta única"]);
    expect(t.audit.reserveSend).toHaveBeenCalledTimes(1);
    expect(t.reservedFor()).toEqual(["m3"]);
    expect(reports.map((report) => [report.messageId, report.result])).toEqual([["m1", "ignored"], ["m2", "ignored"], ["m3", "conversation"]]);
    expect(t.logged("turn_batch")).toEqual([{ phone: expect.any(String), messages: 3, claimed: 3, requests: 1, textsMerged: 2 }]);
  });

  it("DEDUPLICACIÓN: los tres mensajes se reclaman (uno por uno, en orden) y los dos absorbidos se cierran sin respuesta", async () => {
    const t = setup({ handlers: { text: answer("ok") } });
    await processTurns([text("m1", "a"), text("m2", "b"), text("m3", "c")], t.deps);
    expect(t.audit.claim.mock.calls.map((call) => (call[0] as { messageId: string }).messageId)).toEqual(["m1", "m2", "m3"]);
    expect(t.ignoredFor().sort()).toEqual([["m1", "NO_REPLY"], ["m2", "NO_REPLY"]]);
  });

  it("un mensaje duplicado (ya atendido) no se vuelve a leer ni se une al texto", async () => {
    const seen: string[] = [];
    let n = 0;
    const t = setup({
      handlers: { text: async (turn) => { seen.push(turn.text!); return { body: "ok" }; } },
      claim: (ref) => (ref.messageId === "m2" ? { kind: "duplicate", processingStatus: "COMPLETED" } as AuditClaim : { kind: "claimed", runId: `run-${++n}`, lease: LEASE, takeover: false })
    });
    const reports = await processTurns([text("m1", "uno"), text("m2", "dos (ya atendido)"), text("m3", "tres")], t.deps);
    expect(seen).toEqual(["uno\ntres"]);
    expect(t.sends).toEqual(["ok"]);
    expect(reports.find((report) => report.messageId === "m2")!.result).toBe("ignored");
  });

  it("si el ÚLTIMO mensaje no se pudo reclamar, los anteriores no se pierden: se atienden como una solicitud", async () => {
    const seen: string[] = [];
    let n = 0;
    const t = setup({
      handlers: { text: async (turn) => { seen.push(turn.text!); return { body: "ok" }; } },
      claim: (ref) => (ref.messageId === "m3" ? { kind: "duplicate", processingStatus: "PROCESSING" } as AuditClaim : { kind: "claimed", runId: `run-${++n}`, lease: LEASE, takeover: false })
    });
    await processTurns([text("m1", "uno"), text("m2", "dos"), text("m3", "tres")], t.deps);
    expect(seen).toEqual(["uno\ndos"]);
    expect(t.sends).toEqual(["ok"]);
    expect(t.reservedFor()).toEqual(["m2"]);
  });

  it("un contacto con UN solo mensaje sigue la ruta de siempre: sin cierre silencioso ni registro de lote", async () => {
    const t = setup({ handlers: { text: answer("ok") } });
    const reports = await processTurns([text("m1", "hola")], t.deps);
    expect(reports).toEqual([{ messageId: "m1", result: "conversation" }]);
    expect(t.logged("turn_batch")).toEqual([]);
    expect(t.audit.recordIgnored).not.toHaveBeenCalled();
  });

  it("contactos distintos en un mismo lote NO se mezclan: cada uno recibe su propia respuesta", async () => {
    const t = setup({ handlers: { text: async (turn) => ({ body: `para ${turn.from}: ${turn.text}` }) } });
    await processTurns([text("a1", "hola", { from: "59171000001" }), text("b1", "buenas", { from: "59171000002" }), text("a2", "quiero cotizar", { from: "59171000001" })], t.deps);
    expect(t.sends.sort()).toEqual(["para 59171000001: hola\nquiero cotizar", "para 59171000002: buenas"]);
  });
});

describe("processTurns: foto + «gracias»", () => {
  it("la cotización de la foto NO se pierde aunque el último mensaje no genere respuesta: se reserva y se envía desde la corrida que sigue abierta", async () => {
    const t = setup({ handlers: { text: async () => undefined } });
    const reports = await processTurns([image("p1"), text("m2", "gracias")], t.deps);
    expect(t.sends).toHaveLength(1);
    expect(t.sends[0]).toContain("HEMOGRAMA");
    expect(t.reservedFor()).toEqual(["m2"]);
    expect(t.audit.reserveSend).toHaveBeenCalledWith(expect.any(String), "quoted", LEASE, expect.objectContaining({ stale: "NONE" }));
    // la corrida de «gracias» NO se cerró por su cuenta (una corrida cerrada ya no admite la reserva); la de la foto sí queda cerrada sin respuesta propia
    expect(t.ignoredFor()).toEqual([["p1", "NO_REPLY"]]);
    expect(reports.map((report) => [report.messageId, report.result])).toEqual([["p1", "quoted"], ["m2", "quoted"]]);
  });

  it("en el orden contrario («gracias» y luego la foto) también sale una sola cotización", async () => {
    const t = setup({ handlers: { text: async () => undefined } });
    await processTurns([text("m1", "gracias"), image("p2")], t.deps);
    expect(t.sends).toHaveLength(1);
    expect(t.sends[0]).toContain("HEMOGRAMA");
    expect(t.reservedFor()).toEqual(["p2"]);
    expect(t.ignoredFor()).toEqual([["m1", "NO_REPLY"]]);
  });

  it("si NADIE tiene nada que enviar, el cierre aplazado se aplica: ninguna corrida queda abierta y no hay reserva ni envío", async () => {
    const t = setup({ handlers: { text: async () => undefined }, quote: { downloadImage: vi.fn(async () => ({ bytes: new Uint8Array(0) })) } });
    await processTurns([image("p1"), text("m2", "gracias")], t.deps);
    expect(t.sends).toEqual([]);
    expect(t.audit.reserveSend).not.toHaveBeenCalled();
    expect(t.ignoredFor().sort()).toEqual([["m2", "NO_REPLY"], ["p1", "IMAGE_SIZE"]]);
  });
});

describe("processTurns: cómo termina la corrida de un mensaje cuyo contenido viajó en otro (foldTurn, migración 19)", () => {
  it("con foldTurn disponible, la corrida de la foto ya analizada se da por atendida con foldTurn y NO con el cierre «sin respuesta» (que la base no admite tras el análisis)", async () => {
    const t = setup({ fold: true, handlers: { text: async () => undefined } });
    await processTurns([image("p1"), text("m2", "gracias")], t.deps);
    expect(t.sends).toHaveLength(1);
    expect(t.audit.foldTurn.mock.calls.map((call) => t.messageOf(call[0] as string))).toEqual(["p1"]);
    expect(t.ignoredFor()).toEqual([]);
  });

  it("sin foldTurn (repositorio anterior) se usa el cierre «sin respuesta», como antes", async () => {
    const t = setup({ handlers: { text: async () => undefined } });
    await processTurns([image("p1"), text("m2", "gracias")], t.deps);
    expect(t.ignoredFor()).toEqual([["p1", "NO_REPLY"]]);
  });

  it("una foto que falló conserva su registro de fallo y NO se pliega ni se cierra encima", async () => {
    const t = setup({ fold: true, analyze: vi.fn(async () => { throw new Error("boom"); }) as unknown as QuoteDeps["analyze"], handlers: { text: answer("ok") } });
    await processTurns([image("p1"), text("m2", "hola")], t.deps);
    expect(t.audit.recordFailure).toHaveBeenCalledTimes(1);
    expect(t.audit.foldTurn).not.toHaveBeenCalled();
    expect(t.sends[0]).toContain(TECHNICAL_ISSUE_MESSAGE);
  });

  it("el turno que responde y los mensajes de texto unidos no se pliegan: el primero envía y los otros se cierran sin respuesta", async () => {
    const t = setup({ fold: true, handlers: { text: answer("ok") } });
    await processTurns([text("m1", "a"), text("m2", "b")], t.deps);
    expect(t.audit.foldTurn).not.toHaveBeenCalled();
    expect(t.ignoredFor()).toEqual([["m1", "NO_REPLY"]]);
  });
});

describe("processTurns: múltiples fotografías", () => {
  it("tres fotos en un lote: cada una se analiza y se envía UN solo mensaje con las tres cotizaciones, con una sola reserva", async () => {
    const names: Record<string, [string, number]> = { A: ["HEMOGRAMA", 45], B: ["GLUCOSA", 30], C: ["TSH", 80] };
    const analyze = vi.fn(async ({ imageBase64 }: { imageBase64: string }) => {
      const tag = Buffer.from(imageBase64, "base64").toString("latin1").match(/TAG:(\w)/)?.[1] ?? "A";
      return quoteOf(...names[tag]!);
    });
    const tags = ["A", "B", "C"];
    let i = 0;
    const t = setup({ analyze: analyze as unknown as QuoteDeps["analyze"], quote: { downloadImage: vi.fn(async () => ({ bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from(`TAG:${tags[i++]}`), ...new Array(12).fill(0)]) })) } });
    const reports = await processTurns([image("p1"), image("p2"), image("p3")], t.deps);
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(t.sends).toHaveLength(1);
    for (const study of ["HEMOGRAMA", "GLUCOSA", "TSH"]) expect(t.sends[0]).toContain(study);
    expect(t.audit.reserveSend).toHaveBeenCalledTimes(1);
    expect(t.reservedFor()).toEqual(["p3"]);
    // evidencia del análisis de cada foto en SU corrida
    expect(new Set(t.audit.recordEvidence.mock.calls.map((call) => t.messageOf(call[0] as string)))).toEqual(new Set(["p1", "p2", "p3"]));
    expect(reports.every((report) => report.result === "quoted")).toBe(true);
  });

  it("dos fotos con exactamente la misma cotización la muestran una sola vez", async () => {
    const t = setup();
    await processTurns([image("p1"), image("p2")], t.deps);
    expect(t.sends).toHaveLength(1);
    expect(t.sends[0]!.match(/HEMOGRAMA/g)!.length).toBe(1);
  });

  it("si una foto falla, las demás NO se pierden: el aviso técnico viaja junto a la cotización de la otra", async () => {
    let calls = 0;
    const analyze = vi.fn(async () => { if (++calls === 1) throw new Error("boom"); return quoteOf("GLUCOSA", 30); });
    const t = setup({ analyze: analyze as unknown as QuoteDeps["analyze"] });
    await processTurns([image("p1"), image("p2")], t.deps);
    expect(t.sends).toHaveLength(1);
    expect(t.sends[0]).toContain(TECHNICAL_ISSUE_MESSAGE);
    expect(t.sends[0]).toContain("GLUCOSA");
    expect(t.audit.reserveSend).toHaveBeenCalledWith(expect.any(String), "quoted", LEASE, expect.anything());
    // la foto que falló conserva SU registro de fallo (no se pisa con un cierre «sin respuesta»)
    expect(t.audit.recordFailure).toHaveBeenCalledTimes(1);
    expect(t.ignoredFor().filter(([message]) => message === "p1")).toEqual([]);
  });

  it("si el trabajo del último turno se rompe, lo de los anteriores no se pierde", async () => {
    const t = setup({ handlers: { text: async () => { throw new Error("boom"); } } });
    // el productor de conversación atrapa el error y responde con el aviso técnico; la cotización de la foto viaja igual
    await processTurns([image("p1"), text("m2", "hola")], t.deps);
    expect(t.sends).toHaveLength(1);
    expect(t.sends[0]).toContain("HEMOGRAMA");
  });
});

describe("processTurns: el rastro de las versiones aprobadas cae en la corrida que ENVÍA", () => {
  it("la preparación clínica anexada a la cotización de una foto se registra en la corrida del último turno, no en la de la foto", async () => {
    const traced: Array<string | undefined> = [];
    const t = setup({
      handlers: { text: answer("respuesta") },
      quote: {
        quotePreparations: async (quote, _ids, _catalog, ctx) => {
          await ctx.persist("quote_preparation", async (_audit, runId) => { traced.push(runId); });
          return `${quote}\n\nPreparación aprobada`;
        }
      }
    });
    await processTurns([image("p1"), text("m2", "hola")], t.deps);
    expect(traced.map((runId) => t.messageOf(runId!))).toEqual(["m2"]);
    expect(t.sends[0]).toContain("Preparación aprobada");
  });
});

describe("processTurns: límite de respuestas y reservas denegadas", () => {
  it("un lote de varios mensajes pide UNA sola reserva (cuenta una vez para el tope de 5 cada 24 h) y la lleva con el tope configurado", async () => {
    const t = setup({ handlers: { text: answer("ok") }, turns: { dailyCap: { max: 5, windowSeconds: 86_400 } } });
    await processTurns([text("m1", "a"), image("p2"), image("p3"), text("m4", "d")], t.deps);
    expect(t.audit.reserveSend).toHaveBeenCalledTimes(1);
    expect(t.audit.reserveSend).toHaveBeenCalledWith(expect.any(String), "quoted", LEASE, expect.objectContaining({ cap: { max: 5, windowSeconds: 86_400 } }));
    expect(t.sends).toHaveLength(1);
  });

  it("tope alcanzado, pausa humana o respuesta obsoleta: no se envía NADA del lote", async () => {
    for (const denied of ["limited", "blocked", "superseded"]) {
      const t = setup({ handlers: { text: answer("ok") } });
      t.audit.reserveSend.mockResolvedValue(denied);
      const reports = await processTurns([text("m1", "a"), image("p2"), text("m3", "c")], t.deps);
      expect(t.sends, denied).toEqual([]);
      expect(reports.every((report) => report.result === "ignored"), denied).toBe(true);
    }
  });

  it("la comprobación final (pausa tras la reserva) cancela el envío del lote entero", async () => {
    const t = setup({ handlers: { text: answer("ok") } });
    t.audit.confirmSend.mockResolvedValue("paused");
    await processTurns([text("m1", "a"), image("p2")], t.deps);
    expect(t.sends).toEqual([]);
  });
});

// ───────────────────────────── el mismo lote entregado a la vez ─────────────────────────────

describe("processTurns: el MISMO lote entregado dos veces a la vez responde UNA sola vez", () => {
  // Un registro de reclamos compartido por las dos ejecuciones, con una pausa en cada reclamo para que se crucen (como la base: el primero en llegar gana y el otro ve «BUSY»).
  function sharedClaims(reason: "BUSY" | "FINISHED" = "BUSY") {
    const owners = new Map<string, string>();
    let n = 0;
    return (who: string, delays: Record<string, number> = {}) => async (ref: { messageId: string }): Promise<AuditClaim> => {
      await new Promise((resolve) => setTimeout(resolve, delays[ref.messageId] ?? 2));
      const owner = owners.get(ref.messageId);
      if (owner !== undefined) return { kind: "duplicate", processingStatus: "PROCESSING", reason } as AuditClaim;
      owners.set(ref.messageId, who);
      return { kind: "claimed", runId: `run-${who}-${++n}`, lease: LEASE, takeover: false };
    };
  }

  it("las dos ejecuciones se reparten ningún mensaje: la que gana el primero atiende todo y la otra cede el grupo del contacto", async () => {
    const claim = sharedClaims();
    const seen: string[] = [];
    const handlers: TurnHandlers = { text: async (turn) => { seen.push(turn.text!); return { body: "respuesta" }; } };
    // «A» gana el primer mensaje pero tarda en reclamar el segundo; «B» llega justo después del primero: sin exclusión, «B» se llevaría el resto y habría DOS respuestas
    const a = setup({ handlers, claim: claim("A", { m1: 1, m2: 40, m3: 1, p4: 1 }) });
    const b = setup({ handlers, claim: claim("B", { m1: 10, m2: 1, m3: 1, p4: 1 }) });
    const batch = () => [text("m1", "uno"), text("m2", "dos"), text("m3", "tres"), image("p4")];
    await Promise.all([processTurns(batch(), a.deps), processTurns(batch(), b.deps)]);
    expect(a.sends.length + b.sends.length).toBe(1);
    expect(seen).toEqual(["uno\ndos\ntres"]);
    // cada mensaje lo reclamó UNA sola ejecución, y la que cedió ni lo intentó con los siguientes
    expect(a.audit.claim).toHaveBeenCalledTimes(4);
    expect(b.audit.claim).toHaveBeenCalledTimes(1);
  });

  it("la que pierde el primer mensaje no reclama ninguno de los siguientes del mismo contacto, y lo deja registrado", async () => {
    const claim = sharedClaims();
    const a = setup({ handlers: { text: answer("ok") }, claim: claim("A") });
    const b = setup({ handlers: { text: answer("ok") }, claim: claim("B") });
    await claim("A")({ messageId: "m1" });
    const reports = await processTurns([text("m1", "uno"), text("m2", "dos"), text("m3", "tres")], b.deps);
    expect(b.audit.claim).toHaveBeenCalledTimes(1);
    expect(b.sends).toEqual([]);
    expect(reports.map((report) => report.result)).toEqual(["ignored", "ignored", "ignored"]);
    expect(b.logged("turn_batch_yield")).toEqual([{ phone: expect.any(String), skipped: 2 }]);
    expect(a.sends).toEqual([]);
  });

  it("un mensaje ya TERMINADO (FINISHED) no cede el grupo: los nuevos del mismo lote se siguen atendiendo", async () => {
    const claim = sharedClaims("FINISHED");
    const seen: string[] = [];
    const t = setup({ handlers: { text: async (turn) => { seen.push(turn.text!); return { body: "ok" }; } }, claim: claim("B") });
    await claim("A")({ messageId: "m1" });
    await processTurns([text("m1", "viejo"), text("m2", "nuevo uno"), text("m3", "nuevo dos")], t.deps);
    expect(seen).toEqual(["nuevo uno\nnuevo dos"]);
    expect(t.sends).toEqual(["ok"]);
  });

  it("otro contacto del mismo POST no se ve afectado por la cesión de un contacto", async () => {
    const claim = sharedClaims();
    const t = setup({ handlers: { text: async (turn) => ({ body: `para ${turn.from}` }) }, claim: claim("B") });
    await claim("A")({ messageId: "a1" });
    await processTurns([text("a1", "x", { from: "59171000001" }), text("a2", "y", { from: "59171000001" }), text("b1", "z", { from: "59171000002" })], t.deps);
    expect(t.sends).toEqual(["para 59171000002"]);
  });
});
