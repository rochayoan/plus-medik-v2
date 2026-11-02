import { describe, expect, it, vi } from "vitest";
import type { AnalysisResult } from "../src/analyze.js";
import type { AuditClaim, AuditLease, AuditRepository } from "../src/audit.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { QUOTE_TEXTS, type QuoteBeginResult, type QuoteReadResult, type SessionItem } from "../src/quote-session.js";
import { itemFromAnalysis, resolveQuoteSessionsConfig } from "../src/quote-session-turns.js";
import { processTurns, type IncomingTurn } from "../src/turns.js";
import { createTextHandler, DRAFT_TEXTS } from "../src/text-handler.js";
import { TECHNICAL_ISSUE_MESSAGE, type QuoteDeps } from "../src/whatsapp-quote.js";
import type { CatalogStudy } from "../src/types.js";

// Producto de los turnos en modo sesión SIN base de datos (repositorio simulado): ramas de error, repetidos, esperas y fallas cerradas. La garantía real contra PostgreSQL está en
// tests/quote-session-db.test.ts y de extremo a extremo en tests/quote-session-e2e.test.ts.

const LEASE: AuditLease = { owner: "owner-0000001", fence: 1 };
const KEY = "a".repeat(64);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const study = (n: number, name: string, aliases: string[], priceBs: number): CatalogStudy => ({ id: uuid(n), code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active: true });
const CATALOG = [study(1, "HEMOGRAMA COMPLETO", ["hemograma"], 45), study(2, "GLUCOSA EN AYUNAS", ["glucosa"], 30)];
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]);
const log = () => undefined;
// El repositorio simulado: los métodos de AuditRepository, pero como espías de vitest.
type Mocked = { [K in 'claim' | 'renewLease' | 'recordIgnored' | 'recordEvidence' | 'recordFailure' | 'reserveSend' | 'confirmSend' | 'recordReply' | 'releaseTurn' | 'quoteBegin' | 'quoteFinish' | 'quoteRead' | 'quoteClose']: ReturnType<typeof vi.fn> };

function fakeAudit(parts: { begin?: () => Promise<QuoteBeginResult>; read?: () => Promise<QuoteReadResult>; noQuoteMethods?: boolean } = {}) {
  let n = 0;
  const repo = {
    claim: vi.fn(async (): Promise<AuditClaim> => ({ kind: "claimed", runId: `run-${++n}`, lease: LEASE, takeover: false })),
    renewLease: vi.fn(async () => true), recordIgnored: vi.fn(async () => undefined), recordEvidence: vi.fn(async () => undefined), recordFailure: vi.fn(async () => undefined),
    reserveSend: vi.fn(async (): Promise<string> => "reserved"), confirmSend: vi.fn(async (): Promise<string> => "proceed"), recordReply: vi.fn(async () => undefined), releaseTurn: vi.fn(async () => undefined),
    ...(parts.noQuoteMethods ? {} : {
      quoteBegin: vi.fn(parts.begin ?? (async (): Promise<QuoteBeginResult> => ({ status: "created", itemId: "i1", sessionId: "s1", itemStatus: "PROCESSING", position: 1, studyIds: [], unresolved: 0, ambiguousGroups: 0 }))),
      quoteFinish: vi.fn(async () => undefined),
      quoteRead: vi.fn(parts.read ?? (async (): Promise<QuoteReadResult> => ({ state: "none" }))),
      quoteClose: vi.fn(async () => ({ status: "closed" as const, outcome: "QUOTED" }))
    })
  };
  return repo as unknown as AuditRepository & Mocked;
}

function setup(options: { audit?: ReturnType<typeof fakeAudit>; bytes?: Uint8Array; analysis?: AnalysisResult; catalogFails?: boolean; catalog?: CatalogStudy[]; sleeps?: number[] } = {}) {
  const audit = options.audit ?? fakeAudit();
  const sends: string[] = [];
  const sleeps = options.sleeps ?? [];
  const analyze = vi.fn(async () => options.analysis ?? ({ decision: "AUTO_SAFE", outcome: "AUTO_COMPLETE", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], publicQuote: { studies: [], totalBs: 0, totalLabel: "", tariff: "PACIENTE" }, internal: { quoted: { lines: [{ id: uuid(1) }] }, studies: [], pending: [], advisories: [], document: { zones: [] } } } as unknown as AnalysisResult));
  const deps: QuoteDeps = {
    downloadImage: vi.fn(async () => ({ bytes: options.bytes ?? jpeg })),
    loadCatalog: vi.fn(async () => { if (options.catalogFails) throw new Error("catálogo caído"); return structuredClone(options.catalog ?? CATALOG); }),
    analyze, sendText: vi.fn(async (_to: string, body: string) => { sends.push(body); return { providerMessageId: "wamid.out" }; }), log, audit, leaseRenewIntervalMs: 3_600_000,
    turns: { contactKeyFor: () => KEY, busyRetries: 1, busyDelayMs: 1, sleep: async () => undefined, handlers: { text: createTextHandler({ log }) }, quoteSessions: resolveQuoteSessionsConfig({ waitRetries: 3, waitDelayMs: 7, sleep: async (ms) => { sleeps.push(ms); } }) }
  };
  return { deps, audit, sends, analyze, sleeps };
}
const image = (id = "m1"): IncomingTurn => ({ messageId: id, from: "59170000000", kind: "IMAGE", mediaId: "media" });
const text = (body: string, id = "t1"): IncomingTurn => ({ messageId: id, from: "59170000000", kind: "TEXT", text: body });

