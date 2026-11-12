import { describe, expect, it } from "vitest";
import { decideBatch, type Core, type PhotoOutcome, type PolicyInput, type ReplyPlan } from "../src/batch-policy.js";
import { EMPTY_SESSION, understandBatch, type BatchFragment, type BatchIntent, type BatchUnderstanding } from "../src/batch-understanding.js";
import { normalizeStudyKey } from "../src/consensus.js";
import type { CatalogStudy } from "../src/types.js";

// Política de decisión de un lote (Fase 1; función pura). Se prueba de tres formas: una tabla de decisiones explícita, invariantes comprobados sobre TODA la cuadrícula de situaciones posibles, y la
// invariancia de punta a punta (comprensión + política) ante la fragmentación del mensaje y la inserción de mensajes de seguridad.

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const G1 = ["00000000-0000-4000-8000-000000000007", "00000000-0000-4000-8000-000000000008"];
const G2 = ["00000000-0000-4000-8000-000000000009", "00000000-0000-4000-8000-00000000000a"];

type Overrides = {
  intent?: BatchIntent;
  confirmedBy?: "FINALIZE" | "YES";
  studyIds?: string[];
  pendingGroups?: string[][];
  unresolved?: number;
  uncertain?: boolean;
  unreadable?: number;
  invalidChoices?: number;
  notFound?: string[];
  medical?: boolean;
  human?: boolean;
  medicalSplit?: boolean;
  questions?: string[];
  greetings?: string[];
  talk?: string[];
  social?: string[];
  cancelled?: boolean;
  sessionWasOpen?: boolean;
  confirmSuperseded?: boolean;
  negationDoubts?: BatchUnderstanding["negationDoubts"];
  item?: BatchUnderstanding["item"];
};

function understanding(o: Overrides = {}): BatchUnderstanding {
  return {
    groups: [],
    commands: [],
    safety: { medical: o.medical ? ["m-med"] : [], humanRequest: o.human ? ["m-human"] : [], medicalSplit: o.medicalSplit === true, humanRequestSplit: false, splitFragmentIds: o.medicalSplit ? ["x1", "x2"] : [] },
    delegated: { questions: o.questions ?? [], greetings: o.greetings ?? [], social: o.social ?? [], ignored: [], talk: o.talk ?? [] },
    studies: { matchedIds: [], ambiguous: [], unclear: o.unresolved ? Array.from({ length: o.unresolved }, (_, i) => `mencion ${i}`) : [], notFound: o.notFound ?? [], interpreted: [], repeated: 0, invalidChoices: o.invalidChoices ?? 0 },
    request: { studyIds: o.studyIds ?? [], pendingGroups: o.pendingGroups ?? [], unresolved: o.unresolved ?? 0, uncertain: o.uncertain ?? false, unreadable: o.unreadable ?? 0 },
    item: o.item,
    intent: o.intent ?? "NONE",
    intentSource: o.intent && o.intent !== "NONE" ? "LEXICON" : "NONE",
    ...(o.confirmedBy ? { confirmedBy: o.confirmedBy } : {}),
    negatedFragmentIds: [],
    negationDoubts: o.negationDoubts ?? [],
    modelWouldHelp: { studies: false, intent: false },
    cancelled: o.cancelled ?? false,
    sessionWasOpen: o.sessionWasOpen ?? false,
    confirmSuperseded: o.confirmSuperseded ?? false,
    model: "OFF"
  };
}
const plan = (o: Overrides = {}, extra: Omit<PolicyInput, "understanding"> = {}): ReplyPlan => decideBatch({ understanding: understanding(o), ...extra });
const photo = (status: PhotoOutcome["status"], studyIds: string[] = []): PhotoOutcome => ({ status, studyIds });

