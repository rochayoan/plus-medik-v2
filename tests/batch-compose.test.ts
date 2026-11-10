import { describe, expect, it } from "vitest";
import { assertSafeBatchTexts, BATCH_TEXTS, composeReply, composeTextsFor, UnsafeBatchTextError, type ComposeFacts, type ComposedReply } from "../src/batch-compose.js";
import { decideBatch, type Core, type Notice, type ReplyPlan } from "../src/batch-policy.js";
import { QUOTE_TEXTS } from "../src/quote-session.js";
import { DRAFT_TEXTS } from "../src/text-handler.js";

// Composición tipada (Fase 2; función pura): el plan se convierte en UN mensaje, en orden fijo, sin repetir ni descartar nada por parecerse a otra cosa.

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const G1 = ["00000000-0000-4000-8000-000000000007", "00000000-0000-4000-8000-000000000008"];
const NAMES: Record<string, string> = { [A]: "HEMOGRAMA COMPLETO", [B]: "GLUCOSA EN AYUNAS", [G1[0]!]: "CREATININA SERICA", [G1[1]!]: "CREATININA EN ORINA" };
const TECHNICAL = "Tuvimos un inconveniente. Intenta de nuevo en unos minutos.";
const texts = composeTextsFor(TECHNICAL);

const plan = (core: Core, extra: Partial<ReplyPlan> = {}): ReplyPlan => ({ safety: [], delegatedQuestionIds: [], notices: [], core, cancelPrevious: false, record: undefined, reasons: [], ...extra });
const facts = (extra: Partial<ComposeFacts> = {}): ComposeFacts => ({ namesOf: (ids) => ids.map((id) => NAMES[id] ?? "?"), optionsOf: (ids) => ids.map((id) => NAMES[id] ?? "?"), ...extra });
const compose = (p: ReplyPlan, f: Partial<ComposeFacts> = {}) => composeReply(p, facts(f), texts);
const bodyOf = (reply: ComposedReply | undefined) => reply?.body ?? "";