describe("itemFromAnalysis: lo que el motor decidió, traducido a la sesión", () => {
  const analysis = (over: Record<string, unknown>) => ({ decision: "HUMAN_REVIEW", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], ...over }) as unknown as AnalysisResult;
  const lines = (...ids: number[]) => ({ quoted: { lines: ids.map((n) => ({ id: uuid(n) })) } });

  it("cotizada COMPLETA → identificada (sin repetidos)", () => {
    expect(itemFromAnalysis(analysis({ outcome: "AUTO_COMPLETE", publicQuote: {}, internal: lines(1, 2, 1) }))).toEqual({ status: "RESOLVED", studyIds: [uuid(1), uuid(2)], ambiguous: [], unresolved: 0, reasons: [] });
  });
  it("sin la bandera de AUTO parcial (sin outcome): AUTO_SAFE con cotización → identificada", () => {
    expect(itemFromAnalysis(analysis({ decision: "AUTO_SAFE", quote: { lines: [{ id: uuid(3) }] } }))).toMatchObject({ status: "RESOLVED", studyIds: [uuid(3)] });
  });
  it("parcial → incierta (la sesión no cotiza sobre dudas)", () => {
    expect(itemFromAnalysis(analysis({ outcome: "AUTO_PARTIAL", publicQuote: {}, internal: lines(1) }))).toMatchObject({ status: "UNCERTAIN", studyIds: [uuid(1)], reasons: ["ENGINE_PARTIAL"] });
  });
  it.each([
    ["revisión humana", { outcome: "HUMAN_REVIEW", internal: lines(1) }],
    ["sin cotización", { outcome: "AUTO_COMPLETE", internal: lines() }],
    ["completa pero sin estudios", { outcome: "AUTO_COMPLETE", publicQuote: {}, internal: lines() }],
    ["sin nada", {}]
  ])("%s → ilegible (se pide otra foto)", (_name, over) => {
    expect(itemFromAnalysis(analysis(over))).toMatchObject({ status: "UNREADABLE", studyIds: [], reasons: ["UNREADABLE_IMAGE"] });
  });
});

describe("foto en modo sesión", () => {
  it("demasiado grande o vacía: la sesión lo sabe (ilegible), el turno se cierra sin respuesta como siempre y no se analiza", async () => {
    const w = setup({ bytes: new Uint8Array(0) });
    const reports = await processTurns([image()], w.deps);
    expect(reports[0]!.result).toBe("ignored");
    expect(w.audit.quoteBegin).toHaveBeenCalledWith("run-1", LEASE, expect.objectContaining({ kind: "IMAGE", result: expect.objectContaining({ status: "UNREADABLE", reasons: ["UNSUPPORTED_IMAGE"] }) }));
    expect(w.audit.recordIgnored).toHaveBeenCalledWith("run-1", "IMAGE_SIZE", LEASE);
    expect(w.analyze).not.toHaveBeenCalled();
    expect(w.sends).toEqual([]);
  });

  it("formato no soportado: se registra como ilegible y se avisa que se reenvíe como foto", async () => {
    const w = setup({ bytes: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) });
    await processTurns([image()], w.deps);
    expect(w.audit.recordIgnored).toHaveBeenCalledWith("run-1", "IMAGE_TYPE", LEASE);
    expect(w.sends).toEqual([QUOTE_TEXTS.unreadable_image]);
    expect(w.analyze).not.toHaveBeenCalled();
  });

  it("sesión llena: se avisa y no se analiza", async () => {
    const w = setup({ audit: fakeAudit({ begin: async () => ({ status: "full", sessionId: "s1", count: 20 }) }) });
    await processTurns([image()], w.deps);
    expect(w.sends).toEqual([QUOTE_TEXTS.full]);
    expect(w.analyze).not.toHaveBeenCalled();
  });

  it("foto repetida: se avisa y NO se gasta un análisis", async () => {
    const w = setup({ audit: fakeAudit({ begin: async () => ({ status: "duplicate", itemId: "i", sessionId: "s", itemStatus: "DUPLICATE", position: 1, studyIds: [], unresolved: 0, ambiguousGroups: 0 }) }) });
    await processTurns([image()], w.deps);
    expect(w.sends).toEqual([QUOTE_TEXTS.duplicate_image]);
    expect(w.analyze).not.toHaveBeenCalled();
  });

  it("una ejecución que reclama el lease de otra que ya terminó el análisis de ESA foto no vuelve a analizarla", async () => {
    const w = setup({ audit: fakeAudit({ begin: async () => ({ status: "exists", itemId: "i", sessionId: "s", itemStatus: "RESOLVED", position: 2, studyIds: [uuid(2)], unresolved: 0, ambiguousGroups: 0 }) }) });
    await processTurns([image()], w.deps);
    expect(w.analyze).not.toHaveBeenCalled();
    expect(w.sends[0]).toContain("Estudios identificados: GLUCOSA EN AYUNAS.");
    expect(w.audit.quoteFinish).not.toHaveBeenCalled();
  });

  it("flujo normal: analiza con el motor, registra la evidencia, completa el ítem y confirma SIN precios", async () => {
    const w = setup();
    await processTurns([image()], w.deps);
    expect(w.analyze).toHaveBeenCalledTimes(1);
    expect(w.audit.recordEvidence).toHaveBeenCalled();
    expect(w.audit.quoteFinish).toHaveBeenCalledWith("run-1", LEASE, expect.objectContaining({ status: "RESOLVED", studyIds: [uuid(1)] }));
    expect(w.sends).toHaveLength(1);
    expect(w.sends[0]).toContain("HEMOGRAMA COMPLETO");
    expect(w.sends[0]).not.toMatch(/Bs\s?\d/);
    expect(w.audit.reserveSend).toHaveBeenCalledWith("run-1", "conversation", LEASE, { stale: "NEWER_TURN" });
  });

  it("si el análisis falla: aviso técnico, la foto queda ilegible en la sesión y el fallo se audita", async () => {
    const w = setup();
    w.analyze.mockRejectedValueOnce(new Error("modelo caído"));
    await processTurns([image()], w.deps);
    expect(w.sends).toEqual([TECHNICAL_ISSUE_MESSAGE]);
    expect(w.audit.quoteFinish).toHaveBeenCalledWith("run-1", LEASE, expect.objectContaining({ status: "UNREADABLE" }));
    expect(w.audit.recordFailure).toHaveBeenCalled();
  });

  it("FALLA CERRADO: un repositorio sin las operaciones de sesión (migración 11 ausente) no anota ni cotiza nada: aviso técnico", async () => {
    const w = setup({ audit: fakeAudit({ noQuoteMethods: true }) });
    await processTurns([image()], w.deps);
    expect(w.sends).toEqual([TECHNICAL_ISSUE_MESSAGE]);
    expect(w.analyze).not.toHaveBeenCalled();
  });

  it("FALLA CERRADO: si la base rechaza anotar la foto, no se analiza ni se confirma como anotada", async () => {
    const w = setup({ audit: fakeAudit({ begin: async () => { throw new Error("caída"); } }) });
    await processTurns([image()], w.deps);
    expect(w.sends).toEqual([TECHNICAL_ISSUE_MESSAGE]);
    expect(w.analyze).not.toHaveBeenCalled();
  });
});