describe("tabla de decisiones", () => {
  it("INTENCIÓN CLARA de cotizar + todo resuelto -> cotiza directamente, sin pedir otra confirmación", () => {
    expect(plan({ intent: "QUOTE", studyIds: [A, B] }).core).toEqual({ kind: "QUOTE", studyIds: [A, B], closeBy: "INTENT" });
    expect(plan({ intent: "QUOTE", studyIds: [A] }).reasons).toContain("QUOTE_BY_INTENT");
  });

  it("confirmar («listo» o «sí») con todo resuelto -> cotiza, y recuerda cómo se confirmó", () => {
    expect(plan({ intent: "CONFIRM", confirmedBy: "FINALIZE", studyIds: [A] }).core).toEqual({ kind: "QUOTE", studyIds: [A], closeBy: "FINALIZE" });
    expect(plan({ intent: "CONFIRM", confirmedBy: "YES", studyIds: [A] }).core).toEqual({ kind: "QUOTE", studyIds: [A], closeBy: "YES" });
  });

  it("estudios sin intención de cotizar -> se anotan y se pregunta si falta algo (no se cotiza por iniciativa)", () => {
    expect(plan({ studyIds: [A, B] }).core).toEqual({ kind: "SUMMARY", studyIds: [A, B], askMore: true });
    expect(plan({ intent: "MORE", studyIds: [A] }).core).toEqual({ kind: "SUMMARY", studyIds: [A], askMore: true });
  });

  it("AMBIGÜEDAD: no se cotiza y se pregunta SOLO por el primer grupo (con cuántos quedan)", () => {
    const p = plan({ intent: "QUOTE", studyIds: [A], pendingGroups: [G1, G2] });
    expect(p.core).toEqual({ kind: "CLARIFY", studyIds: [A], questions: [{ kind: "OPTIONS", candidateIds: G1, remainingGroups: 1, invalidChoice: false }] });
  });

  it("algo sin identificar: se pide solo ese nombre; si además hay una duda de opciones, se preguntan las dos, en ese orden", () => {
    expect(plan({ intent: "QUOTE", studyIds: [A], unresolved: 1 }).core).toMatchObject({ kind: "CLARIFY", questions: [{ kind: "NAME", mentions: ["mencion 0"] }] });
    const both = plan({ intent: "QUOTE", studyIds: [A], unresolved: 1, pendingGroups: [G1] });
    expect((both.core as Extract<Core, { kind: "CLARIFY" }>).questions.map((q) => q.kind)).toEqual(["OPTIONS", "NAME"]);
  });

  it("un número inválido repite la pregunta de opciones señalándolo", () => {
    const p = plan({ intent: "QUOTE", studyIds: [A], pendingGroups: [G1], invalidChoices: 1 });
    expect(p.core).toMatchObject({ kind: "CLARIFY", questions: [{ kind: "OPTIONS", invalidChoice: true }] });
  });

  it("«listo» con dudas sin aclarar cierra a REVISIÓN (nunca cotiza a medias); «sí» o la intención las preguntan", () => {
    const doubt = { studyIds: [A], pendingGroups: [G1], unresolved: 1, uncertain: true };
    expect(plan({ intent: "CONFIRM", confirmedBy: "FINALIZE", ...doubt }).core).toEqual({ kind: "REVIEW", studyIds: [A], reasons: ["AMBIGUOUS_STUDY", "UNRESOLVED_TEXT", "ENGINE_PARTIAL"] });
    expect(plan({ intent: "CONFIRM", confirmedBy: "YES", ...doubt }).core.kind).toBe("CLARIFY");
    expect(plan({ intent: "QUOTE", ...doubt }).core.kind).toBe("CLARIFY");
  });

  it("foto ilegible: no se cotiza ni «listo» la manda a revisión; se avisa que se reenvíe y se resume lo anotado", () => {
    for (const intent of ["QUOTE", "CONFIRM"] as const) {
      const p = plan({ intent, ...(intent === "CONFIRM" ? { confirmedBy: "FINALIZE" as const } : {}), studyIds: [A] }, { photos: [photo("UNREADABLE")] });
      expect(p.core).toEqual({ kind: "SUMMARY", studyIds: [A], askMore: false });
      expect(p.notices).toEqual([{ kind: "UNREADABLE_PHOTOS", count: 1 }]);
    }
    expect(plan({ intent: "QUOTE", studyIds: [A], unreadable: 1 }).core.kind).toBe("SUMMARY");
  });

  it("una foto que falló técnicamente se avisa como error y también impide cotizar", () => {
    const p = plan({ intent: "QUOTE", studyIds: [A] }, { photos: [photo("FAILED")] });
    expect(p.notices).toEqual([{ kind: "TECHNICAL_ERROR", count: 1 }]);
    expect(p.core.kind).toBe("SUMMARY");
  });

  it("FOTOS: una foto resuelta suma sus estudios y, con intención de cotizar, se cotiza todo junto; una repetida solo se avisa", () => {
    const p = plan({ intent: "QUOTE", studyIds: [A] }, { photos: [photo("RESOLVED", [B, C]), photo("DUPLICATE")] });
    expect(p.core).toEqual({ kind: "QUOTE", studyIds: [A, B, C], closeBy: "INTENT" });
    expect(p.notices).toEqual([{ kind: "DUPLICATE_PHOTOS", count: 1 }]);
    expect(plan({}, { photos: [photo("RESOLVED", [B])] }).core).toEqual({ kind: "SUMMARY", studyIds: [B], askMore: true });
    expect(plan({ intent: "QUOTE", studyIds: [] }, { photos: [photo("UNCERTAIN", [B])] }).core).toEqual({ kind: "SUMMARY", studyIds: [B], askMore: false });
  });

  it("una foto de resultado parcial no se cotiza; con «listo» va a revisión por motor parcial", () => {
    const p = plan({ intent: "CONFIRM", confirmedBy: "FINALIZE", studyIds: [] }, { photos: [photo("UNCERTAIN", [B])] });
    expect(p.core).toEqual({ kind: "REVIEW", studyIds: [B], reasons: ["ENGINE_PARTIAL"] });
  });

  it("solicitud llena: se avisa", () => {
    expect(plan({ studyIds: [A] }, { sessionFull: true }).notices).toEqual([{ kind: "SESSION_FULL" }]);
    expect(plan({ studyIds: [A] }, { photos: [photo("FULL")] }).notices).toEqual([{ kind: "SESSION_FULL" }]);
  });

  it("estudios que el catálogo no tiene: se avisan cuáles y se cotiza el resto", () => {
    const p = plan({ intent: "QUOTE", studyIds: [A], notFound: ["pet scan"] });
    expect(p.notices).toEqual([{ kind: "STUDIES_NOT_IN_CATALOG", mentions: ["pet scan"] }]);
    expect(p.core.kind).toBe("QUOTE");
    expect(plan({ intent: "QUOTE", notFound: ["pet scan"] }).core).toEqual({ kind: "PROMPT", reason: "QUOTE_WITHOUT_STUDIES" });
    expect(plan({ notFound: ["pet scan"] }).core).toEqual({ kind: "NONE", reason: "HANDLED_ELSEWHERE" });
  });

  it("pedir NO cotizar se respeta: no cotiza ni insiste, conserva lo anotado y no pregunta por dudas que ya no importan", () => {
    expect(plan({ intent: "DECLINE", studyIds: [A, B] }).core).toEqual({ kind: "DECLINED", studyIds: [A, B] });
    expect(plan({ intent: "DECLINE", studyIds: [A], pendingGroups: [G1], unresolved: 1 }).core).toEqual({ kind: "DECLINED", studyIds: [A] });
    expect(plan({ intent: "DECLINE" }).core).toEqual({ kind: "DECLINED", studyIds: [] });
    expect(plan({ intent: "DECLINE", studyIds: [A], medical: true }).safety.map((b) => b.kind)).toEqual(["MEDICAL"]);
    expect(plan({ intent: "DECLINE", studyIds: [A] }).reasons).toContain("DECLINED");
  });

  it("cancelar nunca cotiza: cancela si había algo, avisa si no, y pide descartar la solicitud abierta", () => {
    expect(plan({ intent: "CANCEL", cancelled: true, sessionWasOpen: true }).core).toEqual({ kind: "CANCELLED" });
    expect(plan({ intent: "CANCEL", cancelled: true, sessionWasOpen: true }).cancelPrevious).toBe(true);
    expect(plan({ intent: "CANCEL", cancelled: true }).core).toEqual({ kind: "NOTHING_TO_CANCEL" });
    expect(plan({ intent: "CANCEL", cancelled: true, studyIds: [A], sessionWasOpen: true }).core.kind).toBe("CANCELLED");
    // cancelar y luego pedir otra cosa: la solicitud nueva se decide aparte
    const restart = plan({ intent: "QUOTE", cancelled: true, sessionWasOpen: true, studyIds: [B] });
    expect(restart.cancelPrevious).toBe(true);
    expect(restart.core).toEqual({ kind: "QUOTE", studyIds: [B], closeBy: "INTENT" });
  });

  it("sin estudios: «listo» vacío se explica (o se calla si fue un acuse tras una cotización reciente); querer cotizar pide los estudios", () => {
    expect(plan({ intent: "CONFIRM", confirmedBy: "FINALIZE" }).core).toEqual({ kind: "EMPTY_REQUEST" });
    expect(plan({ intent: "CONFIRM", confirmedBy: "FINALIZE" }, { recentQuote: true }).core).toEqual({ kind: "NONE", reason: "ACK_AFTER_QUOTE" });
    expect(plan({ intent: "QUOTE" }).core).toEqual({ kind: "PROMPT", reason: "QUOTE_WITHOUT_STUDIES" });
  });

  it("lo genérico es una decisión explícita y solo cuando no hay nada más concreto", () => {
    expect(plan({ greetings: ["g"] }).core).toEqual({ kind: "PROMPT", reason: "GREETING" });
    expect(plan({ talk: ["t"] }).core).toEqual({ kind: "PROMPT", reason: "OTHER" });
    expect(plan({ greetings: ["g"], talk: ["t"] }).core).toEqual({ kind: "PROMPT", reason: "OTHER" });
    expect(plan({ social: ["s"] }).core).toEqual({ kind: "PROMPT", reason: "OTHER" });
    expect(plan({ social: ["s"] }, { silenceSocial: true }).core).toEqual({ kind: "NONE", reason: "SOCIAL" });
    expect(plan({}).core).toEqual({ kind: "NONE", reason: "NOTHING_TO_SAY" });
    // con estudios, o con una pregunta, un aviso o seguridad, el saludo/charla NO produce un genérico
    expect(plan({ greetings: ["g"], studyIds: [A] }).core.kind).toBe("SUMMARY");
    expect(plan({ greetings: ["g"], questions: ["q"] }).core).toEqual({ kind: "NONE", reason: "HANDLED_ELSEWHERE" });
    expect(plan({ talk: ["t"], medical: true }).core).toEqual({ kind: "NONE", reason: "HANDLED_ELSEWHERE" });
  });

  it("preguntas de información: se delegan al manejador de siempre, sin tocar los estudios", () => {
    const p = plan({ intent: "QUOTE", studyIds: [A], questions: ["q1", "q2"] });
    expect(p.delegatedQuestionIds).toEqual(["q1", "q2"]);
    expect(p.core.kind).toBe("QUOTE");
  });

  it("«listo» que no iba al final (llegaron estudios después) no cotiza: queda el resumen", () => {
    const p = plan({ studyIds: [A, B], confirmSuperseded: true });
    expect(p.core).toEqual({ kind: "SUMMARY", studyIds: [A, B], askMore: true });
    expect(p.reasons).toContain("CONFIRM_SUPERSEDED");
  });

  it("el ítem de sesión del lote pasa tal cual al plan", () => {
    const item = { status: "RESOLVED" as const, studyIds: [A], ambiguous: [], unresolved: 0, reasons: [] };
    expect(plan({ studyIds: [A], item }).record).toBe(item);
    expect(plan({}).record).toBeUndefined();
  });
});