describe("bloque principal", () => {
  it("QUOTE: la cotización ya armada (con precios del catálogo) sale tal cual, como «quoted», sin descartarse por obsoleta", () => {
    const quote = { body: "🧪 *Cotización*\nHEMOGRAMA COMPLETO — Bs 45\nTotal: Bs 45" };
    const reply = compose(plan({ kind: "QUOTE", studyIds: [A], closeBy: "INTENT" }), { quote })!;
    expect(reply).toMatchObject({ body: quote.body, result: "quoted", processingStatus: "COMPLETED", stale: "NONE" });
    expect(reply.signature).toBeUndefined();
  });

  it("QUOTE sin cotización armada es un error de quien ejecuta: no se inventa una respuesta", () => {
    expect(() => compose(plan({ kind: "QUOTE", studyIds: [A], closeBy: "INTENT" }))).toThrow(/QUOTE sin cotización/);
  });

  it("SUMMARY (pregunta si falta algo): estudios anotados por NOMBRE del catálogo y una sola pregunta de cierre", () => {
    const reply = compose(plan({ kind: "SUMMARY", studyIds: [A, B], askMore: true }))!;
    expect(reply.body).toBe([QUOTE_TEXTS.added_text, `${QUOTE_TEXTS.identified_so_far} HEMOGRAMA COMPLETO, GLUCOSA EN AYUNAS.`, QUOTE_TEXTS.confirm_done].join("\n"));
    expect(reply).toMatchObject({ result: "conversation", stale: "NEWER_TURN", signature: "QUOTE_ADDED:2" });
  });

  it("SUMMARY que no pide confirmar (algo impide cotizar): lista lo anotado sin la pregunta «¿Eso es todo?»", () => {
    const reply = compose(plan({ kind: "SUMMARY", studyIds: [A], askMore: false }))!;
    expect(reply.body).toBe([QUOTE_TEXTS.added_text, `${QUOTE_TEXTS.identified_so_far} HEMOGRAMA COMPLETO.`].join("\n"));
    expect(reply.body).not.toContain(QUOTE_TEXTS.confirm_done);
  });

  it("CLARIFY de opciones: lista numerada del catálogo y cómo responder; solo lo necesario", () => {
    const reply = compose(plan({ kind: "CLARIFY", studyIds: [B], questions: [{ kind: "OPTIONS", candidateIds: G1, remainingGroups: 0, invalidChoice: false }] }))!;
    expect(reply.body).toContain(QUOTE_TEXTS.ask_option_intro);
    expect(reply.body).toContain("1. CREATININA SERICA");
    expect(reply.body).toContain("2. CREATININA EN ORINA");
    expect(reply.body).toContain(QUOTE_TEXTS.ask_option_outro);
    expect(reply.body).not.toContain(QUOTE_TEXTS.ask_unresolved);
    expect(reply.signature).toBe("QUOTE_ASK:1");
  });

  it("CLARIFY de nombre: pide el nombre exacto de lo que no se identificó; con las dos dudas se preguntan las dos, una vez cada una", () => {
    const name = compose(plan({ kind: "CLARIFY", studyIds: [A], questions: [{ kind: "NAME", mentions: ["xhq"] }] }))!;
    expect(name.body).toContain(QUOTE_TEXTS.ask_unresolved);
    expect(name.body).not.toContain(QUOTE_TEXTS.ask_option_intro);
    expect(name.body).not.toContain("xhq");
    const both = compose(plan({ kind: "CLARIFY", studyIds: [A], questions: [{ kind: "OPTIONS", candidateIds: G1, remainingGroups: 1, invalidChoice: false }, { kind: "NAME", mentions: ["xhq"] }] }))!;
    expect(both.body.match(new RegExp(QUOTE_TEXTS.ask_unresolved.slice(0, 20), "g"))).toHaveLength(1);
    expect(both.body.match(new RegExp(QUOTE_TEXTS.ask_option_intro.slice(0, 20), "g"))).toHaveLength(1);
  });

  it("una opción inválida abre la pregunta con el aviso «no encontré esa opción», no con el «anoté lo que escribiste»", () => {
    const reply = compose(plan({ kind: "CLARIFY", studyIds: [], questions: [{ kind: "OPTIONS", candidateIds: G1, remainingGroups: 0, invalidChoice: true }] }))!;
    expect(reply.body.startsWith(QUOTE_TEXTS.choose_invalid)).toBe(true);
  });

  it("DECLINED respeta el «no cotizar» y conserva lo anotado", () => {
    expect(bodyOf(compose(plan({ kind: "DECLINED", studyIds: [A] })))).toBe(`${BATCH_TEXTS.declined}\n${QUOTE_TEXTS.identified_so_far} HEMOGRAMA COMPLETO.`);
    expect(bodyOf(compose(plan({ kind: "DECLINED", studyIds: [] })))).toBe(BATCH_TEXTS.declined);
  });

  it("textos de cierre: cancelar, nada que cancelar, «listo» vacío y revisión salen como «no_quote» que nunca se descarta", () => {
    for (const [core, expected] of [[{ kind: "CANCELLED" }, QUOTE_TEXTS.cancelled], [{ kind: "NOTHING_TO_CANCEL" }, QUOTE_TEXTS.nothing_to_cancel], [{ kind: "EMPTY_REQUEST" }, QUOTE_TEXTS.empty], [{ kind: "REVIEW", studyIds: [A], reasons: ["AMBIGUOUS_STUDY"] }, QUOTE_TEXTS.review]] as const) {
      const reply = compose(plan(core as Core))!;
      expect(reply.body).toBe(expected);
      expect(reply).toMatchObject({ result: "no_quote", stale: "NONE" });
    }
  });

  it("PROMPT: solo los textos fijos que piden estudios o la receta, según el motivo", () => {
    expect(bodyOf(compose(plan({ kind: "PROMPT", reason: "GREETING" })))).toBe(DRAFT_TEXTS.greeting);
    expect(bodyOf(compose(plan({ kind: "PROMPT", reason: "QUOTE_WITHOUT_STUDIES" })))).toBe(DRAFT_TEXTS.send_recipe);
    expect(bodyOf(compose(plan({ kind: "PROMPT", reason: "OTHER" })))).toBe(DRAFT_TEXTS.fallback);
  });

  it("NONE no dice nada", () => {
    expect(compose(plan({ kind: "NONE", reason: "SOCIAL" }))).toBeUndefined();
    expect(compose(plan({ kind: "NONE", reason: "ACK_AFTER_QUOTE" }))).toBeUndefined();
  });

  it("si al ejecutar el bloque principal se resolvió de otra forma, manda el texto de esa salida (no el previsto)", () => {
    const reply = compose(plan({ kind: "QUOTE", studyIds: [A], closeBy: "INTENT" }), { override: { body: QUOTE_TEXTS.review, result: "no_quote" } })!;
    expect(reply.body).toBe(QUOTE_TEXTS.review);
    expect(reply.result).toBe("no_quote");
  });

  it("la nota de lo que el modelo interpretó y los repetidos se agregan al resumen, una vez", () => {
    const note = "Interpreté «glucoza» como GLUCOSA EN AYUNAS.";
    const reply = compose(plan({ kind: "SUMMARY", studyIds: [B], askMore: true }), { interpretedNote: note, repeated: 1 })!;
    expect(reply.body.split("\n")).toEqual([QUOTE_TEXTS.added_text, `${QUOTE_TEXTS.identified_so_far} GLUCOSA EN AYUNAS.`, QUOTE_TEXTS.repeated_note, note, QUOTE_TEXTS.confirm_done]);
  });
});