describe("texto en modo sesión", () => {
  it("«listo» con turnos anteriores aún en proceso espera (acotado) y, si no terminan, pide repetir «listo» sin cotizar", async () => {
    const w = setup({ audit: fakeAudit({ read: async () => ({ state: "pending", pending: 1 }) }) });
    await processTurns([text("listo")], w.deps);
    expect(w.audit.quoteRead).toHaveBeenCalledTimes(4);
    expect(w.sleeps).toEqual([7, 7, 7]);
    expect(w.sends).toEqual([QUOTE_TEXTS.waiting]);
    expect(w.audit.quoteClose).not.toHaveBeenCalled();
  });

  it("«listo» sin solicitud abierta: se explica, no se cierra nada", async () => {
    const w = setup();
    await processTurns([text("listo")], w.deps);
    expect(w.sends).toEqual([QUOTE_TEXTS.empty]);
    expect(w.audit.quoteClose).not.toHaveBeenCalled();
  });

  it("si el cierre devuelve 'pending' (llegó otro turno anterior en el último instante) no se cotiza: espera", async () => {
    const w = setup({ audit: fakeAudit({ read: async () => ({ state: "ready", sessionId: "s1", items: [{ id: "i1", seq: 1, kind: "TEXT", status: "RESOLVED", studyIds: [uuid(1)], ambiguous: [], unresolved: 0, reasons: [] }] }) }) });
    w.audit.quoteClose.mockResolvedValueOnce({ status: "pending" });
    await processTurns([text("listo")], w.deps);
    expect(w.sends).toEqual([QUOTE_TEXTS.waiting]);
  });

  it("un repetido de cierre (replay) vuelve a dar EXACTAMENTE la misma cotización guardada, sin recalcular precios", async () => {
    const lines = [{ studyId: uuid(1), name: "HEMOGRAMA COMPLETO", priceBs: 45 }];
    const w = setup({ audit: fakeAudit({ read: async () => ({ state: "replay", sessionId: "s1", outcome: "QUOTED", reasons: [], lines, totalBs: 45 }) }) });
    await processTurns([text("listo")], w.deps);
    expect(w.sends[0]).toContain("HEMOGRAMA COMPLETO — Bs 45");
    expect(w.deps.loadCatalog).not.toHaveBeenCalled();
    expect(w.audit.reserveSend).toHaveBeenCalledWith("run-1", "quoted", LEASE, { stale: "NONE" });
  });

  it("sin catálogo para identificar estudios escritos, el mensaje se trata como cualquier otro texto (no se pierde ni se inventa)", async () => {
    const w = setup({ catalogFails: true });
    await processTurns([text("hemograma")], w.deps);
    expect(w.sends).toEqual([DRAFT_TEXTS.fallback]);
    expect(w.audit.quoteBegin).not.toHaveBeenCalled();
  });

  it("un texto sin estudios (saludo, información) lo atiende el manejador de siempre sin tocar la sesión", async () => {
    const w = setup();
    await processTurns([text("hola", "t1"), text("¿a qué hora abren?", "t2")], w.deps);
    // mismo lote: cada mensaje conserva su camino, pero el saludo genérico (que solo pide estudios o la receta) se omite cuando el lote trae algo más concreto; la respuesta a la pregunta se conserva
    expect(w.sends).toEqual([DRAFT_TEXTS.handoff_unavailable]);
    expect(w.audit.quoteBegin).not.toHaveBeenCalled();
  });

  it("una confirmación lleva una firma distinta por mensaje (no dispara la detección de repetición)", async () => {
    const w = setup({ audit: fakeAudit({ begin: async () => ({ status: "created", itemId: "i", sessionId: "s", itemStatus: "RESOLVED", position: 3, studyIds: [uuid(1)], unresolved: 0, ambiguousGroups: 0 }) }) });
    w.deps.turns!.replyGuard = { rules: [{ windowSeconds: 600, max: 8 }], burst: { windowSeconds: 60, max: 8 }, repeat: { windowSeconds: 900, max: 3 }, cooldownSeconds: 900 };
    await processTurns([text("hemograma")], w.deps);
    expect(w.audit.reserveSend).toHaveBeenCalledWith("run-1", "conversation", LEASE, expect.objectContaining({ guard: expect.objectContaining({ signature: "QUOTE_ADDED:3" }) }));
  });
});