describe("seguridad: ni la intención, ni las dudas, ni las fotos, ni lo genérico pueden suprimirla", () => {
  it("lo médico y pedir a una persona van SIEMPRE en el plan, junto a cualquier decisión", () => {
    for (const core of [{ intent: "QUOTE" as const, studyIds: [A] }, { studyIds: [A] }, { intent: "CANCEL" as const, cancelled: true }, { intent: "CONFIRM" as const, confirmedBy: "FINALIZE" as const }, {}]) {
      const p = plan({ ...core, medical: true, human: true });
      expect(p.safety.map((block) => block.kind)).toEqual(["MEDICAL", "HUMAN_REQUEST"]);
      expect(p.safety[0]!.fragmentIds).toEqual(["m-med"]);
      expect(p.reasons).toContain("SAFETY_PRESENT");
    }
  });

  it("una señal médica que solo aparece al leer el lote completo también va en el plan, con los mensajes que la forman", () => {
    const p = plan({ medicalSplit: true, studyIds: [A], intent: "QUOTE" });
    expect(p.safety).toEqual([{ kind: "MEDICAL", fragmentIds: ["x1", "x2"], split: true }]);
    expect(p.core.kind).toBe("QUOTE");
  });

  it("un aviso médico no deja la cotización sin hacer ni la cambia: se atiende la urgencia Y se cotiza", () => {
    const withMedical = plan({ intent: "QUOTE", studyIds: [A, B], medical: true });
    expect(withMedical.core).toEqual(plan({ intent: "QUOTE", studyIds: [A, B] }).core);
  });
});

