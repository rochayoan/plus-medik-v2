import { describe, expect, it, vi } from "vitest";
import type { AnalysisResult } from "../src/analyze.js";
import { AuditWriteError, type AuditClaim, type AuditLease, type AuditRepository } from "../src/audit.js";
import { KnowledgeService } from "../src/knowledge/index.js";
import { ANSWER_TEXTS, type KnowledgeQueries } from "../src/knowledge-answers.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { BLOCKED_HANDOFF, createTextHandler, DRAFT_TEXTS, type HandoffRequest, type HandoffSink } from "../src/text-handler.js";
import { processTurns, type IncomingTurn } from "../src/turns.js";
import type { CatalogStudy } from "../src/types.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";
import { branch, faq, iso, MemoryStore, payment, preparation, schedule, STUDY_A, T0 } from "./support/knowledge-fixtures.js";

// El manejador de texto CON conocimiento: qué consulta, qué responde, qué rastro deja y qué pasa cuando falta algo. Sin base de datos (repositorio de auditoría simulado); la
// garantía real está en tests/knowledge-answers-e2e.test.ts. Todos los datos son fixtures de PRUEBA.

const LEASE: AuditLease = { owner: "owner-0000001", fence: 1 };
const KEY = "a".repeat(64);
const SENTINEL = "TEXTO_CLINICO_SENTINELA_6402";
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]);
const okAnalysis = () => ({ decision: "AUTO_SAFE", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], outcome: "AUTO_COMPLETE", publicQuote: { studies: [{ name: "HEMOGRAMA", priceBs: 45 }], totalBs: 45, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" } }) as AnalysisResult;
const catalog: CatalogStudy[] = [{ id: STUDY_A, code: null, name: "ESTUDIO ALFA DE PRUEBA", normalizedName: normalizeStudyKey("ESTUDIO ALFA DE PRUEBA"), normalizedAliases: ["alfa"], priceBs: 1, active: true }];
const turn = (text: string, messageId = "wamid.t1"): IncomingTurn => ({ messageId, from: "59170000000", kind: "TEXT", text });
const DATA = [branch(), schedule(), payment("efectivo"), faq("faq:estacionamiento", ["estacionamiento"]), preparation(STUDY_A)];

function fakeAudit(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const mark = <T extends (...args: never[]) => unknown>(name: string, fn: T) => vi.fn(((...args: never[]) => { calls.push(name); return fn(...args); }) as T);
  const repo = {
    claim: mark("claim", async (): Promise<AuditClaim> => ({ kind: "claimed", runId: "run-1", lease: LEASE, takeover: false })),
    renewLease: vi.fn(async () => true),
    recordIgnored: mark("recordIgnored", async () => undefined),
    recordEvidence: vi.fn(async () => undefined),
    recordFailure: mark("recordFailure", async () => undefined),
    recordKnowledgeRefs: mark("recordKnowledgeRefs", async (): Promise<"recorded" | "closed"> => "recorded"),
    reserveSend: mark("reserveSend", async (): Promise<string> => "reserved"),
    confirmSend: mark("confirmSend", async (): Promise<string> => "proceed"),
    recordReply: mark("recordReply", async () => undefined),
    releaseTurn: vi.fn(async () => undefined),
    ...overrides
  };
  return Object.assign(repo as unknown as AuditRepository & { [K in keyof typeof repo]: (typeof repo)[K] }, { calls });
}

function setup(options: { audit?: ReturnType<typeof fakeAudit>; items?: unknown[]; knowledge?: boolean; service?: KnowledgeQueries; handoff?: HandoffSink; loadCatalog?: () => Promise<CatalogStudy[]> } = {}) {
  const audit = options.audit ?? fakeAudit();
  const sends: string[] = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  const log = (event: string, data: Record<string, unknown>) => { logs.push([event, data]); };
  const store = new MemoryStore({ revision: 1, items: options.items ?? DATA });
  const service = options.service ?? new KnowledgeService({ store, now: () => T0 });
  const handler = createTextHandler({ handoff: options.handoff, log, knowledge: options.knowledge === false ? undefined : { service, loadCatalog: options.loadCatalog ?? (async () => catalog), now: () => T0 } });
  const deps: QuoteDeps = {
    downloadImage: vi.fn(async () => ({ bytes: jpeg })), loadCatalog: vi.fn(async () => []), analyze: vi.fn(async () => okAnalysis()),
    sendText: vi.fn(async (_to: string, body: string) => { sends.push(body); return { providerMessageId: "wamid.out" }; }),
    log, audit, leaseRenewIntervalMs: 3_600_000,
    turns: { contactKeyFor: () => KEY, busyRetries: 1, busyDelayMs: 1, sleep: async () => undefined, handlers: { text: handler } }
  };
  return { deps, audit, sends, logs, store, logged: (name: string) => logs.filter(([event]) => event === name).map(([, data]) => data) };
}
const run = (t: ReturnType<typeof setup>, text: string, id = "wamid.t1") => processTurns([turn(text, id)], t.deps);

describe("el manejador responde con conocimiento aprobado", () => {
  it("horarios, sucursales, pagos, FAQ y preparación: la respuesta enviada contiene los datos aprobados y es de tipo 'conversation'", async () => {
    const cases: Array<[string, RegExp]> = [
      ["¿cuál es el horario?", /Lunes: 08:00 a 12:00 y 14:00 a 18:00/], ["¿dónde están ubicados?", /DIRECCION DE PRUEBA/], ["¿aceptan efectivo?", /Aceptamos: METODO EFECTIVO DE PRUEBA/],
      ["¿tienen estacionamiento?", /RESPUESTA DE PRUEBA/], ["¿necesito ayuno para alfa?", /Ayuno: 8 horas[\s\S]*INSTRUCCION DE PRUEBA/]
    ];
    for (const [question, expected] of cases) {
      const t = setup();
      const [report] = await run(t, question);
      expect(report!.result, question).toBe("conversation");
      expect(t.sends[0], question).toMatch(expected);
      expect(t.audit.reserveSend).toHaveBeenCalledWith("run-1", "conversation", LEASE, { stale: "NONE" });
    }
  });

  it("ORDEN DE SEGURIDAD: primero se registran las referencias, después se reserva, se confirma y se envía", async () => {
    const t = setup();
    await run(t, "horario");
    expect(t.audit.calls).toEqual(["claim", "recordKnowledgeRefs", "reserveSend", "confirmSend", "recordReply"]);
    const [runId, refs, lease] = t.audit.recordKnowledgeRefs.mock.calls[0] as unknown as [string, Array<Record<string, unknown>>, AuditLease];
    expect([runId, lease]).toEqual(["run-1", LEASE]);
    expect(refs.map((ref) => [ref.kind, ref.key, ref.version]).sort()).toEqual([["BRANCH", "branch-prueba", 1], ["SCHEDULE", "schedule:branch-prueba:office", 1]]);
    expect(refs.every((ref) => /^[0-9a-f]{64}$/.test(String(ref.contentHash)))).toBe(true);
  });

  it("las referencias no contienen texto del paciente ni de la respuesta; el registro solo lleva códigos (tema, estado, tipo/clave/versión)", async () => {
    const t = setup();
    await run(t, `${SENTINEL} horario`);
    expect(JSON.stringify(t.audit.recordKnowledgeRefs.mock.calls)).not.toContain(SENTINEL);
    expect(JSON.stringify(t.audit.recordKnowledgeRefs.mock.calls)).not.toContain("DIRECCION");
    expect(JSON.stringify(t.logs)).not.toContain(SENTINEL);
    expect(JSON.stringify(t.logs)).not.toContain("59170000000");
    expect(t.logged("text_turn")).toEqual([{ category: "INFO_REQUEST", handoff: "none", knowledge: "answered" }]);
    expect(t.logged("knowledge_answer")).toEqual([{ topics: ["HOURS"], status: "ANSWERED", refs: [{ kind: "BRANCH", key: "branch-prueba", version: 1 }, { kind: "SCHEDULE", key: "schedule:branch-prueba:office", version: 1 }], unavailable: [] }]);
  });

  it("también atiende mensajes sin clasificar (OTHER) cuando coinciden con una pregunta frecuente aprobada", async () => {
    const t = setup();
    await run(t, "tienen estacionamiento");
    expect(t.sends[0]).toContain("RESPUESTA DE PRUEBA");
  });

  it("una pregunta de aclaración (sin estudio) se envía sin referencias: no hay nada que registrar", async () => {
    const t = setup();
    await run(t, "¿necesito ayuno?");
    expect(t.sends).toEqual([ANSWER_TEXTS.askStudy]);
    expect(t.audit.recordKnowledgeRefs).not.toHaveBeenCalled();
    expect(t.logged("text_turn")).toEqual([{ category: "INFO_REQUEST", handoff: "none", knowledge: "clarify" }]);
  });

  it("la respuesta basada en conocimiento NO se descarta si llega otro mensaje después (stale NONE); el aviso de 'no disponible' sí puede descartarse", async () => {
    const withData = setup();
    await run(withData, "horario");
    expect(withData.audit.reserveSend).toHaveBeenCalledWith("run-1", "conversation", LEASE, { stale: "NONE" });
    const without = setup({ items: [] });
    await run(without, "horario");
    expect(without.audit.reserveSend).toHaveBeenCalledWith("run-1", "conversation", LEASE, { stale: "NEWER_TURN" });
  });
});

describe("SIN datos aprobados: no se inventa; el bot responde como antes (G2.1)", () => {
  it("sin conocimiento cargado: horarios, sucursales, pagos y preparación reciben el mismo aviso que sin esta función, sin referencias ni consultas de más", async () => {
    for (const question of ["horario", "¿dónde están?", "aceptan tarjeta", "ayuno para alfa", "emiten factura"]) {
      const t = setup({ items: [] });
      await run(t, question);
      expect(t.sends, question).toEqual([DRAFT_TEXTS.handoff_unavailable]);
      expect(t.audit.recordKnowledgeRefs, question).not.toHaveBeenCalled();
      expect(t.logged("text_turn")[0], question).toMatchObject({ category: "INFO_REQUEST", handoff: "blocked", knowledge: "unavailable" });
    }
  });

  it("vencido o retirado: igual que sin datos; un mensaje cualquiera sin tema recibe el texto genérico de siempre", async () => {
    const expired = setup({ items: [branch("branch-prueba", { validUntil: iso(-1) }), schedule()] });
    await run(expired, "horario");
    expect(expired.sends).toEqual([DRAFT_TEXTS.handoff_unavailable]);
    const other = setup();
    await run(other, "gracias");
    expect(other.sends).toEqual([DRAFT_TEXTS.fallback]);
  });

  it("la preparación sin registro aprobado NUNCA dice 'no requiere preparación'", async () => {
    const t = setup({ items: [branch(), schedule()] });
    await run(t, "¿necesito ayuno para alfa?");
    expect(t.sends[0]).not.toMatch(/no requiere|sin preparaci/i);
    expect(t.sends).toEqual([DRAFT_TEXTS.handoff_unavailable]);
  });

  it("respuesta parcial: lo disponible se responde y lo que falta se declara; las referencias solo son de lo respondido", async () => {
    const t = setup({ items: [payment("efectivo")] });
    await run(t, "horario y formas de pago");
    expect(t.sends[0]).toContain("Aceptamos:");
    expect(t.sends[0]).toContain("Sobre los horarios no tengo información disponible por ahora.");
    expect((t.audit.recordKnowledgeRefs.mock.calls[0] as unknown as unknown[])[1]).toEqual([{ kind: "PAYMENT_METHOD", key: "payment:efectivo", version: 1, contentHash: "a".repeat(64) }]);
    expect(t.logged("knowledge_answer")[0]).toMatchObject({ status: "PARTIAL", unavailable: [{ topic: "HOURS", reason: "NO_APPROVED_VERSION" }] });
  });

  it("si el servicio de conocimiento falla, se responde como sin conocimiento y se registra solo el código", async () => {
    const broken = { getBranches: async () => { throw new Error(`falla ${SENTINEL}`); } } as unknown as KnowledgeQueries;
    const t = setup({ service: broken });
    await run(t, "horario");
    expect(t.sends).toEqual([DRAFT_TEXTS.handoff_unavailable]);
    expect(t.logged("knowledge_failed")).toEqual([{ category: "INFO_REQUEST" }]);
    expect(JSON.stringify(t.logs)).not.toContain(SENTINEL);
  });

  it("si el catálogo no carga, la pregunta de preparación se responde como sin conocimiento", async () => {
    const t = setup({ loadCatalog: async () => { throw new Error("catálogo caído"); } });
    await run(t, "ayuno para alfa");
    expect(t.sends).toEqual([DRAFT_TEXTS.handoff_unavailable]);
  });
});

describe("TRAZABILIDAD obligatoria: sin rastro no se envía lo basado en conocimiento", () => {
  const cases: Array<[string, () => ReturnType<typeof fakeAudit>]> = [
    ["la base cae al registrar", () => fakeAudit({ recordKnowledgeRefs: vi.fn(async () => { throw new AuditWriteError("UNKNOWN_OUTCOME"); }) })],
    ["el registro responde 'closed'", () => fakeAudit({ recordKnowledgeRefs: vi.fn(async () => "closed") })],
    ["el repositorio no implementa el registro (migración 9 sin aplicar)", () => fakeAudit({ recordKnowledgeRefs: undefined })]
  ];
  for (const [label, audit] of cases) {
    it(`${label}: se responde lo que correspondería SIN conocimiento (nunca la respuesta con datos)`, async () => {
      const t = setup({ audit: audit() });
      await run(t, "horario");
      expect(t.sends, label).toEqual([DRAFT_TEXTS.handoff_unavailable]);
      expect(t.sends.join("")).not.toContain("Lunes");
      expect(t.logged("knowledge_trace_failed")).toHaveLength(1);
    });
  }

  it("con el fallo de trazabilidad el aviso de 'no disponible' es descartable (NEWER_TURN), igual que sin conocimiento", async () => {
    const t = setup({ audit: fakeAudit({ recordKnowledgeRefs: vi.fn(async () => "closed") }) });
    await run(t, "horario");
    expect(t.audit.reserveSend).toHaveBeenCalledWith("run-1", "conversation", LEASE, { stale: "NEWER_TURN" });
  });

  it("si se pierde el lease durante el registro (otra ejecución reclamó el turno), esta NO envía NADA: ni lo basado en conocimiento ni el aviso alternativo", async () => {
    const t = setup({ audit: fakeAudit({ recordKnowledgeRefs: vi.fn(async () => { throw new AuditWriteError("LEASE_LOST"); }), reserveSend: vi.fn(async () => "lost") }) });
    await run(t, "horario");
    expect(t.sends).toEqual([]);
  });
});

describe("lo que NO se responde con conocimiento", () => {
  const untouched = async (text: string, expected: string) => {
    const service = { getBranches: vi.fn(), getSchedule: vi.fn(), getPolicy: vi.fn(), getPaymentMethods: vi.fn(), findFaqByTag: vi.fn(), getStudyPreparation: vi.fn() };
    const t = setup({ service: service as unknown as KnowledgeQueries });
    await run(t, text);
    expect(t.sends, text).toEqual([expected]);
    for (const fn of Object.values(service)) expect(fn, text).not.toHaveBeenCalled();
    expect(t.audit.recordKnowledgeRefs, text).not.toHaveBeenCalled();
  };

  it("lo MÉDICO nunca consulta conocimiento, ni siquiera si menciona horarios o ayuno", async () => {
    await untouched("me duele el pecho, ¿a qué hora abren?", DRAFT_TEXTS.medical_unavailable);
    await untouched("estoy embarazada, ¿necesito ayuno?", DRAFT_TEXTS.medical_unavailable);
    await untouched("qué dosis de ibuprofeno tomo", DRAFT_TEXTS.medical_unavailable);
  });

  it("pedir a una persona nunca consulta conocimiento: sigue el camino de derivación (bloqueada)", async () => {
    await untouched("quiero hablar con un asesor sobre el horario", DRAFT_TEXTS.handoff_unavailable);
  });

  it("saludos y cotizar siguen siendo los textos fijos de siempre, sin consultar nada", async () => {
    await untouched("hola", DRAFT_TEXTS.greeting);
    await untouched("quiero cotizar", DRAFT_TEXTS.send_recipe);
  });

  it("la derivación a una persona sigue funcionando igual que en G2.1 cuando hay sumidero operativo y NO hay conocimiento aplicable", async () => {
    const requests: HandoffRequest[] = [];
    const handoff: HandoffSink = { operational: true, record: async (request) => { requests.push(request); return "RECORDED"; } };
    const t = setup({ items: [], handoff });
    await run(t, "¿tienen promociones?");
    expect(t.sends).toEqual([DRAFT_TEXTS.handoff_confirmed]);
    expect(requests).toHaveLength(1);
  });
});

describe("compatibilidad: sin la opción `knowledge` el manejador es EXACTAMENTE el de G2.1", () => {
  it("mismas respuestas, mismas políticas y el mismo registro (sin campo 'knowledge'), sin consultar rastros", async () => {
    const t = setup({ knowledge: false });
    for (const [text, expected] of [["hola", DRAFT_TEXTS.greeting], ["quiero cotizar", DRAFT_TEXTS.send_recipe], ["horario", DRAFT_TEXTS.handoff_unavailable], ["gracias", DRAFT_TEXTS.fallback], ["me duele", DRAFT_TEXTS.medical_unavailable]] as const) {
      t.sends.length = 0;
      await run(t, text, `wamid.${text}`);
      expect(t.sends, text).toEqual([expected]);
    }
    expect(t.audit.recordKnowledgeRefs).not.toHaveBeenCalled();
    expect(t.logged("text_turn").map((entry) => Object.keys(entry).sort())).toEqual(Array(5).fill(["category", "handoff"]));
    expect(t.logged("knowledge_answer")).toEqual([]);
  });

  it("el handler con sumidero bloqueado explícito responde igual que sin sumidero", async () => {
    const a = setup({ knowledge: false, handoff: BLOCKED_HANDOFF });
    const b = setup({ knowledge: false });
    await run(a, "quiero un asesor");
    await run(b, "quiero un asesor");
    expect(a.sends).toEqual(b.sends);
  });
});