describe("sin manejador de texto las sesiones NO se usan (nadie podría escribir «listo»)", () => {
  it("la foto se cotiza al instante, como siempre, y no se toca la sesión", async () => {
    const w = setup();
    delete w.deps.turns!.handlers;
    const reports = await processTurns([image()], w.deps);
    expect(reports[0]!.result).toBe("quoted");
    expect(w.sends).toHaveLength(1);
    expect(w.audit.quoteBegin).not.toHaveBeenCalled();
    expect(w.audit.reserveSend).toHaveBeenCalledWith("run-1", "quoted", LEASE, { stale: "NONE" });
  });
});

describe("fotografía inmediata opt-in: conserva textos y elimina LISTO", () => {
  const pricedAnalysis = (partial = false) => ({
    decision: "AUTO_SAFE", outcome: partial ? "AUTO_PARTIAL" : "AUTO_COMPLETE",
    reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [],
    publicQuote: {
      studies: [
        { name: "HEMOGRAMA COMPLETO", priceBs: 45 },
        { name: "GLUCOSA EN AYUNAS", priceBs: 30 }
      ],
      totalBs: 75, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE"
    },
    internal: {
      quoted: { lines: [
        { id: uuid(1), name: "HEMOGRAMA COMPLETO", priceBs: 45 },
        { id: uuid(2), name: "GLUCOSA EN AYUNAS", priceBs: 30 }
      ] },
      studies: [], pending: [], advisories: [], document: { zones: [] }
    }
  } as unknown as AnalysisResult);

  it("cotiza cada foto de inmediato con ambos precios, total, rastro clínico y sin pedir confirmación", async () => {
    const w = setup({ analysis: pricedAnalysis() });
    w.deps.turns!.instantPhotoQuotes = true;
    const appendix = vi.fn(async (body: string) => body + "\n\n🧪 *PREPARACIÓN Y AYUNO*\n• Indicaciones aprobadas.");
    w.deps.quotePreparations = appendix;
    const reports = await processTurns([image("instant-1")], w.deps);
    expect(reports[0]?.result).toBe("quoted");
    expect(w.sends).toHaveLength(1);
    expect(w.sends[0]).toContain("HEMOGRAMA COMPLETO — Bs 45");
    expect(w.sends[0]).toContain("GLUCOSA EN AYUNAS — Bs 30");
    expect(w.sends[0]).toContain("Bs 75");
    expect(w.sends[0]).toContain("PREPARACIÓN Y AYUNO");
    expect(w.sends[0]).not.toMatch(/LISTO|Cuando termines|Puedes enviar|Respóndenos|[?]/i);
    expect(appendix).toHaveBeenCalledTimes(1);
    expect(w.audit.quoteBegin).not.toHaveBeenCalled();
    expect(w.audit.quoteFinish).not.toHaveBeenCalled();
    expect(w.audit.reserveSend).toHaveBeenCalledWith("run-1", "quoted", LEASE, { stale: "NONE" });
  });

  it("aunque haya estudios dudosos, muestra solo lo cotizado sin solicitar nada al paciente", async () => {
    const w = setup({ analysis: pricedAnalysis(true) });
    w.deps.turns!.instantPhotoQuotes = true;
    await processTurns([image("partial-1")], w.deps);
    expect(w.sends[0]).toContain("Cotización parcial");
    expect(w.sends[0]).toContain("Bs 75");
    expect(w.sends[0]).not.toMatch(/envía otra foto|consulta directamente|LISTO|Respóndenos|[?]/i);
    expect(w.audit.quoteBegin).not.toHaveBeenCalled();
  });

  it("no altera las cotizaciones por estudios ESCRITOS ni las sesiones de texto", async () => {
    const w = setup();
    w.deps.turns!.instantPhotoQuotes = true;
    await processTurns([text("hemograma", "text-after-instant")], w.deps);
    expect(w.audit.quoteBegin).toHaveBeenCalled();
  });
});