// ───────────────────────────── cuadrícula exhaustiva ─────────────────────────────

describe("invariantes sobre TODAS las combinaciones de situaciones", () => {
  const intents: BatchIntent[] = ["NONE", "QUOTE", "CONFIRM", "CANCEL", "MORE", "DECLINE"];
  const confirms: Array<"FINALIZE" | "YES" | undefined> = [undefined, "FINALIZE", "YES"];
  const photoSets: PhotoOutcome[][] = [[], [photo("RESOLVED", [B])], [photo("UNREADABLE")], [photo("FAILED")], [photo("DUPLICATE")], [photo("UNCERTAIN", [C])], [photo("FULL")], [photo("RESOLVED", [B]), photo("UNREADABLE")]];
  const bool = [false, true];

  function* grid(): Generator<{ o: Overrides; extra: Omit<PolicyInput, "understanding"> }> {
    for (const intent of intents) for (const confirmedBy of confirms) {
      if (confirmedBy && intent !== "CONFIRM") continue;
      for (const studyIds of [[], [A]]) for (const pendingGroups of [[], [G1], [G1, G2]]) for (const unresolved of [0, 1]) for (const uncertain of bool) for (const unreadable of [0, 1]) {
        // una opción inválida solo existe cuando hay una duda pendiente
        for (const invalidChoices of pendingGroups.length > 0 ? [0, 1] : [0]) for (const photos of photoSets) for (const medical of bool) for (const human of bool) {
          // una sola cosa más por punto: nada, una pregunta de información o charla suelta
          for (const extras of [{}, { questions: ["q"] }, { talk: ["t"] }]) {
            // cancelar: con la sesión abierta o sin nada que cancelar; cualquier otra intención: con o sin una cancelación previa en el lote
            for (const [cancelled, sessionWasOpen] of intent === "CANCEL" ? ([[true, true], [true, false]] as const) : ([[false, false], [true, true]] as const)) {
              yield { o: { intent, confirmedBy, studyIds, pendingGroups, unresolved, uncertain, unreadable, invalidChoices, medical, human, ...extras, cancelled, sessionWasOpen }, extra: { photos } };
            }
          }
        }
      }
    }
  }

  const blockersOf = (o: Overrides, photos: readonly PhotoOutcome[] = []) => ({
    needsAnswer: (o.pendingGroups?.length ?? 0) > 0 || (o.unresolved ?? 0) > 0,
    unreadable: (o.unreadable ?? 0) > 0 || photos.some((p) => p.status === "UNREADABLE" || p.status === "FAILED"),
    uncertain: o.uncertain === true || photos.some((p) => p.status === "UNCERTAIN")
  });
  const studiesOf = (o: Overrides, photos: readonly PhotoOutcome[] = []) => [...new Set([...(o.studyIds ?? []), ...photos.filter((p) => p.status === "RESOLVED" || p.status === "UNCERTAIN").flatMap((p) => [...p.studyIds])])];

  it("recorre la cuadrícula completa y cumple todas las reglas en cada punto", () => {
    let points = 0;
    const seen = new Set<string>();
    // Se acumulan los fallos (con el caso exacto) en vez de afirmar punto por punto: es mucho más rápido y el mensaje dice qué regla y qué situación fallaron.
    const failures: string[] = [];
    let current = "";
    const ok = (condition: boolean, rule: string) => {
      if (!condition && failures.length < 12) failures.push(`${rule} :: ${current}`);
    };
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    for (const { o, extra } of grid()) {
      points++;
      const photos = extra.photos ?? [];
      const p = plan(o, extra);
      const blockers = blockersOf(o, photos);
      const studies = studiesOf(o, photos);
      seen.add(p.core.kind);
      const anyBlocker = blockers.needsAnswer || blockers.unreadable || blockers.uncertain;
      const lazy = () => (current = JSON.stringify({ o, photos: photos.map((x) => x.status) }));
      const check = (condition: boolean, rule: string) => {
        if (!condition) {
          lazy();
          ok(false, rule);
        }
      };

      // la seguridad refleja exactamente lo detectado
      check(p.safety.some((b) => b.kind === "MEDICAL") === (o.medical === true), "seguridad médica refleja lo detectado");
      check(p.safety.some((b) => b.kind === "HUMAN_REQUEST") === (o.human === true), "seguridad de atención humana refleja lo detectado");
      check(p.delegatedQuestionIds.length === (o.questions?.length ?? 0), "las preguntas se delegan tal cual");

      // cotizar solo con intención o confirmación, estudios y NINGUNA duda
      if (p.core.kind === "QUOTE") {
        check(o.intent === "QUOTE" || o.intent === "CONFIRM", "QUOTE solo con intención o confirmación");
        check(studies.length > 0, "QUOTE con estudios");
        check(!anyBlocker, "QUOTE sin dudas");
        check(same(p.core.studyIds, studies) && new Set(p.core.studyIds).size === p.core.studyIds.length, "QUOTE lleva exactamente los estudios de la solicitud, sin repetidos ni inventados");
      }
      // y a la inversa: intención clara + todo resuelto SIEMPRE cotiza (sin confirmaciones de más)
      if ((o.intent === "QUOTE" || o.intent === "CONFIRM") && studies.length > 0 && !anyBlocker) check(p.core.kind === "QUOTE", "intención clara + todo resuelto cotiza directo");
      // cancelar nunca cotiza
      if (o.intent === "CANCEL") check(p.core.kind === "CANCELLED" || p.core.kind === "NOTHING_TO_CANCEL", "cancelar nunca cotiza");
      // pedir NO cotizar se respeta siempre: ni cotiza, ni pregunta, ni manda a revisión
      if (o.intent === "DECLINE") check(p.core.kind === "DECLINED", "pedir no cotizar se respeta");
      if (p.core.kind === "DECLINED") check(o.intent === "DECLINE" && same(p.core.studyIds, studies), "DECLINED solo con la intención de no cotizar y conserva lo anotado");
      // las preguntas son solo las necesarias
      if (p.core.kind === "CLARIFY") {
        const kinds = p.core.questions.map((q) => q.kind);
        check(kinds.length > 0, "CLARIFY tiene preguntas");
        check(kinds.includes("OPTIONS") === ((o.pendingGroups?.length ?? 0) > 0), "pregunta de opciones solo con una duda pendiente");
        check(kinds.includes("NAME") === ((o.unresolved ?? 0) > 0), "pregunta de nombre solo con algo sin identificar");
        check(kinds.filter((k) => k === "OPTIONS").length <= 1, "una sola pregunta de opciones a la vez");
      }
      // revisión solo con «listo», dudas aclarables y nada ilegible
      if (p.core.kind === "REVIEW") {
        check(o.confirmedBy === "FINALIZE", "REVIEW solo con «listo»");
        check(!blockers.unreadable, "REVIEW nunca con fotos ilegibles");
        check(p.core.reasons.length > 0, "REVIEW con motivo");
      }
      // lo genérico solo cuando no hay nada más concreto
      if (p.core.kind === "PROMPT") {
        check(studies.length === 0 || p.core.reason === "OTHER", "PROMPT sin estudios");
        // pedir los estudios cuando se quiere cotizar es concreto y puede ir junto a una respuesta; lo genérico (saludo/charla) solo si no hay nada más
        if (p.core.reason !== "QUOTE_WITHOUT_STUDIES") check(p.safety.length + p.delegatedQuestionIds.length === 0, "lo genérico solo sin nada más concreto");
      }
      // avisos: dependen solo de las fotos y del catálogo
      check(p.notices.some((n) => n.kind === "TECHNICAL_ERROR") === photos.some((x) => x.status === "FAILED"), "aviso de error técnico");
      check(p.notices.some((n) => n.kind === "UNREADABLE_PHOTOS") === photos.some((x) => x.status === "UNREADABLE"), "aviso de foto ilegible");
      check(p.notices.some((n) => n.kind === "DUPLICATE_PHOTOS") === photos.some((x) => x.status === "DUPLICATE"), "aviso de foto repetida");
      // sin precios ni nada que no sea ids y códigos
      if (points % 97 === 0) check(!/price|precio|Bs|total/i.test(JSON.stringify(p)), "el plan no contiene precios");

      // SEGURIDAD MONÓTONA: sumar una señal médica o de atención humana no cambia la decisión de fondo ni lo avisado
      if (!o.medical && !o.human) {
        const withSafety = plan({ ...o, medical: true, human: true }, extra);
        check(same(withSafety.notices, p.notices) && same(withSafety.record, p.record) && withSafety.cancelPrevious === p.cancelPrevious, "la seguridad no cambia avisos, ítem ni cancelación");
        if (p.core.kind !== "PROMPT" && p.core.kind !== "NONE") check(same(withSafety.core, p.core), "la seguridad no cambia la decisión de fondo");
        else check(withSafety.core.kind === "PROMPT" || withSafety.core.kind === "NONE", "la seguridad solo puede cambiar PROMPT/NONE entre sí");
      }
    }
    expect(failures).toEqual([]);
    // la cuadrícula es grande y alcanza todos los tipos de decisión
    expect(points).toBeGreaterThan(50_000);
    expect([...seen].sort()).toEqual(["CANCELLED", "CLARIFY", "DECLINED", "EMPTY_REQUEST", "NONE", "NOTHING_TO_CANCEL", "PROMPT", "QUOTE", "REVIEW", "SUMMARY"]);
  }, 60_000);

  it("es determinista y no modifica lo que recibe", () => {
    const input: PolicyInput = { understanding: understanding({ intent: "QUOTE", studyIds: [A], pendingGroups: [G1], medical: true }), photos: [photo("RESOLVED", [B])] };
    const frozen = JSON.stringify(input);
    const first = decideBatch(input);
    expect(decideBatch(input)).toEqual(first);
    expect(JSON.stringify(input)).toBe(frozen);
  });
});