describe("seguridad, avisos y orden: nada se suprime ni se repite", () => {
  const medical: DelegatedBody = { body: DRAFT_TEXTS.medical_unavailable };
  const human: DelegatedBody = { body: DRAFT_TEXTS.handoff_confirmed, stale: "NONE" };
  type DelegatedBody = { body: string; stale?: "NONE" | "NEWER_TURN" };

  it("ORDEN FIJO: primero lo que atienden los manejadores de seguridad e información, luego los avisos y al final el bloque principal", () => {
    const notices: Notice[] = [{ kind: "UNREADABLE_PHOTOS", count: 1 }, { kind: "DUPLICATE_PHOTOS", count: 1 }];
    const reply = compose(plan({ kind: "SUMMARY", studyIds: [A], askMore: false }, { notices }), { delegated: [medical, human] })!;
    const at = (text: string) => reply.body.indexOf(text);
    expect(at(DRAFT_TEXTS.medical_unavailable)).toBeGreaterThanOrEqual(0);
    expect(at(DRAFT_TEXTS.medical_unavailable)).toBeLessThan(at(DRAFT_TEXTS.handoff_confirmed));
    expect(at(DRAFT_TEXTS.handoff_confirmed)).toBeLessThan(at(QUOTE_TEXTS.resend));
    expect(at(QUOTE_TEXTS.resend)).toBeLessThan(at(QUOTE_TEXTS.duplicate_image));
    expect(at(QUOTE_TEXTS.duplicate_image)).toBeLessThan(at(QUOTE_TEXTS.added_text));
  });

  it("aviso médico + atención humana + cotización: las TRES cosas salen, cada una una vez, y la cotización manda sobre lo descartable", () => {
    const quote = { body: "COTIZACION-ARMADA" };
    const reply = compose(plan({ kind: "QUOTE", studyIds: [A], closeBy: "INTENT" }), { quote, delegated: [medical, human] })!;
    expect(reply.body).toBe([DRAFT_TEXTS.medical_unavailable, DRAFT_TEXTS.handoff_confirmed, "COTIZACION-ARMADA"].join("\n\n"));
    expect(reply).toMatchObject({ result: "quoted", stale: "NONE" });
  });

  it("una derivación a una persona ya registrada (stale NONE) no se descarta por obsoleta aunque lo demás sea conversación", () => {
    expect(compose(plan({ kind: "SUMMARY", studyIds: [A], askMore: true }), { delegated: [human] })!.stale).toBe("NONE");
    expect(compose(plan({ kind: "SUMMARY", studyIds: [A], askMore: true }), { delegated: [medical] })!.stale).toBe("NEWER_TURN");
  });

  it("solo seguridad (sin bloque principal): sale el aviso y nada genérico", () => {
    const reply = compose(plan({ kind: "NONE", reason: "HANDLED_ELSEWHERE" }), { delegated: [medical] })!;
    expect(reply.body).toBe(DRAFT_TEXTS.medical_unavailable);
    expect(reply.body).not.toContain(DRAFT_TEXTS.fallback);
  });

  it("un error técnico se conserva junto a lo demás y marca el estado FAILED; solo, sale como «technical_issue»", () => {
    const technical: Notice[] = [{ kind: "TECHNICAL_ERROR", count: 2 }];
    const withQuote = compose(plan({ kind: "QUOTE", studyIds: [A], closeBy: "INTENT" }, { notices: technical }), { quote: { body: "COTIZACION" } })!;
    expect(withQuote.body.split("\n\n")).toEqual([TECHNICAL, "COTIZACION"]);
    expect(withQuote).toMatchObject({ result: "quoted", processingStatus: "FAILED" });
    const alone = compose(plan({ kind: "NONE", reason: "HANDLED_ELSEWHERE" }, { notices: technical }))!;
    expect(alone).toMatchObject({ body: TECHNICAL, result: "technical_issue", processingStatus: "FAILED", stale: "NEWER_TURN" });
  });

  it("los estudios que el catálogo no tiene se avisan, sin repetir lo que escribió el paciente más allá de la mención limpia", () => {
    const reply = compose(plan({ kind: "NONE", reason: "HANDLED_ELSEWHERE" }, { notices: [{ kind: "STUDIES_NOT_IN_CATALOG", mentions: ["pet scan"] }] }))!;
    expect(reply.body).toContain("No encontré en nuestro catálogo:");
    expect(reply.body).toContain("pet scan");
  });

  it("solicitud llena: avisa", () => {
    expect(bodyOf(compose(plan({ kind: "NONE", reason: "HANDLED_ELSEWHERE" }, { notices: [{ kind: "SESSION_FULL" }] })))).toBe(QUOTE_TEXTS.full);
  });

  it("sin nada que decir (ni seguridad, ni avisos, ni bloque principal) no hay mensaje", () => {
    expect(compose(plan({ kind: "NONE", reason: "NOTHING_TO_SAY" }))).toBeUndefined();
  });

  it("jamás aparece un id de lab_tests ni nada del paciente: solo nombres del catálogo", () => {
    const reply = compose(plan({ kind: "CLARIFY", studyIds: [A], questions: [{ kind: "OPTIONS", candidateIds: G1, remainingGroups: 0, invalidChoice: false }, { kind: "NAME", mentions: ["secreto-del-paciente"] }] }))!;
    expect(reply.body).not.toMatch(/0000-4000|secreto-del-paciente/);
  });
});