describe("G5.9 · texto en modo sesión: cotizar sin «listo», acumular y preguntar", () => {
  const CATALOG2 = [...CATALOG, study(7, "CREATININA SERICA", ["creatinina"], 20), study(8, "CREATININA EN ORINA", ["creatinina"], 22)];
  const itemOf = (seq: number, over: Partial<SessionItem> = {}): SessionItem => ({ id: `i${seq}`, seq, kind: "TEXT", status: "RESOLVED", studyIds: [], ambiguous: [], unresolved: 0, reasons: [], ...over });
  const ready = (...items: Array<SessionItem>) => async (): Promise<QuoteReadResult> => ({ state: "ready", sessionId: "s1", items });
  const here = (n: number, status: "created" | "exists" = "created", over: Partial<Extract<QuoteBeginResult, { position: number }>> = {}): (() => Promise<QuoteBeginResult>) => async () =>
    ({ status, itemId: `i${n}`, sessionId: "s1", itemStatus: "RESOLVED", position: n, studyIds: [], unresolved: 0, ambiguousGroups: 0, ...over });
  const start = (audit: ReturnType<typeof fakeAudit>) => setup({ audit, catalog: CATALOG2 });

  it("una lista CLARA con un pedido de cotizar se cotiza en el mismo turno, con el catálogo recargado y sin pedir «listo»", async () => {
    const audit = fakeAudit({ begin: here(1), read: ready(itemOf(1, { studyIds: [uuid(1), uuid(2)] })) });
    const w = start(audit);
    await processTurns([text("Hola, cotízame hemograma y glucosa por favor")], w.deps);
    expect(audit.quoteBegin).toHaveBeenCalledWith("run-1", LEASE, expect.objectContaining({ kind: "TEXT", result: expect.objectContaining({ status: "RESOLVED", studyIds: [uuid(1), uuid(2)] }) }));
    expect(audit.quoteClose).toHaveBeenCalledWith("run-1", LEASE, expect.objectContaining({ outcome: "QUOTED", totalBs: 75, lines: [expect.objectContaining({ name: "HEMOGRAMA COMPLETO", priceBs: 45 }), expect.objectContaining({ name: "GLUCOSA EN AYUNAS", priceBs: 30 })] }));
    expect(w.sends).toHaveLength(1);
    expect(w.sends[0]).toContain("HEMOGRAMA COMPLETO — Bs 45");
    expect(w.sends[0]).toContain("Total de los estudios cotizados: Bs 75");
    expect(w.sends[0]).not.toContain("LISTO");
    // el catálogo del cierre es una recarga (una para identificar el texto y otra para cotizar)
    expect(w.deps.loadCatalog).toHaveBeenCalledTimes(2);
    expect(audit.reserveSend).toHaveBeenCalledWith("run-1", "quoted", LEASE, { stale: "NONE" });
  });

  it("lo que la solicitud ya tenía acumulado (fotos y mensajes anteriores) se cotiza junto con la lista", async () => {
    const audit = fakeAudit({ begin: here(3), read: ready(itemOf(1, { kind: "IMAGE", studyIds: [uuid(1)] }), itemOf(2, { studyIds: [uuid(7)] }), itemOf(3, { studyIds: [uuid(2)] })) });
    const w = start(audit);
    await processTurns([text("cuánto cuesta la glucosa")], w.deps);
    expect(audit.quoteClose).toHaveBeenCalledWith("run-1", LEASE, expect.objectContaining({ outcome: "QUOTED", totalBs: 95 }));
    expect(w.sends[0]).toContain("CREATININA SERICA — Bs 20");
  });

  it("una lista clara SIN pedido de cotizar se acumula y se pregunta si eso es todo; no se cierra ni se da precio", async () => {
    const audit = fakeAudit({ begin: here(1), read: ready(itemOf(1, { studyIds: [uuid(1), uuid(2)] })) });
    const w = start(audit);
    await processTurns([text("hemograma, glucosa")], w.deps);
    expect(audit.quoteClose).not.toHaveBeenCalled();
    expect(w.sends).toEqual(["Anoté lo que escribiste.\nEstudios anotados: HEMOGRAMA COMPLETO, GLUCOSA EN AYUNAS.\n" + QUOTE_TEXTS.confirm_done]);
    expect(audit.reserveSend).toHaveBeenCalledWith("run-1", "conversation", LEASE, { stale: "NEWER_TURN" });
  });

  it("varios mensajes se acumulan: la respuesta lista TODO lo anotado, también lo de fotos", async () => {
    const audit = fakeAudit({ begin: here(3), read: ready(itemOf(1, { kind: "IMAGE", studyIds: [uuid(1)] }), itemOf(2, { studyIds: [uuid(7)] }), itemOf(3, { studyIds: [uuid(2)] })) });
    const w = start(audit);
    await processTurns([text("y también glucosa")], w.deps);
    expect(w.sends[0]).toContain("Estudios anotados: HEMOGRAMA COMPLETO, CREATININA SERICA, GLUCOSA EN AYUNAS.");
    expect(w.sends[0]).toContain(QUOTE_TEXTS.confirm_done);
    expect(audit.quoteClose).not.toHaveBeenCalled();
  });

  it("un nombre ambiguo se PREGUNTA con las opciones del catálogo, aunque pida cotizar: no se cotiza ni se deriva", async () => {
    const audit = fakeAudit({ begin: here(1), read: ready(itemOf(1, { status: "AMBIGUOUS", studyIds: [uuid(1)], ambiguous: [[uuid(7), uuid(8)]], reasons: ["AMBIGUOUS_STUDY"] })) });
    const w = start(audit);
    await processTurns([text("cotiza hemograma y creatinina")], w.deps);
    expect(audit.quoteClose).not.toHaveBeenCalled();
    expect(w.sends[0]).toContain("Estudios anotados: HEMOGRAMA COMPLETO.");
    expect(w.sends[0]).toContain("1. CREATININA SERICA\n2. CREATININA EN ORINA");
    expect(w.sends[0]).toContain(QUOTE_TEXTS.ask_option_outro);
    expect(w.sends[0]).not.toMatch(/Bs\s?\d/);
  });

  it("lo que no se pudo identificar se pregunta (nombre exacto o foto), no se cotiza a medias y no se promete a nadie", async () => {
    const audit = fakeAudit({ begin: here(1), read: ready(itemOf(1, { status: "UNRESOLVED", studyIds: [uuid(1)], unresolved: 1, reasons: ["UNRESOLVED_TEXT"] })) });
    const w = start(audit);
    await processTurns([text("cotiza hemograma y examen de la vista")], w.deps);
    expect(audit.quoteClose).not.toHaveBeenCalled();
    expect(w.sends[0]).toContain(QUOTE_TEXTS.ask_unresolved);
    expect(w.sends[0]).not.toMatch(/persona|equipo|asesor|Bs\s?\d/i);
  });

  it("un mensaje con estudios y sin lectura posible (turnos anteriores aún en proceso) se responde con lo suyo, sin esperar", async () => {
    const audit = fakeAudit({ begin: here(2), read: async () => ({ state: "pending", pending: 1 }) });
    const w = start(audit);
    await processTurns([text("glucosa")], w.deps);
    expect(audit.quoteRead).toHaveBeenCalledTimes(1);
    expect(w.sleeps).toEqual([]);
    expect(w.sends).toEqual(["Anoté lo que escribiste.\nEstudios anotados: GLUCOSA EN AYUNAS.\n" + QUOTE_TEXTS.confirm_done]);
  });

  it("«sí» con una solicitud abierta la cierra y cotiza; sin solicitud abierta es un mensaje cualquiera", async () => {
    const audit = fakeAudit({ read: ready(itemOf(1, { studyIds: [uuid(1)] })) });
    const w = start(audit);
    await processTurns([text("sí")], w.deps);
    expect(audit.quoteClose).toHaveBeenCalledWith("run-1", LEASE, expect.objectContaining({ outcome: "QUOTED", totalBs: 45 }));
    expect(w.sends[0]).toContain("HEMOGRAMA COMPLETO — Bs 45");

    const none = start(fakeAudit());
    await processTurns([text("sí")], none.deps);
    expect(none.audit.quoteClose).not.toHaveBeenCalled();
    expect(none.sends).toEqual([DRAFT_TEXTS.fallback]);
  });

  it("«sí» con una duda sin aclarar NO manda nada a revisión: vuelve a preguntar", async () => {
    const audit = fakeAudit({ read: ready(itemOf(1, { status: "AMBIGUOUS", ambiguous: [[uuid(7), uuid(8)]], reasons: ["AMBIGUOUS_STUDY"] })) });
    const w = start(audit);
    await processTurns([text("sí")], w.deps);
    expect(audit.quoteClose).not.toHaveBeenCalled();
    expect(w.sends[0]).toContain("1. CREATININA SERICA\n2. CREATININA EN ORINA");
    expect(audit.reserveSend).toHaveBeenCalledWith("run-1", "conversation", LEASE, { stale: "NEWER_TURN" });
  });

  it("«sí» cuando un estudio ya no está en el catálogo (algo que el paciente no puede arreglar escribiendo) sí cierra como revisión", async () => {
    const audit = fakeAudit({ read: ready(itemOf(1, { studyIds: [uuid(99)] })) });
    const w = start(audit);
    await processTurns([text("sí")], w.deps);
    expect(audit.quoteClose).toHaveBeenCalledWith("run-1", LEASE, { sessionId: "s1", outcome: "NEEDS_REVIEW", reasons: ["STUDY_UNAVAILABLE"] });
    expect(w.sends).toEqual([QUOTE_TEXTS.review]);
  });

  it("«no» con una solicitud abierta pide lo que falte y no cierra nada", async () => {
    const audit = fakeAudit({ read: ready(itemOf(1, { studyIds: [uuid(1)] })) });
    const w = start(audit);
    await processTurns([text("todavía no")], w.deps);
    expect(audit.quoteClose).not.toHaveBeenCalled();
    expect(w.sends).toEqual([QUOTE_TEXTS.not_done]);
  });

  it("el número de una opción aclara la duda: entra como un estudio identificado y se confirma lo anotado", async () => {
    const audit = fakeAudit({
      begin: here(2),
      read: ready(itemOf(1, { status: "AMBIGUOUS", studyIds: [uuid(1)], ambiguous: [[uuid(7), uuid(8)]], reasons: ["AMBIGUOUS_STUDY"] }), itemOf(2, { studyIds: [uuid(8)] }))
    });
    // la primera lectura (antes de agregar la respuesta) tiene solo la pregunta pendiente
    audit.quoteRead.mockResolvedValueOnce({ state: "ready", sessionId: "s1", items: [itemOf(1, { status: "AMBIGUOUS", studyIds: [uuid(1)], ambiguous: [[uuid(7), uuid(8)]], reasons: ["AMBIGUOUS_STUDY"] })] });
    const w = start(audit);
    await processTurns([text("2")], w.deps);
    expect(audit.quoteBegin).toHaveBeenCalledWith("run-1", LEASE, expect.objectContaining({ kind: "TEXT", result: { status: "RESOLVED", studyIds: [uuid(8)], ambiguous: [], unresolved: 0, reasons: [] } }));
    expect(w.sends[0]).toContain("Estudios anotados: HEMOGRAMA COMPLETO, CREATININA EN ORINA.");
    expect(w.sends[0]).toContain(QUOTE_TEXTS.confirm_done);
    expect(audit.quoteClose).not.toHaveBeenCalled();
  });

  it("un número fuera de las opciones, o sin ninguna duda abierta, no inventa nada", async () => {
    const out = start(fakeAudit({ read: ready(itemOf(1, { status: "AMBIGUOUS", ambiguous: [[uuid(7), uuid(8)]], reasons: ["AMBIGUOUS_STUDY"] })) }));
    await processTurns([text("5")], out.deps);
    expect(out.audit.quoteBegin).not.toHaveBeenCalled();
    expect(out.sends).toEqual([QUOTE_TEXTS.choose_invalid]);
    const none = start(fakeAudit({ read: ready(itemOf(1, { studyIds: [uuid(1)] })) }));
    await processTurns([text("2")], none.deps);
    expect(none.audit.quoteBegin).not.toHaveBeenCalled();
    expect(none.sends).toEqual([DRAFT_TEXTS.fallback]);
  });

  it("pedir el precio sin estudios nuevos («¿cuánto es en total?») cotiza lo anotado; sin solicitud abierta lo atiende el manejador de siempre", async () => {
    const open = start(fakeAudit({ read: ready(itemOf(1, { studyIds: [uuid(1)] })) }));
    await processTurns([text("¿cuánto es en total?")], open.deps);
    expect(open.audit.quoteClose).toHaveBeenCalledWith("run-1", LEASE, expect.objectContaining({ outcome: "QUOTED", totalBs: 45 }));
    const none = start(fakeAudit());
    await processTurns([text("¿cuánto es en total?")], none.deps);
    expect(none.audit.quoteClose).not.toHaveBeenCalled();
    expect(none.sends).toEqual([DRAFT_TEXTS.send_recipe]);
  });

  it("una pregunta general que nombra un estudio no es una lista: la atiende el manejador (y el prompt de conversación) sin tocar la sesión", async () => {
    const w = start(fakeAudit());
    await processTurns([text("¿qué es el hemograma?", "t1"), text("¿para qué sirve la glucosa?", "t2")], w.deps);
    expect(w.audit.quoteBegin).not.toHaveBeenCalled();
    // las dos preguntas reciben el mismo texto de siempre: en el lote sale una sola vez
    expect(w.sends).toEqual([DRAFT_TEXTS.fallback]);
  });

  it("los precios, requisitos clínicos y derivaciones conservan su camino: preparación y plazos no entran a la sesión", async () => {
    const w = start(fakeAudit());
    await processTurns([text("¿necesito ayuno para el hemograma?", "t1"), text("¿cuánto demora el resultado de la glucosa?", "t2"), text("quiero hablar con una persona", "t3")], w.deps);
    expect(w.audit.quoteBegin).not.toHaveBeenCalled();
    // las tres reciben el mismo texto de siempre (ninguna entra a la sesión): en el lote sale una sola vez
    expect(w.sends).toEqual([DRAFT_TEXTS.handoff_unavailable]);
  });

  it("una solicitud que ya está llena avisa en vez de cotizar a medias", async () => {
    const w = start(fakeAudit({ begin: async () => ({ status: "full", sessionId: "s1", count: 20 }) }));
    await processTurns([text("cotiza hemograma")], w.deps);
    expect(w.sends).toEqual([QUOTE_TEXTS.full]);
    expect(w.audit.quoteClose).not.toHaveBeenCalled();
  });

  it("FALLA CERRADO: si la base rechaza anotar o cerrar, no se confirma ni se cotiza nada", async () => {
    const begin = start(fakeAudit({ begin: async () => { throw new Error("caída"); } }));
    await processTurns([text("cotiza hemograma")], begin.deps);
    expect(begin.sends).toEqual([TECHNICAL_ISSUE_MESSAGE]);
    const close = start(fakeAudit({ begin: here(1), read: ready(itemOf(1, { studyIds: [uuid(1)] })) }));
    close.audit.quoteClose.mockRejectedValueOnce(new Error("caída"));
    await processTurns([text("cotiza hemograma")], close.deps);
    expect(close.sends).toEqual([TECHNICAL_ISSUE_MESSAGE]);
  });

  it("un reintento del mismo mensaje (el cierre ya ocurrió) repite la MISMA cotización guardada sin recalcular", async () => {
    const lines = [{ studyId: uuid(1), name: "HEMOGRAMA COMPLETO", priceBs: 45 }];
    const audit = fakeAudit({ begin: here(1, "exists"), read: async () => ({ state: "replay", sessionId: "s1", outcome: "QUOTED", reasons: [], lines, totalBs: 45 }) });
    const w = start(audit);
    await processTurns([text("cotiza hemograma")], w.deps);
    expect(w.sends[0]).toContain("HEMOGRAMA COMPLETO — Bs 45");
    expect(audit.quoteClose).not.toHaveBeenCalled();
  });

  it("la pregunta lleva su propia firma para la guarda antibucles", async () => {
    const audit = fakeAudit({ read: ready(itemOf(1, { studyIds: [uuid(1)] }), itemOf(2, { studyIds: [uuid(2)] })) });
    const w = start(audit);
    w.deps.turns!.replyGuard = { rules: [{ windowSeconds: 600, max: 8 }], burst: { windowSeconds: 60, max: 8 }, repeat: { windowSeconds: 900, max: 3 }, cooldownSeconds: 900 };
    await processTurns([text("todavía no")], w.deps);
    expect(audit.reserveSend).toHaveBeenCalledWith("run-1", "conversation", LEASE, expect.objectContaining({ guard: expect.objectContaining({ signature: "QUOTE_ASK:2" }) }));
  });
});

