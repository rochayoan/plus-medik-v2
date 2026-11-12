import { describe, expect, it } from "vitest";
import { fragmentsOf, photoOutcomeOf, resolveBatchEngine } from "../src/batch-engine.js";
import type { ReplyPlan } from "../src/batch-policy.js";
import { buildShadowReport, classifyPlan, classifyProduced, compareClasses, expectedClasses } from "../src/batch-shadow.js";
import type { Produced } from "../src/guarded-turn.js";
import { QUOTE_TEXTS } from "../src/quote-session.js";
import type { IncomingTurn } from "../src/turns.js";
import { EMPTY_SESSION, understandBatch } from "../src/batch-understanding.js";
import { decideBatch } from "../src/batch-policy.js";
import { normalizeStudyKey } from "../src/consensus.js";
import type { CatalogStudy } from "../src/types.js";
const catalogForShadow = (): CatalogStudy[] => [
  { id: "00000000-0000-4000-8000-000000000001", code: null, name: "HEMOGRAMA COMPLETO", normalizedName: normalizeStudyKey("HEMOGRAMA COMPLETO"), normalizedAliases: [normalizeStudyKey("hemograma")], priceBs: 45, active: true },
  { id: "00000000-0000-4000-8000-000000000002", code: null, name: "GLUCOSA EN AYUNAS", normalizedName: normalizeStudyKey("GLUCOSA EN AYUNAS"), normalizedAliases: [normalizeStudyKey("glucosa")], priceBs: 30, active: true }
];
const catalog = catalogForShadow();

// Puente del motor de lotes (Fase 3): la configuración (apagado por defecto), cómo se leen los textos y las fotos de un lote, y la clasificación pura con la que el modo sombra compara decisiones.

describe("PLUSMEDIK_BATCH_ENGINE: apagado por defecto", () => {
  it("ausente, vacío u «off»: apagado, sin error", () => {
    for (const value of [undefined, "", "  ", "off", "OFF", " Off "]) expect(resolveBatchEngine({ PLUSMEDIK_BATCH_ENGINE: value }), String(value)).toEqual({ mode: undefined });
    expect(resolveBatchEngine({})).toEqual({ mode: undefined });
  });

  it("«shadow» y «on» (sin importar mayúsculas ni espacios) lo encienden", () => {
    expect(resolveBatchEngine({ PLUSMEDIK_BATCH_ENGINE: "shadow" })).toEqual({ mode: "shadow" });
    expect(resolveBatchEngine({ PLUSMEDIK_BATCH_ENGINE: " ON " })).toEqual({ mode: "on" });
  });

  it("cualquier otro valor lo deja apagado y avisa con un código: una errata nunca lo enciende", () => {
    for (const value of ["true", "1", "yes", "enabled", "sombra", "shadow,on", "onn"]) expect(resolveBatchEngine({ PLUSMEDIK_BATCH_ENGINE: value }), value).toEqual({ mode: undefined, error: "INVALID_VALUE" });
  });
});

const turn = (id: string, kind: IncomingTurn["kind"], text?: string): IncomingTurn => ({ messageId: id, from: "59170000000", kind, ...(text !== undefined ? { text } : {}) });

describe("fragmentsOf: los textos del lote como los entiende el motor", () => {
  it("solo los textos, en orden, con su identificador", () => {
    expect(fragmentsOf([turn("a", "TEXT", "uno"), turn("b", "TEXT", "dos")])).toEqual([{ id: "a", text: "uno" }, { id: "b", text: "dos" }]);
  });

  it("una foto (u otro tipo) entre dos textos marca el corte: los nombres de estudios no se reconstruyen a través de ella", () => {
    expect(fragmentsOf([turn("a", "TEXT", "hemograma"), turn("i", "IMAGE"), turn("b", "TEXT", "completo")])).toEqual([{ id: "a", text: "hemograma" }, { id: "b", text: "completo", breakBefore: true }]);
    // una foto antes del primer texto no marca nada (no hay texto anterior)
    expect(fragmentsOf([turn("i", "IMAGE"), turn("a", "TEXT", "hola")])).toEqual([{ id: "a", text: "hola" }]);
  });
});