// ───────────────────────────── de punta a punta: comprensión + política ─────────────────────────────

describe("de punta a punta: la misma solicitud da el mismo plan, sea cual sea la forma de repartirla en mensajes", () => {
  const study = (n: number, name: string, aliases: string[], priceBs: number): CatalogStudy => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active: true });
  const HEMO = "00000000-0000-4000-8000-000000000001";
  const GLU = "00000000-0000-4000-8000-000000000002";
  const catalog = [study(1, "HEMOGRAMA COMPLETO", ["hemograma"], 45), study(2, "GLUCOSA EN AYUNAS", ["glucosa"], 30.5), study(3, "COLESTEROL TOTAL", ["colesterol"], 25), study(4, "TSH", ["tsh"], 80), study(7, "CREATININA SERICA", ["creatinina"], 20), study(8, "CREATININA EN ORINA", ["creatinina"], 22)];
  const fragmentsOf = (messages: readonly string[]): BatchFragment[] => messages.map((text, index) => ({ id: `m${index}`, text }));
  const run = async (messages: readonly string[], extra: Partial<Parameters<typeof understandBatch>[0]> = {}, policy: Omit<PolicyInput, "understanding"> = {}) =>
    decideBatch({ understanding: await understandBatch({ fragments: fragmentsOf(messages), catalog, ...extra }), ...policy });
  // El plan sin los ids de mensaje (cambian según el reparto).
  const shape = (p: ReplyPlan) => JSON.parse(JSON.stringify({ ...p, safety: p.safety.map((b) => ({ kind: b.kind })), delegatedQuestionIds: p.delegatedQuestionIds.length }));

  function* partitions(words: readonly string[]): Generator<string[]> {
    const total = 1 << Math.max(0, words.length - 1);
    for (let mask = 0; mask < total; mask++) {
      const messages: string[] = [];
      let current = [words[0]!];
      for (let index = 1; index < words.length; index++) {
        if (mask & (1 << (index - 1))) {
          messages.push(current.join(" "));
          current = [words[index]!];
        } else current.push(words[index]!);
      }
      messages.push(current.join(" "));
      yield messages;
    }
  }

  const cases: Array<[string, Core["kind"], string]> = [
    ["quiero cotizar hemograma completo y glucosa", "QUOTE", "intención clara + todo resuelto: cotiza directo"],
    ["hemograma completo y glucosa en ayunas", "SUMMARY", "estudios sin intención: resumen y «¿algo más?»"],
    ["quiero cotizar creatinina", "CLARIFY", "ambigüedad: solo la opción"],
    ["quiero cotizar creatinina en orina", "QUOTE", "la unión aclara la ambigüedad y cotiza"],
    ["necesito colesterol total y tsh", "QUOTE", "otra forma de pedir"],
    ["precio de la glucosa en ayunas", "QUOTE", "pregunta de precio"]
  ];

  it.each(cases)("«%s» -> %s (%s) con TODAS las particiones", async (sentence, expectedCore) => {
    const reference = await run([sentence]);
    expect(reference.core.kind).toBe(expectedCore);
    let count = 0;
    for (const messages of partitions(sentence.split(" "))) {
      count++;
      expect(shape(await run(messages)), JSON.stringify(messages)).toEqual(shape(reference));
    }
    expect(count).toBe(2 ** (sentence.split(" ").length - 1));
  });

  it("EL CASO REAL de punta a punta: «quiero cotizar» + «hemograma» + «completo» cotiza directamente un solo estudio, sin acuses ni instrucciones genéricas", async () => {
    const p = await run(["quiero cotizar", "hemograma", "completo"]);
    expect(p.core).toEqual({ kind: "QUOTE", studyIds: [HEMO], closeBy: "INTENT" });
    expect(p.safety).toEqual([]);
    expect(p.notices).toEqual([]);
    expect(p.record).toMatchObject({ status: "RESOLVED", studyIds: [HEMO] });
  });

  it("«quiero cotizar» + «hemograma» + «y glucosa» (el caso del acuse con confirmación innecesaria): cotiza directo los dos", async () => {
    const p = await run(["Quiero cotizar", "Hemograma completo", "Y glucosa"]);
    expect(p.core.kind).toBe("QUOTE");
    expect([...(p.core as Extract<Core, { kind: "QUOTE" }>).studyIds].sort()).toEqual([HEMO, GLU].sort());
  });

  it("«listo» en el mismo lote cotiza; estudios sin intención ni «listo» solo se anotan", async () => {
    expect((await run(["hemograma", "completo", "listo"])).core).toEqual({ kind: "QUOTE", studyIds: [HEMO], closeBy: "FINALIZE" });
    expect((await run(["hemograma", "completo"])).core).toEqual({ kind: "SUMMARY", studyIds: [HEMO], askMore: true });
    expect((await run(["hemograma", "completo", "sí"])).core).toEqual({ kind: "QUOTE", studyIds: [HEMO], closeBy: "YES" });
  });

  it("un estudio que el catálogo no tiene NO se descarta en silencio: se cotiza lo identificado y se avisa cuál falta", async () => {
    const p = await run(["quiero cotizar", "hemograma", "xhq"]);
    expect(p.core).toMatchObject({ kind: "QUOTE", studyIds: [HEMO] });
    expect(p.notices).toContainEqual({ kind: "STUDIES_NOT_IN_CATALOG", mentions: ["xhq"] });
  });

  it("SESIÓN ACTIVA: lo anotado antes se suma; una duda de la sesión que el lote aclara deja de preguntarse", async () => {
    const session = { ...EMPTY_SESSION, open: true, studyIds: [GLU], pendingGroups: [["00000000-0000-4000-8000-000000000007", "00000000-0000-4000-8000-000000000008"]] };
    const open = await run(["quiero cotizar", "hemograma"], { session });
    expect(open.core.kind).toBe("CLARIFY");
    const cleared = await run(["quiero cotizar", "creatinina", "en orina"], { session });
    expect(cleared.core.kind).toBe("QUOTE");
    expect([...(cleared.core as Extract<Core, { kind: "QUOTE" }>).studyIds].sort()).toEqual([GLU, "00000000-0000-4000-8000-000000000008"].sort());
  });

  it("SEGURIDAD MONÓTONA de punta a punta: insertar un mensaje médico o de atención humana en cualquier posición no cambia la decisión de fondo; solo agrega su señal", async () => {
    for (const base of [["quiero cotizar", "hemograma", "completo"], ["hemograma", "completo"], ["quiero cotizar creatinina"], ["quiero cotizar", "hemograma", "xhq"]]) {
      const clean = await run(base);
      for (const extra of ["me duele mucho el pecho", "tengo fiebre", "quiero hablar con una persona"]) {
        for (let position = 0; position <= base.length; position++) {
          const messages = [...base.slice(0, position), extra, ...base.slice(position)];
          const got = await run(messages);
          expect(got.core, JSON.stringify(messages)).toEqual(clean.core);
          expect(got.notices, JSON.stringify(messages)).toEqual(clean.notices);
          expect(got.safety.length, JSON.stringify(messages)).toBe(1);
        }
      }
    }
  });

  it("un mensaje de atención humana + una cotización clara: se conservan las dos cosas", async () => {
    const p = await run(["quiero cotizar hemograma", "quiero hablar con una persona"]);
    expect(p.safety.map((b) => b.kind)).toEqual(["HUMAN_REQUEST"]);
    expect(p.core.kind).toBe("QUOTE");
  });

  it("cortesías sueltas: silencio solo si la atención selectiva está encendida", async () => {
    const social = (text: string) => text === "gracias" || text === "ok";
    expect((await run(["gracias", "ok"], { isSocial: social }, { silenceSocial: true })).core).toEqual({ kind: "NONE", reason: "SOCIAL" });
    expect((await run(["gracias", "ok"], { isSocial: social })).core).toEqual({ kind: "PROMPT", reason: "OTHER" });
    // con estudios, la cortesía no cambia nada
    expect((await run(["hemograma", "completo", "gracias"], { isSocial: social }, { silenceSocial: true })).core.kind).toBe("SUMMARY");
  });

  it("solo seguridad, solo preguntas o solo charla: ni cotiza ni inventa estudios; lo genérico únicamente si no hay nada más", async () => {
    expect((await run(["me duele el pecho"])).core).toEqual({ kind: "NONE", reason: "HANDLED_ELSEWHERE" });
    expect((await run(["¿a qué hora abren?"])).core).toEqual({ kind: "NONE", reason: "HANDLED_ELSEWHERE" });
    expect((await run(["hola"])).core).toEqual({ kind: "PROMPT", reason: "GREETING" });
    expect((await run(["quiero cotizar"])).core).toEqual({ kind: "PROMPT", reason: "QUOTE_WITHOUT_STUDIES" });
    expect((await run(["hola", "quiero cotizar"])).core).toEqual({ kind: "PROMPT", reason: "QUOTE_WITHOUT_STUDIES" });
  });

  it("OpenAI de apoyo de punta a punta: entiende una intención natural, pero no puede cotizar lo que el catálogo no confirma", async () => {
    const wants = async () => ({ isQuoteRequest: true, wantsQuote: true, matched: [], ambiguous: [], unclear: [], notFound: [] });
    const natural = await run(["hemograma", "completo", "agradecería el valor total"], { interpret: wants });
    expect(natural.core).toEqual({ kind: "QUOTE", studyIds: [HEMO], closeBy: "INTENT" });
    // el modelo quiere cotizar y hay un nombre que el catálogo no tiene: se cotiza lo identificado y se avisa cuál falta
    const unresolved = await run(["hemograma", "xhq", "agradecería el valor total"], { interpret: wants });
    expect(unresolved.core.kind).toBe("QUOTE");
    expect(unresolved.notices).toContainEqual({ kind: "STUDIES_NOT_IN_CATALOG", mentions: ["xhq"] });
    // el modelo inventa un estudio: se ignora
    const invented = async () => ({ isQuoteRequest: true, wantsQuote: true, matched: [{ study: { id: "00000000-0000-4000-8000-0000000000ff" }, mention: "x", exact: true }], ambiguous: [], unclear: [], notFound: [] });
    const withInvented = await run(["quiero cotizar", "xhq"], { interpret: invented as never });
    expect(withInvented.core.kind).not.toBe("QUOTE");
    expect(JSON.stringify(withInvented)).not.toContain("0000000000ff");
  });
});