describe("textos fijos de la política de lote", () => {
  it("el texto de «no cotizar» es seguro: sin cifras, moneda, promesas ni menciones a personas", () => {
    expect(() => assertSafeBatchTexts()).not.toThrow();
    for (const bad of ["Te cotizo por Bs 5", "Una persona te llamará", "Es gratis", "Total 100"]) expect(() => assertSafeBatchTexts({ declined: bad })).toThrow(UnsafeBatchTextError);
    expect(() => assertSafeBatchTexts({ declined: "  " })).toThrow(UnsafeBatchTextError);
  });
});

describe("de punta a punta con la política: cualquier plan produce un mensaje coherente", () => {
  it("el plan que sale de la política siempre se puede componer (salvo QUOTE, que exige la cotización armada)", () => {
    const u = (over: Partial<Record<string, unknown>> = {}) => ({
      groups: [], commands: [], safety: { medical: [], humanRequest: [], medicalSplit: false, humanRequestSplit: false, splitFragmentIds: [] },
      delegated: { questions: [], greetings: [], social: [], ignored: [], talk: [] },
      studies: { matchedIds: [], ambiguous: [], unclear: [], notFound: [], interpreted: [], repeated: 0, invalidChoices: 0 },
      request: { studyIds: [], pendingGroups: [], unresolved: 0, uncertain: false, unreadable: 0 }, item: undefined, intent: "NONE", intentSource: "NONE",
      negatedFragmentIds: [], negationDoubts: [], modelWouldHelp: { studies: false, intent: false }, cancelled: false, sessionWasOpen: false, confirmSuperseded: false, model: "OFF", ...over
    });
    const requestOf = (studyIds: string[], pendingGroups: string[][] = [], unresolved = 0) => ({ studyIds, pendingGroups, unresolved, uncertain: false, unreadable: 0 });
    const cases = [
      u({ intent: "QUOTE", request: requestOf([A, B]) }), u({ request: requestOf([A]) }), u({ intent: "QUOTE", request: requestOf([A], [G1]) }), u({ intent: "QUOTE", request: requestOf([A], [], 1) }),
      u({ intent: "CANCEL", cancelled: true, sessionWasOpen: true }), u({ intent: "DECLINE", request: requestOf([A]) }), u({ intent: "CONFIRM", confirmedBy: "FINALIZE" }), u({ delegated: { questions: [], greetings: ["g"], social: [], ignored: [], talk: [] } })
    ];
    for (const understanding of cases) {
      const p = decideBatch({ understanding: understanding as never });
      const reply = compose(p, p.core.kind === "QUOTE" ? { quote: { body: "COTIZACION" } } : {});
      if (p.core.kind === "QUOTE") expect(reply?.result).toBe("quoted");
      else expect(reply === undefined || reply.body.trim().length > 0).toBe(true);
      // ningún mensaje repite dos veces el mismo bloque fijo
      for (const fixed of [QUOTE_TEXTS.confirm_done, QUOTE_TEXTS.added_text, QUOTE_TEXTS.ask_option_intro, DRAFT_TEXTS.send_recipe, DRAFT_TEXTS.fallback, DRAFT_TEXTS.greeting]) expect((reply?.body.split(fixed).length ?? 1) - 1).toBeLessThanOrEqual(1);
    }
  });
});