describe("photoOutcomeOf: qué dejó una foto, según lo que su turno produjo", () => {
  const reply = (body: string, extra: Partial<Extract<Produced, { kind: "reply" }>> = {}): Produced => ({ kind: "reply", body, result: "no_quote", processingStatus: "COMPLETED", ...extra });

  it("reconoce ilegible, repetida, sesión llena y fallo técnico; lo demás es una foto bien anotada (ya figura en la sesión)", () => {
    expect(photoOutcomeOf(reply(QUOTE_TEXTS.unreadable_image))).toEqual({ status: "UNREADABLE", studyIds: [] });
    expect(photoOutcomeOf(reply(QUOTE_TEXTS.duplicate_image))).toEqual({ status: "DUPLICATE", studyIds: [] });
    expect(photoOutcomeOf(reply(QUOTE_TEXTS.full))).toEqual({ status: "FULL", studyIds: [] });
    expect(photoOutcomeOf({ kind: "reply", body: "x", result: "technical_issue", processingStatus: "FAILED" })).toEqual({ status: "FAILED", studyIds: [] });
    expect(photoOutcomeOf({ kind: "none" })).toEqual({ status: "UNREADABLE", studyIds: [] });
    expect(photoOutcomeOf(reply("Recibí tu foto.", { result: "conversation", signature: "QUOTE_ADDED:1" }))).toEqual({ status: "RESOLVED", studyIds: [] });
  });

  it("lo que informa el productor de la foto (estado e ids) manda sobre lo que se deduzca del texto: así una foto con un número de turno posterior al texto también cuenta", () => {
    expect(photoOutcomeOf(reply("Recibí tu foto.", { photo: { status: "RESOLVED", studyIds: ["a", "b"] } }))).toEqual({ status: "RESOLVED", studyIds: ["a", "b"] });
    expect(photoOutcomeOf(reply("Recibí tu foto.", { photo: { status: "UNCERTAIN", studyIds: ["a"] } }))).toEqual({ status: "UNCERTAIN", studyIds: ["a"] });
    expect(photoOutcomeOf(reply(QUOTE_TEXTS.unreadable_image, { photo: { status: "UNREADABLE", studyIds: [] } }))).toEqual({ status: "UNREADABLE", studyIds: [] });
  });
});

describe("modo sombra: clasificación de lo que respondió la ruta de siempre", () => {
  const texts = QUOTE_TEXTS;
  const reply = (body: string, result: Extract<Produced, { kind: "reply" }>["result"] = "no_quote", signature?: string): Produced => ({ kind: "reply", body, result, processingStatus: "COMPLETED", ...(signature ? { signature } : {}) });

  it("cada salida de la ruta de siempre cae en una clase cerrada", () => {
    expect(classifyProduced({ kind: "none" }, texts)).toBe("SILENT");
    expect(classifyProduced(reply("cotización", "quoted"), texts)).toBe("QUOTE");
    expect(classifyProduced(reply("fallo", "technical_issue"), texts)).toBe("TECHNICAL");
    expect(classifyProduced(reply(texts.review), texts)).toBe("REVIEW");
    expect(classifyProduced(reply(texts.review_confirmed), texts)).toBe("REVIEW");
    expect(classifyProduced(reply(texts.resend), texts)).toBe("REVIEW");
    expect(classifyProduced(reply(texts.cancelled), texts)).toBe("CANCELLED");
    expect(classifyProduced(reply(texts.nothing_to_cancel), texts)).toBe("NOTHING_TO_CANCEL");
    expect(classifyProduced(reply(texts.empty), texts)).toBe("EMPTY");
    expect(classifyProduced(reply(texts.waiting), texts)).toBe("WAITING");
    expect(classifyProduced(reply("Anoté lo que escribiste.", "conversation", "QUOTE_ADDED:2"), texts)).toBe("SESSION_REPLY");
    expect(classifyProduced(reply("¿Cuál de estas?", "conversation", "QUOTE_ASK:2"), texts)).toBe("SESSION_REPLY");
    expect(classifyProduced(reply("Hola", "conversation"), texts)).toBe("CONVERSATION");
    expect(classifyProduced(reply("otra cosa"), texts)).toBe("OTHER");
  });

  it("una cotización manda sobre el resto, aunque el mensaje combinado traiga más cosas", () => {
    expect(classifyProduced(reply(`aviso médico\n\n${texts.empty}`, "quoted"), texts)).toBe("QUOTE");
    expect(classifyProduced(reply(`aviso médico\n\n${texts.empty}`, "conversation"), texts)).toBe("EMPTY");
  });
});