describe("G4.2: integración del apéndice de preparación con los turnos", () => {
  it("al cotizar una sesión por texto anexa la preparación al MISMO mensaje después del cierre", async () => {
    const item: SessionItem = {
      id: "i1", seq: 1, kind: "TEXT", status: "RESOLVED",
      studyIds: [uuid(1)], ambiguous: [], unresolved: 0, reasons: []
    };
    const w = setup({ audit: fakeAudit({ read: async () => ({ state: "ready", sessionId: "s1", items: [item] }) }) });
    const append = vi.fn(async (body: string, _ids: readonly string[], _catalog: readonly CatalogStudy[]) => `${body}\n\nPREPARACIÓN VERIFICADA`);
    w.deps.quotePreparations = append;
    await processTurns([text("listo")], w.deps);
    expect(w.sends).toHaveLength(1);
    expect(w.sends[0]).toContain("HEMOGRAMA COMPLETO — Bs 45");
    expect(w.sends[0]).toContain("PREPARACIÓN VERIFICADA");
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0]?.[1]).toEqual([uuid(1)]);
    expect(w.audit.quoteClose).toHaveBeenCalled();
  });

  it("foto independiente mantiene el matching/precio y anexa solo los UUID cotizados", async () => {
    const analysis = {
      decision: "AUTO_SAFE", outcome: "AUTO_COMPLETE", reasons: [],
      finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [],
      publicQuote: { studies: [{ name: "HEMOGRAMA COMPLETO", priceBs: 45 }], totalBs: 45, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" },
      internal: {
        quoted: { lines: [{ id: uuid(1), code: null, name: "HEMOGRAMA COMPLETO", priceBs: 45 }] },
        studies: [], pending: [], recipeStops: [], advisories: [], document: { zones: [] }
      }
    } as unknown as AnalysisResult;
    const w = setup({ analysis });
    delete w.deps.turns;
    const append = vi.fn(async (body: string, _ids: readonly string[], _catalog: readonly CatalogStudy[]) => `${body}\n\nPREPARACIÓN VERIFICADA`);
    w.deps.quotePreparations = append;
    await processTurns([image()], w.deps);
    expect(w.sends).toHaveLength(1);
    expect(w.sends[0]).toContain("HEMOGRAMA COMPLETO — Bs 45");
    expect(w.sends[0]).toContain("PREPARACIÓN VERIFICADA");
    expect(append.mock.calls[0]?.[1]).toEqual([uuid(1)]);
  });

  it("si falla el anexo, sigue saliendo solo la cotización y no un aviso técnico", async () => {
    const item: SessionItem = {
      id: "i1", seq: 1, kind: "TEXT", status: "RESOLVED",
      studyIds: [uuid(1)], ambiguous: [], unresolved: 0, reasons: []
    };
    const w = setup({ audit: fakeAudit({ read: async () => ({ state: "ready", sessionId: "s1", items: [item] }) }) });
    w.deps.quotePreparations = vi.fn(async () => { throw new Error("store unavailable"); });
    await processTurns([text("listo")], w.deps);
    expect(w.sends).toHaveLength(1);
    expect(w.sends[0]).toContain("HEMOGRAMA COMPLETO — Bs 45");
    expect(w.sends[0]).not.toContain("PREPARACIÓN VERIFICADA");
    expect(w.sends[0]).not.toBe(TECHNICAL_ISSUE_MESSAGE);
  });
});