const emptyPlan = (core: ReplyPlan["core"], extra: Partial<ReplyPlan> = {}): ReplyPlan => ({ safety: [], delegatedQuestionIds: [], notices: [], core, cancelPrevious: false, record: undefined, reasons: [], ...extra });

describe("modo sombra: clasificación de lo que decidiría el motor nuevo", () => {
  it("cada bloque principal tiene su clase", () => {
    expect(classifyPlan(emptyPlan({ kind: "QUOTE", studyIds: ["a"], closeBy: "INTENT" }))).toBe("QUOTE");
    expect(classifyPlan(emptyPlan({ kind: "REVIEW", studyIds: ["a"], reasons: [] }))).toBe("REVIEW");
    expect(classifyPlan(emptyPlan({ kind: "CLARIFY", studyIds: [], questions: [] }))).toBe("SESSION_REPLY");
    expect(classifyPlan(emptyPlan({ kind: "SUMMARY", studyIds: ["a"], askMore: true }))).toBe("SESSION_REPLY");
    expect(classifyPlan(emptyPlan({ kind: "CANCELLED" }))).toBe("CANCELLED");
    expect(classifyPlan(emptyPlan({ kind: "NOTHING_TO_CANCEL" }))).toBe("NOTHING_TO_CANCEL");
    expect(classifyPlan(emptyPlan({ kind: "DECLINED", studyIds: [] }))).toBe("DECLINED");
    expect(classifyPlan(emptyPlan({ kind: "EMPTY_REQUEST" }))).toBe("EMPTY");
    expect(classifyPlan(emptyPlan({ kind: "PROMPT", reason: "GREETING" }))).toBe("CONVERSATION");
  });

  it("sin bloque principal: lo delegado (seguridad, preguntas) es conversación; los avisos solos son «otro»/técnico; lo demás es silencio", () => {
    expect(classifyPlan(emptyPlan({ kind: "NONE", reason: "HANDLED_ELSEWHERE" }, { safety: [{ kind: "MEDICAL", fragmentIds: ["a"], split: false }] }))).toBe("CONVERSATION");
    expect(classifyPlan(emptyPlan({ kind: "NONE", reason: "HANDLED_ELSEWHERE" }, { delegatedQuestionIds: ["a"] }))).toBe("CONVERSATION");
    expect(classifyPlan(emptyPlan({ kind: "NONE", reason: "HANDLED_ELSEWHERE" }, { notices: [{ kind: "UNREADABLE_PHOTOS", count: 1 }] }))).toBe("OTHER");
    expect(classifyPlan(emptyPlan({ kind: "NONE", reason: "HANDLED_ELSEWHERE" }, { notices: [{ kind: "TECHNICAL_ERROR", count: 1 }] }))).toBe("TECHNICAL");
    for (const reason of ["ACK_AFTER_QUOTE", "SOCIAL", "NOTHING_TO_SAY"] as const) expect(classifyPlan(emptyPlan({ kind: "NONE", reason }))).toBe("SILENT");
  });
});

describe("modo sombra: comparación", () => {
  it("iguales: coincide; distintas: dice hacia dónde se diferencia", () => {
    expect(compareClasses("QUOTE", "QUOTE")).toEqual({ agree: true, direction: "SAME", current: "QUOTE", shadow: "QUOTE", limits: [] });
    expect(compareClasses("SESSION_REPLY", "QUOTE")).toMatchObject({ agree: false, direction: "SHADOW_QUOTES_MORE" });
    expect(compareClasses("QUOTE", "DECLINED")).toMatchObject({ agree: false, direction: "SHADOW_QUOTES_LESS" });
    expect(compareClasses("CONVERSATION", "EMPTY")).toMatchObject({ agree: false, direction: "DIFFERENT" });
  });

  it("lo que decide el manejador de texto de siempre (saludos, charla, preguntas) puede ser respuesta o silencio: ambas son compatibles con el motor nuevo; solo la seguridad garantiza una respuesta", () => {
    expect(expectedClasses(emptyPlan({ kind: "PROMPT", reason: "GREETING" }))).toEqual(["CONVERSATION", "SILENT"]);
    expect(expectedClasses(emptyPlan({ kind: "NONE", reason: "HANDLED_ELSEWHERE" }, { delegatedQuestionIds: ["a"] }))).toEqual(["CONVERSATION", "SILENT"]);
    expect(expectedClasses(emptyPlan({ kind: "NONE", reason: "HANDLED_ELSEWHERE" }, { safety: [{ kind: "HUMAN_REQUEST", fragmentIds: ["a"], split: false }] }))).toEqual(["CONVERSATION"]);
    expect(compareClasses("SILENT", ["CONVERSATION", "SILENT"])).toMatchObject({ agree: true, direction: "SAME", current: "SILENT", shadow: "SILENT" });
    expect(compareClasses("CONVERSATION", ["CONVERSATION", "SILENT"])).toMatchObject({ agree: true });
    expect(compareClasses("QUOTE", ["CONVERSATION", "SILENT"])).toMatchObject({ agree: false, direction: "SHADOW_QUOTES_LESS", shadow: "CONVERSATION" });
  });

  it("una comparación NO FIABLE no cuenta ni como acuerdo ni como desacuerdo: agree es null y lleva el motivo", () => {
    expect(compareClasses("SESSION_REPLY", "QUOTE", ["MODEL_NEEDED"])).toEqual({ agree: null, direction: "INCONCLUSIVE", current: "SESSION_REPLY", shadow: "QUOTE", limits: ["MODEL_NEEDED"] });
    // aunque coincidan las clases: si no es fiable, tampoco es un acuerdo
    expect(compareClasses("QUOTE", "QUOTE", ["MODEL_NEEDED"])).toMatchObject({ agree: null, direction: "INCONCLUSIVE" });
  });

  const study = (n: number, name: string, alias: string): CatalogStudy => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: [normalizeStudyKey(alias)], priceBs: 10 * n, active: true });
  const catalog = [study(1, "HEMOGRAMA COMPLETO", "hemograma"), study(2, "GLUCOSA EN AYUNAS", "glucosa")];

  it("el informe lleva SOLO códigos y cantidades: ni textos del paciente, ni nombres de estudios, ni precios", async () => {
    const fragments = [{ id: "m1", text: "No quiero cotizar." }, { id: "m2", text: "hemograma completo" }, { id: "m3", text: "SECRETO_DEL_PACIENTE" }];
    const understanding = await understandBatch({ fragments, catalog, session: EMPTY_SESSION });
    const plan = decideBatch({ understanding });
    const report = buildShadowReport({ plan, understanding, current: { kind: "reply", body: "Anoté lo que escribiste. HEMOGRAMA COMPLETO", result: "conversation", processingStatus: "COMPLETED", signature: "QUOTE_ADDED:2" }, texts: QUOTE_TEXTS, messages: 3, photos: 0, modelConfigured: false });
    expect(report).toMatchObject({ agree: false, current: "SESSION_REPLY", shadow: "DECLINED", core: "DECLINED", intent: "DECLINE", messages: 3, photos: 0, negated: 1 });
    const serialized = JSON.stringify(report);
    for (const forbidden of ["SECRETO", "HEMOGRAMA", "hemograma", "00000000-0000", "Bs", "priceBs", "59170000000"]) expect(serialized, forbidden).not.toContain(forbidden);
    // todo lo que viaja es de un conjunto cerrado de claves
    expect(Object.keys(report).sort()).toEqual(["agree", "confirmedBy", "core", "current", "direction", "intent", "intentSource", "limits", "messages", "negated", "negationDoubts", "notices", "photos", "reasons", "safety", "sessionOpen", "shadow", "studies"].sort());
  });

  describe("el modo sombra no compara a ciegas: sin OpenAI no es fiable cuando la ruta de siempre sí lo habría consultado", () => {
    const run = async (messages: string[], over: { modelConfigured: boolean; current?: Produced }) => {
      const fragments = messages.map((text, index) => ({ id: `m${index}`, text }));
      const understanding = await understandBatch({ fragments, catalog, session: EMPTY_SESSION, modelUse: "never" });
      const plan = decideBatch({ understanding });
      const current: Produced = over.current ?? { kind: "reply", body: "Anoté lo que escribiste.", result: "conversation", processingStatus: "COMPLETED", signature: "QUOTE_ADDED:1" };
      return buildShadowReport({ plan, understanding, current, texts: QUOTE_TEXTS, messages: messages.length, photos: 0, modelConfigured: over.modelConfigured });
    };

    it("un estudio que el catálogo no identifica (la ruta de siempre pregunta a OpenAI) es NO CONCLUYENTE si hay modelo configurado", async () => {
      const report = await run(["hemograma", "xhq"], { modelConfigured: true });
      expect(report).toMatchObject({ agree: null, direction: "INCONCLUSIVE", limits: ["MODEL_NEEDED"] });
    });

    it("lo mismo con una frase que el catálogo toma por conversación: el modelo podría haber encontrado un estudio", async () => {
      const report = await run(["ayer fui al laboratorio de la esquina"], { modelConfigured: true });
      expect(report.limits).toContain("MODEL_NEEDED");
      expect(report.agree).toBeNull();
    });

    it("sin modelo configurado la ruta de siempre tampoco lo consulta: la comparación sí es fiable", async () => {
      const report = await run(["hemograma", "xhq"], { modelConfigured: false });
      expect(report.limits).toEqual([]);
      expect(typeof report.agree).toBe("boolean");
    });

    it("con modelo configurado pero todo identificado por el catálogo, es fiable (el modelo no habría intervenido)", async () => {
      const report = await run(["hemograma", "glucosa"], { modelConfigured: true });
      expect(report.limits).toEqual([]);
      // el motor nuevo cotiza una lista directo (12-nov) y la ruta de siempre aún pregunta «¿eso es todo?»: la diferencia es deliberada
      expect(typeof report.agree).toBe("boolean");
    });

    it("la intención poco clara no invalida la comparación: solo el motor nuevo consulta al modelo por eso, la ruta de siempre no", async () => {
      const report = await run(["hemograma y glucosa"], { modelConfigured: true });
      expect(report.limits).toEqual([]);
    });

    it("si la ruta de siempre esperó a mensajes anteriores o falló, su salida no es una decisión que comparar", async () => {
      const waiting: Produced = { kind: "reply", body: QUOTE_TEXTS.waiting, result: "no_quote", processingStatus: "COMPLETED" };
      const failed: Produced = { kind: "reply", body: "fallo", result: "technical_issue", processingStatus: "FAILED" };
      expect(await run(["hemograma", "glucosa"], { modelConfigured: false, current: waiting })).toMatchObject({ agree: null, limits: ["LEGACY_WAITING"] });
      expect(await run(["hemograma", "glucosa"], { modelConfigured: false, current: failed })).toMatchObject({ agree: null, limits: ["LEGACY_FAILED"] });
    });
  });
});
