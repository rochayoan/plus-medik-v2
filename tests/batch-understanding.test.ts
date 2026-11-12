import { describe, expect, it, vi } from "vitest";
import { normalizeStudyKey } from "../src/consensus.js";
import { EMPTY_SESSION, understandBatch, type BatchFragment, type BatchUnderstanding, type SessionContext } from "../src/batch-understanding.js";
import { decideBatch } from "../src/batch-policy.js";
import type { InterpretedStudyRequest, StudyInterpreter } from "../src/quote-session.js";
import type { CatalogStudy } from "../src/types.js";

// Comprensión global de un lote de Kapso (Fase 1; función pura, sin conectar al webhook). Lo central: el mismo pedido repartido de CUALQUIER forma en mensajes se entiende igual (invariancia),
// la ambigüedad nunca se adivina, y la seguridad no se pierde ni llega al modelo.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const study = (n: number, name: string, aliases: string[], priceBs: number): CatalogStudy => ({ id: uuid(n), code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active: true });
const HEMOGRAMA = uuid(1);
const GLUCOSA = uuid(2);
const COLESTEROL = uuid(3);
const TSH = uuid(4);
const CREA_SERICA = uuid(7);
const CREA_ORINA = uuid(8);
const catalog: CatalogStudy[] = [
  study(1, "HEMOGRAMA COMPLETO", ["hemograma"], 45),
  study(2, "GLUCOSA EN AYUNAS", ["glucosa"], 30.5),
  study(3, "COLESTEROL TOTAL", ["colesterol"], 25),
  study(4, "TSH", ["tsh"], 80),
  study(7, "CREATININA SERICA", ["creatinina"], 20),
  study(8, "CREATININA EN ORINA", ["creatinina"], 22)
];

const fragmentsOf = (messages: readonly string[]): BatchFragment[] => messages.map((text, index) => ({ id: `m${index}`, text }));
const understand = (messages: readonly string[], extra: Partial<Parameters<typeof understandBatch>[0]> = {}) => understandBatch({ fragments: fragmentsOf(messages), catalog, ...extra });

// Todas las formas de repartir una lista de palabras en mensajes contiguos (2^(n-1)).
function partitions(words: readonly string[]): string[][] {
  const out: string[][] = [];
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
    out.push(messages);
  }
  return out;
}

// Lo que NO puede depender de cómo se repartió el texto (los ids de mensaje sí cambian).
const sorted = (values: readonly string[]) => [...values].sort();
const shape = (u: BatchUnderstanding) => ({
  matched: sorted(u.studies.matchedIds),
  ambiguous: u.studies.ambiguous.map((group) => sorted(group.candidateIds).join("|")).sort(),
  unclear: u.studies.unclear.length,
  requestStudies: sorted(u.request.studyIds),
  pending: u.request.pendingGroups.map((group) => sorted(group).join("|")).sort(),
  unresolved: u.request.unresolved,
  intent: u.intent,
  intentSource: u.intentSource,
  item: u.item && { status: u.item.status, studyIds: sorted(u.item.studyIds), ambiguous: u.item.ambiguous.map((group) => sorted(group).join("|")).sort(), unresolved: u.item.unresolved },
  medical: u.safety.medical.length > 0 || u.safety.medicalSplit,
  human: u.safety.humanRequest.length > 0 || u.safety.humanRequestSplit
});

describe("invariancia: el mismo pedido repartido de cualquier forma en mensajes se entiende igual", () => {
  const sentences: Array<[string, string, ReturnType<typeof shape>["matched"]]> = [
    ["quiero cotizar hemograma completo y glucosa", "pedido con intención repartido en palabras sueltas", [HEMOGRAMA, GLUCOSA].sort()],
    ["glucosa en ayunas y tsh", "estudio de varias palabras + otro", [GLUCOSA, TSH].sort()],
    ["colesterol total y hemograma completo y tsh", "tres estudios, dos de ellos con nombre largo", [COLESTEROL, HEMOGRAMA, TSH].sort()],
    ["necesito colesterol total", "pedido corto", [COLESTEROL]],
    ["creatinina en orina", "la unión aclara una ambigüedad", [CREA_ORINA]],
    ["hemograma completo", "solo el nombre", [HEMOGRAMA]]
  ];

  it.each(sentences)("«%s» (%s): TODAS las particiones dan la misma comprensión", async (sentence, _label, expectedMatched) => {
    const words = sentence.split(" ");
    const all = partitions(words);
    const reference = shape(await understand([sentence]));
    expect(reference.matched, "referencia").toEqual(expectedMatched);
    expect(reference.unclear, "referencia").toBe(0);
    for (const messages of all) {
      const got = shape(await understand(messages));
      expect(got, JSON.stringify(messages)).toEqual(reference);
    }
    expect(all.length).toBe(2 ** (words.length - 1));
  });

  it("la intención de cotizar también es invariante: «cotizar» en cualquier mensaje del lote", async () => {
    for (const messages of partitions("quiero cotizar hemograma completo y glucosa".split(" "))) {
      const u = await understand(messages);
      expect(u.intent, JSON.stringify(messages)).toBe("QUOTE");
      expect(u.intentSource).toBe("LEXICON");
    }
    for (const messages of partitions("glucosa en ayunas y tsh".split(" "))) expect((await understand(messages)).intent, JSON.stringify(messages)).toBe("NONE");
  });

  it("el caso real: «quiero cotizar» + «hemograma» + «completo» es UN estudio resuelto, sin nada sin resolver", async () => {
    const u = await understand(["quiero cotizar", "hemograma", "completo"]);
    expect(u.studies.matchedIds).toEqual([HEMOGRAMA]);
    expect(u.studies.unclear).toEqual([]);
    expect(u.request.unresolved).toBe(0);
    expect(u.intent).toBe("QUOTE");
    expect(u.item).toMatchObject({ status: "RESOLVED", studyIds: [HEMOGRAMA], unresolved: 0 });
    // «hemograma» y «completo» forman un solo grupo; «quiero cotizar» queda aparte
    expect(u.groups.map((group) => group.fragmentIds)).toEqual([["m0"], ["m1", "m2"]]);
  });

  it("no une lo que no gana nada al unirse: dos estudios sueltos siguen siendo dos grupos", async () => {
    const u = await understand(["glucosa", "tsh"]);
    expect(u.groups.map((group) => group.fragmentIds)).toEqual([["m0"], ["m1"]]);
    expect(sorted(u.studies.matchedIds)).toEqual(sorted([GLUCOSA, TSH]));
  });

  it("una foto (o cualquier mensaje que no es texto) en medio corta la reconstrucción", async () => {
    const withBreak = await understandBatch({ catalog, fragments: [{ id: "a", text: "hemograma" }, { id: "b", text: "completo", breakBefore: true }] });
    expect(withBreak.groups.map((group) => group.fragmentIds)).toEqual([["a"], ["b"]]);
    const without = await understandBatch({ catalog, fragments: [{ id: "a", text: "hemograma" }, { id: "b", text: "completo" }] });
    expect(without.groups.map((group) => group.fragmentIds)).toEqual([["a", "b"]]);
  });
});

describe("ambigüedad: nunca se adivina y solo se pregunta lo necesario", () => {
  it("«creatinina» sola es ambigua entre dos estudios del catálogo: queda una duda con sus opciones, ningún estudio elegido", async () => {
    const u = await understand(["creatinina"]);
    expect(u.studies.matchedIds).toEqual([]);
    expect(u.request.pendingGroups.map(sorted)).toEqual([sorted([CREA_SERICA, CREA_ORINA])]);
    expect(u.item).toMatchObject({ status: "AMBIGUOUS", studyIds: [] });
  });

  it("el mismo lote que la aclara («creatinina» + «en orina») deja un solo estudio y ninguna duda", async () => {
    const u = await understand(["creatinina", "en orina"]);
    expect(u.studies.matchedIds).toEqual([CREA_ORINA]);
    expect(u.request.pendingGroups).toEqual([]);
  });

  it("una duda de la sesión abierta se aclara si este lote trae una de sus opciones identificada con certeza", async () => {
    const session: SessionContext = { ...EMPTY_SESSION, open: true, pendingGroups: [[CREA_SERICA, CREA_ORINA]] };
    const cleared = await understand(["creatinina en orina"], { session });
    expect(cleared.request.pendingGroups).toEqual([]);
    expect(cleared.request.studyIds).toEqual([CREA_ORINA]);
    const notCleared = await understand(["glucosa"], { session });
    expect(notCleared.request.pendingGroups.map(sorted)).toEqual([sorted([CREA_SERICA, CREA_ORINA])]);
    expect(sorted(notCleared.request.studyIds)).toEqual([GLUCOSA]);
  });

  it("un número válido («2») aclara el primer grupo pendiente con la opción de esa posición; uno inválido no elige nada", async () => {
    const session: SessionContext = { ...EMPTY_SESSION, open: true, pendingGroups: [[CREA_SERICA, CREA_ORINA]] };
    const options = [CREA_SERICA, CREA_ORINA].sort();
    const chosen = await understand(["2"], { session });
    expect(chosen.studies.matchedIds).toEqual([options[1]]);
    expect(chosen.request.pendingGroups).toEqual([]);
    const invalid = await understand(["7"], { session });
    expect(invalid.studies.invalidChoices).toBe(1);
    expect(invalid.request.pendingGroups).toHaveLength(1);
    expect(invalid.studies.matchedIds).toEqual([]);
  });

  it("más de un estudio ambiguo en el lote: cada duda se conserva por separado", async () => {
    const extra: CatalogStudy[] = [...catalog, study(9, "PROTEINAS TOTALES", ["proteinas"], 10), study(10, "PROTEINAS EN ORINA", ["proteinas"], 12)];
    const u = await understandBatch({ catalog: extra, fragments: fragmentsOf(["creatinina", "proteinas"]) });
    expect(u.request.pendingGroups).toHaveLength(2);
    expect(u.studies.matchedIds).toEqual([]);
  });

  it("una sigla que el catálogo no tiene se dice como «no está en el catálogo» y NO bloquea el resto; la conversación suelta tampoco", async () => {
    const sigla = await understand(["hemograma", "xhq"]);
    expect(sigla.studies.unclear).toEqual([]);
    expect(sigla.studies.notFound).toEqual(["xhq"]);
    expect(sigla.request.unresolved).toBe(0);
    expect(sigla.studies.matchedIds).toEqual([HEMOGRAMA]);
    const talk = await understand(["hemograma", "para mañana por favor"]);
    expect(talk.studies.unclear).toEqual([]);
    expect(talk.request.unresolved).toBe(0);
    expect(talk.delegated.talk.length).toBeGreaterThan(0);
  });

  it("palabras de enlace sueltas («en», «y») no son una sigla ni bloquean", async () => {
    const u = await understand(["hemograma", "y", "glucosa", "en"]);
    expect(u.request.unresolved).toBe(0);
    expect(sorted(u.studies.matchedIds)).toEqual(sorted([HEMOGRAMA, GLUCOSA]));
  });
});

describe("comandos de la solicitud", () => {
  it.each([
    [["hemograma", "completo", "listo"], "CONFIRM", "FINALIZE"],
    [["hemograma", "sí"], "CONFIRM", "YES"],
    [["hemograma", "eso es todo"], "CONFIRM", "FINALIZE"]
  ] as const)("%j -> intención %s por %s, y el comando no se lee como estudio", async (messages, intent, by) => {
    const u = await understand(messages);
    expect(u.intent).toBe(intent);
    expect(u.confirmedBy).toBe(by);
    expect(u.intentSource).toBe("COMMAND");
    expect(u.studies.matchedIds).toEqual([HEMOGRAMA]);
    expect(u.request.unresolved).toBe(0);
  });

  it("un comando corta la reconstrucción de nombres: «hemograma» + «listo» + «completo» no se une", async () => {
    const u = await understand(["hemograma", "listo", "completo"]);
    expect(u.groups.flatMap((group) => group.fragmentIds)).not.toContainEqual(expect.arrayContaining(["m0", "m2"]));
    expect(u.groups.every((group) => !(group.fragmentIds.includes("m0") && group.fragmentIds.includes("m2")))).toBe(true);
  });

  it("estudios DESPUÉS de «listo» lo dejan sin efecto (no se cotiza lo que el paciente aún agregaba)", async () => {
    const u = await understand(["hemograma", "listo", "tsh"]);
    expect(u.confirmSuperseded).toBe(true);
    expect(u.intent).not.toBe("CONFIRM");
    expect(sorted(u.studies.matchedIds)).toEqual(sorted([HEMOGRAMA, TSH]));
  });

  it("«cancelar» descarta la solicitud anterior (sesión y mensajes previos) y solo cuenta lo que viene después", async () => {
    const session: SessionContext = { ...EMPTY_SESSION, open: true, studyIds: [GLUCOSA] };
    const only = await understand(["hemograma", "cancelar"], { session });
    expect(only.intent).toBe("CANCEL");
    expect(only.cancelled).toBe(true);
    expect(only.sessionWasOpen).toBe(true);
    expect(only.studies.matchedIds).toEqual([]);
    expect(only.request.studyIds).toEqual([]);
    const restart = await understand(["hemograma", "cancelar", "tsh"], { session });
    expect(restart.cancelled).toBe(true);
    expect(restart.intent).not.toBe("CANCEL");
    expect(restart.request.studyIds).toEqual([TSH]);
  });

  it("«no» sin otra cosa significa que falta algo", async () => {
    expect((await understand(["no"])).intent).toBe("MORE");
  });
});

describe("integración con la sesión abierta", () => {
  it("la solicitud completa une lo ya anotado con el lote, sin repetidos, y arrastra lo pendiente de la sesión", async () => {
    const session: SessionContext = { open: true, studyIds: [GLUCOSA], pendingGroups: [], unresolved: 1, uncertain: true, unreadable: 2 };
    const u = await understand(["tsh", "glucosa"], { session });
    expect(sorted(u.request.studyIds)).toEqual(sorted([GLUCOSA, TSH]));
    expect(u.request.unresolved).toBe(1);
    expect(u.request.uncertain).toBe(true);
    expect(u.request.unreadable).toBe(2);
    expect(u.studies.repeated).toBeGreaterThanOrEqual(0);
  });

  it("el ítem de sesión es UNO por lote y refleja solo el texto de este lote", async () => {
    const u = await understand(["quiero cotizar", "hemograma", "y glucosa"]);
    expect(u.item).toEqual({ status: "RESOLVED", studyIds: sorted([HEMOGRAMA, GLUCOSA]).length === 2 ? u.item!.studyIds : [], ambiguous: [], unresolved: 0, reasons: [] });
    expect(sorted(u.item!.studyIds)).toEqual(sorted([HEMOGRAMA, GLUCOSA]));
    expect((await understand(["gracias"])).item).toBeUndefined();
  });
});

describe("seguridad: se separa antes de interpretar, no se pierde y no llega al modelo", () => {
  const interpreter = () => {
    const seen: string[] = [];
    const interpret: StudyInterpreter = async (text) => {
      seen.push(text);
      return { isQuoteRequest: true, wantsQuote: true, matched: [], ambiguous: [], unclear: [], notFound: [] };
    };
    return { seen, interpret };
  };

  it.each([
    ["me duele mucho el pecho", "medical"],
    ["quiero hablar con una persona", "human"]
  ])("«%s» se marca (%s), no cuenta como estudio y el resto del lote se entiende igual", async (text, kind) => {
    const u = await understand(["hemograma", text, "completo"]);
    if (kind === "medical") expect(u.safety.medical).toEqual(["m1"]);
    else expect(u.safety.humanRequest).toEqual(["m1"]);
    expect(u.studies.matchedIds).toEqual([HEMOGRAMA]);
    expect(u.request.unresolved).toBe(0);
    // la señal de seguridad es transparente: no corta la reconstrucción, así que insertarla no cambia los estudios («hemograma» + «completo» siguen siendo UN estudio)
    expect(u.groups.some((group) => group.fragmentIds.includes("m0") && group.fragmentIds.includes("m2"))).toBe(true);
  });

  it("SEGURIDAD MONÓTONA: agregar un mensaje médico o de atención humana nunca quita estudios, intención ni dudas; solo agrega su señal", async () => {
    const bases = [["quiero cotizar", "hemograma", "completo"], ["glucosa", "en ayunas"], ["creatinina"]];
    for (const base of bases) {
      const clean = await understand(base);
      for (const extra of ["me duele mucho el pecho", "tengo fiebre", "quiero hablar con una persona"]) {
        for (let position = 0; position <= base.length; position++) {
          const messages = [...base.slice(0, position), extra, ...base.slice(position)];
          const got = await understand(messages);
          const label = JSON.stringify(messages);
          expect(sorted(got.studies.matchedIds), label).toEqual(sorted(clean.studies.matchedIds));
          expect(got.request.pendingGroups.length, label).toBe(clean.request.pendingGroups.length);
          expect(got.request.unresolved, label).toBe(clean.request.unresolved);
          expect(got.intent, label).toBe(clean.intent);
          expect(got.safety.medical.length + got.safety.humanRequest.length, label).toBe(1);
        }
      }
    }
  });

  it("una señal médica partida entre mensajes se detecta al leer el lote completo", async () => {
    const u = await understand(["tengo", "dolor", "de", "pecho"]);
    // cada palabra suelta ya dispara «dolor»; la prueba de la unión cubre frases que solo se completan juntas
    expect(u.safety.medical.length + (u.safety.medicalSplit ? 1 : 0)).toBeGreaterThan(0);
  });

  it("lo médico, lo de atención humana, las preguntas y lo ignorado NUNCA se envían al modelo; solo los mensajes candidatos", async () => {
    const { seen, interpret } = interpreter();
    await understand(["quiero cotizar", "me duele mucho el pecho", "xhq", "quiero hablar con una persona", "¿a qué hora abren?", "listo", "mensaje automático"], { interpret, isIgnorable: (text) => text === "mensaje automático" });
    expect(seen).toHaveLength(1);
    for (const forbidden of ["duele", "persona", "abren", "listo", "automático"]) expect(seen[0], forbidden).not.toContain(forbidden);
    expect(seen[0]).toContain("xhq");
  });

  it("los mensajes ignorados (automáticos o ecos propios) no se interpretan ni cuentan", async () => {
    const u = await understand(["hemograma", "ECO DE NUESTRA RESPUESTA glucosa"], { isIgnorable: (text) => text.startsWith("ECO") });
    expect(u.delegated.ignored).toEqual(["m1"]);
    expect(u.studies.matchedIds).toEqual([HEMOGRAMA]);
  });

  it("las cortesías y el ruido se reconocen con el detector que se inyecte (la atención selectiva); sin él son texto cualquiera y no bloquean", async () => {
    const withDetector = await understand(["hemograma", "gracias"], { isSocial: (text) => text === "gracias" });
    expect(withDetector.delegated.social).toEqual(["m1"]);
    expect(withDetector.studies.matchedIds).toEqual([HEMOGRAMA]);
    const without = await understand(["hemograma", "gracias"]);
    expect(without.delegated.social).toEqual([]);
    expect(without.request.unresolved).toBe(0);
    expect(without.studies.matchedIds).toEqual([HEMOGRAMA]);
  });

  it("las preguntas generales o de información se delegan y no se leen como pedido de estudios", async () => {
    const u = await understand(["¿qué es el hemograma?", "¿a qué hora abren?"]);
    expect(u.delegated.questions).toEqual(["m0", "m1"]);
    expect(u.studies.matchedIds).toEqual([]);
    expect(u.item).toBeUndefined();
  });

  it("un predicado de información propio (conocimiento aprobado del laboratorio) también delega", async () => {
    const u = await understand(["glucosa", "cuánto demora"], { isInfoQuestion: (text) => text.includes("demora") });
    expect(u.delegated.questions).toEqual(["m1"]);
    expect(u.studies.matchedIds).toEqual([GLUCOSA]);
  });
});

describe("OpenAI como apoyo: solo cuando hace falta, validado contra el catálogo y nunca con precios", () => {
  const model = (response: unknown) => vi.fn(async () => response as InterpretedStudyRequest);
  const answer = (overrides: Partial<InterpretedStudyRequest> = {}): InterpretedStudyRequest => ({ isQuoteRequest: true, wantsQuote: false, matched: [], ambiguous: [], unclear: [], notFound: [], ...overrides });
  const pick = (id: string) => ({ study: catalog.find((s) => s.id === id)!, mention: "x", exact: false });

  it("NO se consulta si el catálogo lo resuelve todo y la intención ya es clara", async () => {
    const interpret = model(answer());
    const u = await understand(["quiero cotizar", "hemograma", "completo"], { interpret });
    expect(interpret).not.toHaveBeenCalled();
    expect(u.model).toBe("NOT_NEEDED");
    expect(u.intentSource).toBe("LEXICON");
  });

  it("NO se consulta con comandos o sin mensajes candidatos (solo seguridad, solo «listo»)", async () => {
    const interpret = model(answer());
    await understand(["me duele el pecho"], { interpret });
    await understand(["listo"], { interpret });
    expect(interpret).not.toHaveBeenCalled();
  });

  it("se consulta UNA vez por lote cuando algo queda sin resolver, y su aporte válido se integra", async () => {
    const interpret = model(answer({ matched: [{ ...pick(GLUCOSA), mention: "xhq" }] }));
    const u = await understand(["hemograma", "xhq"], { interpret });
    expect(interpret).toHaveBeenCalledTimes(1);
    expect(u.model).toBe("USED");
    expect(sorted(u.studies.matchedIds)).toEqual(sorted([HEMOGRAMA, GLUCOSA]));
    expect(u.request.unresolved).toBe(0);
  });

  it("se consulta para entender una intención que el texto no deja clara: «me dices cuánto sale» con estudios resueltos", async () => {
    const interpret = model(answer({ isQuoteRequest: true, wantsQuote: true }));
    const u = await understand(["hemograma", "glucosa", "agradecería el valor total"], { interpret });
    expect(interpret).toHaveBeenCalledTimes(1);
    expect(u.intent).toBe("QUOTE");
    expect(u.intentSource).toBe("MODEL");
  });

  it("si el modelo dice que NO pide cotizar, la intención es NONE (la decisión de cotizar nunca sale de un fallo del modelo)", async () => {
    const interpret = model(answer({ isQuoteRequest: true, wantsQuote: false }));
    const u = await understand(["hemograma", "solo estaba averiguando algo xq"], { interpret });
    expect(u.intent).toBe("NONE");
    expect(u.intentSource).toBe("MODEL");
  });

  it("modo «always» también confirma con el modelo una intención que el texto sí deja clara", async () => {
    const interpret = model(answer({ isQuoteRequest: true, wantsQuote: false }));
    const u = await understand(["quiero cotizar", "hemograma"], { interpret, modelUse: "always" });
    expect(interpret).toHaveBeenCalledTimes(1);
    expect(u.intent).toBe("NONE");
    expect(u.intentSource).toBe("MODEL");
    const off = await understand(["quiero cotizar", "hemograma"], { interpret, modelUse: "when-needed" });
    expect(off.intent).toBe("QUOTE");
    expect(off.intentSource).toBe("LEXICON");
  });

  it("modo «never» no consulta jamás", async () => {
    const interpret = model(answer());
    const u = await understand(["hemograma", "xhq"], { interpret, modelUse: "never" });
    expect(interpret).not.toHaveBeenCalled();
    expect(u.model).toBe("OFF");
    expect(u.request.unresolved).toBe(0);
    expect(u.studies.notFound).toEqual(["xhq"]);
  });

  it("su salida NO es confiable: ids inventados o inactivos, ambigüedades con una sola opción y campos extra (precios) se descartan", async () => {
    const inactive = { ...catalog[0]!, id: uuid(99), active: false };
    const interpret = model({
      isQuoteRequest: true,
      wantsQuote: true,
      matched: [pick(TSH), { study: { id: uuid(555), name: "ESTUDIO INVENTADO", priceBs: 1 }, mention: "x", exact: true }, { study: inactive, mention: "y", exact: true }, { study: { ...catalog[1]!, priceBs: 0.01 }, mention: "precio", exact: true, priceBs: 0.01 }],
      ambiguous: [{ mention: "z", candidates: [catalog[0]!] }, { mention: "w", candidates: [{ id: uuid(1) }, { id: uuid(404) }] }],
      unclear: ["  <script>  ", "https://malo.example", "valor", 5],
      notFound: ["pet scan"],
      priceBs: 123,
      total: 999
    });
    const u = await understand(["quiero cotizar", "xhq"], { interpret });
    expect(sorted(u.studies.matchedIds)).toEqual(sorted([TSH, GLUCOSA]));
    expect(u.studies.matchedIds).not.toContain(uuid(555));
    expect(u.studies.matchedIds).not.toContain(uuid(99));
    expect(u.request.pendingGroups).toEqual([]);
    // lo que el modelo no mencionó (xhq) sigue figurando como «no está en el catálogo»: nunca se descarta en silencio
    expect(u.studies.notFound).toEqual(["xhq", "pet scan"]);
    // lo que sobrevive del texto del modelo es solo texto simple (sin marcas, enlaces ni contactos) y no queda ningún campo de precio o total
    expect(u.studies.unclear.every((mention) => /^[\p{L}\p{N} .,()+/-]+$/u.test(mention))).toBe(true);
    expect(u.studies.unclear.join(" ")).not.toMatch(/https?|<|>/);
    const serialized = JSON.stringify(u);
    expect(serialized).not.toMatch(/priceBs|"total"|0\.01|123|999|malo\.example/);
  });

  it("si el modelo falla, devuelve algo inválido o la transcripción no cabe, el resultado determinista sigue valiendo", async () => {
    const failing: StudyInterpreter = async () => { throw new Error("sin red"); };
    const broken = await understand(["hemograma", "xhq"], { interpret: failing });
    expect(broken.model).toBe("FAILED");
    expect(broken.studies.matchedIds).toEqual([HEMOGRAMA]);
    expect(broken.request.unresolved).toBe(0);
    expect(broken.studies.notFound).toEqual(["xhq"]);
    const undef = await understand(["hemograma", "xhq"], { interpret: async () => undefined });
    expect(undef.model).toBe("FAILED");
    const garbage = await understand(["hemograma", "xhq"], { interpret: async () => "no es un objeto" as never });
    expect(garbage.model).toBe("INVALID");
    const interpret = model(answer());
    const long = await understand(["hemograma", "xhq", "x".repeat(700)], { interpret, maxModelChars: 20 });
    expect(long.model).toBe("TOO_LONG");
    expect(interpret).not.toHaveBeenCalled();
  });

  it("la transcripción que sale es solo lo escrito por el paciente en los mensajes candidatos: ni ids, ni sesión, ni catálogo", async () => {
    const seen: string[] = [];
    const interpret: StudyInterpreter = async (text) => {
      seen.push(text);
      return answer();
    };
    const session: SessionContext = { open: true, studyIds: [GLUCOSA], pendingGroups: [[CREA_SERICA, CREA_ORINA]], unresolved: 0, uncertain: false, unreadable: 0 };
    await understand(["hemograma", "xhq"], { interpret, session });
    expect(seen).toEqual(["hemograma\nxhq"]);
    expect(seen[0]).not.toMatch(/0000|uuid/);
  });
});

describe("negación: lo que el paciente niega no es lo que pide (regla general, sin frases)", () => {
  const withVdrl: CatalogStudy[] = [...catalog, study(11, "PRUEBA NO TREPONEMICA VDRL", ["vdrl", "prueba no treponemica"], 40)];
  const VDRL = uuid(11);

  it.each([
    "no quiero cotizar",
    "no necesito cotizar",
    "ya no quiero el precio",
    "tampoco quiero cotizar",
    "nunca pedí cotizar",
    "no deseo saber cuánto cuesta",
    "no cotices nada",
    "no hace falta cotizar",
    "ni quiero cotizar ni quiero precios"
  ])("«%s» -> NO quiere cotizar: la intención es DECLINE, no QUOTE", async (text) => {
    const u = await understand([text]);
    expect(u.intent, text).toBe("DECLINE");
    expect(u.intentSource).toBe("LEXICON");
    expect(u.studies.matchedIds).toEqual([]);
    expect(u.negatedFragmentIds).toEqual(["m0"]);
  });

  it("lo negado no cuenta como estudio: «no quiero cotizar el hemograma» no anota el hemograma", async () => {
    const u = await understand(["no quiero cotizar el hemograma"]);
    expect(u.intent).toBe("DECLINE");
    expect(u.studies.matchedIds).toEqual([]);
    expect(u.item).toBeUndefined();
  });

  it("la negación llega hasta el final de SU cláusula y no más: lo dicho en otra cláusula sigue valiendo", async () => {
    const decline = await understand(["hemograma, no quiero cotizar"]);
    expect(decline.studies.matchedIds).toEqual([HEMOGRAMA]);
    expect(decline.intent).toBe("DECLINE");
    const butPositive = await understand(["no quiero cotizar, quiero cotizar glucosa"]);
    expect(butPositive.intent).toBe("QUOTE");
    expect(butPositive.studies.matchedIds).toEqual([GLUCOSA]);
    const but = await understand(["quiero cotizar hemograma pero no glucosa"]);
    expect(but.intent).toBe("QUOTE");
    expect(but.studies.matchedIds).toEqual([HEMOGRAMA]);
    const sino = await understand(["no quiero cotizar sino consultar"]);
    expect(sino.intent).toBe("DECLINE");
    const notQuote = await understand(["quiero cotizar, no tengo apuro"]);
    expect(notQuote.intent).toBe("QUOTE");
  });

  it("un estudio negado no entra en la solicitud: «no quiero hemograma, quiero glucosa» solo anota la glucosa", async () => {
    const u = await understand(["no quiero hemograma, quiero glucosa"]);
    expect(u.studies.matchedIds).toEqual([GLUCOSA]);
    const list = await understand(["quiero cotizar glucosa", "no hemograma"]);
    expect(list.studies.matchedIds).toEqual([GLUCOSA]);
    expect(list.intent).toBe("QUOTE");
  });

  it("sin negación nada cambia: «sin duda quiero cotizar» y los estudios y pedidos de siempre", async () => {
    expect((await understand(["sin duda quiero cotizar hemograma"])).intent).toBe("QUOTE");
    expect((await understand(["quiero cotizar hemograma"])).studies.matchedIds).toEqual([HEMOGRAMA]);
    expect((await understand(["hemograma", "glucosa"])).negatedFragmentIds).toEqual([]);
  });

  it("la excepción la dicta el CATÁLOGO: un «no» que es parte del nombre de un estudio reconocido no es una negación", async () => {
    const u = await understandBatch({ catalog: withVdrl, fragments: fragmentsOf(["quiero cotizar prueba no treponemica"]) });
    expect(u.studies.matchedIds).toEqual([VDRL]);
    expect(u.intent).toBe("QUOTE");
    expect(u.negatedFragmentIds).toEqual([]);
    // en otro contexto el mismo «no» sí niega
    const negated = await understandBatch({ catalog: withVdrl, fragments: fragmentsOf(["no quiero cotizar vdrl"]) });
    expect(negated.studies.matchedIds).toEqual([]);
    expect(negated.intent).toBe("DECLINE");
  });

  // Un mensaje es una enunciación completa: lo que se escribe en el siguiente es una petición posterior, no parte de la negación. Por eso repartir una oración con negación en mensajes YA NO da siempre la
  // misma comprensión (antes sí, y eso hacía desaparecer en silencio estudios que el paciente sí pidió). Lo que sí se exige es SEGURIDAD: ningún reparto convierte en cotización lo que no lo era, ni cotiza
  // un estudio que la oración original negaba, y lo ambiguo se pregunta en vez de decidirse.
  const planOf = async (messages: readonly string[], session: SessionContext = EMPTY_SESSION) => {
    const u = await understand(messages, { session });
    return { u, plan: decideBatch({ understanding: u }) };
  };

  it("SEGURIDAD ANTE LA FRAGMENTACIÓN: ningún reparto en mensajes convierte en cotización lo que no era una, ni cotiza un estudio negado", async () => {
    const sentences: Array<{ sentence: string; negated: string[] }> = [
      { sentence: "no quiero cotizar hemograma completo", negated: [HEMOGRAMA] },
      { sentence: "quiero cotizar hemograma completo, no glucosa", negated: [GLUCOSA] },
      { sentence: "no quiero hemograma, quiero cotizar glucosa en ayunas", negated: [HEMOGRAMA] },
      { sentence: "cotizar hemograma completo y glucosa no", negated: [GLUCOSA] },
      { sentence: "no quiero cotizar", negated: [] }
    ];
    for (const { sentence, negated } of sentences) {
      const reference = await planOf([sentence]);
      let splitsThatQuote = 0;
      for (const messages of partitions(sentence.split(" "))) {
        // un mensaje que es SOLO «no» es la respuesta «falta algo» (un comando), no una negación
        if (messages.some((message) => /^(no|nunca|tampoco|ni)$/i.test(message.trim()))) continue;
        const { plan, u } = await planOf(messages);
        if (reference.plan.core.kind !== "QUOTE") expect(plan.core.kind, `${sentence} :: ${JSON.stringify(messages)}`).not.toBe("QUOTE");
        if (plan.core.kind === "QUOTE") {
          splitsThatQuote++;
          for (const id of negated) expect(plan.core.studyIds, `${sentence} :: ${JSON.stringify(messages)}`).not.toContain(id);
          // y si la oración original no cotizaba nada, este reparto tampoco puede traer una duda de negación sin resolver
          expect(u.negationDoubts, JSON.stringify(messages)).toEqual([]);
        }
      }
      if (reference.plan.core.kind === "QUOTE") expect(splitsThatQuote, sentence).toBeGreaterThan(0);
    }
  });

  it("cuando el reparto cae en el límite de una cláusula (una coma, un punto) la comprensión es EXACTAMENTE la de la oración completa", async () => {
    const pairs: Array<[string[], string]> = [
      [["no quiero hemograma,", "quiero cotizar glucosa en ayunas"], "no quiero hemograma, quiero cotizar glucosa en ayunas"],
      [["quiero cotizar hemograma completo.", "no glucosa"], "quiero cotizar hemograma completo. no glucosa"],
      [["no quiero cotizar.", "hemograma completo"], "no quiero cotizar. hemograma completo"]
    ];
    for (const [messages, whole] of pairs) expect(shape(await understand(messages)), JSON.stringify(messages)).toEqual(shape(await understand([whole])));
  });

  describe("distingue negativas, rectificaciones y peticiones posteriores", () => {
    it("una petición POSTERIOR a una negativa vale: «no quiero cotizar» + «hemograma completo» anota el hemograma y sigue sin cotizar", async () => {
      const { u, plan } = await planOf(["no quiero cotizar", "hemograma completo"]);
      expect(u.intent).toBe("DECLINE");
      expect(u.studies.matchedIds).toEqual([HEMOGRAMA]);
      expect(u.negationDoubts).toEqual([]);
      expect(plan.core).toMatchObject({ kind: "DECLINED", studyIds: [HEMOGRAMA] });
    });

    it("rectificación por una nueva petición: «no quiero hemograma» + «quiero glucosa» es la glucosa, sin dudas, y cotiza", async () => {
      const { u, plan } = await planOf(["no quiero hemograma", "quiero glucosa"]);
      expect(u.studies.matchedIds).toEqual([GLUCOSA]);
      expect(u.negationDoubts).toEqual([]);
      expect(plan.core).toMatchObject({ kind: "QUOTE", studyIds: [GLUCOSA] });
    });

    it("cambió de idea: lo ÚLTIMO que dijo sobre cotizar es lo que vale, en cualquier orden", async () => {
      expect((await understand(["no quiero cotizar", "mejor sí, cotizar hemograma"])).intent).toBe("QUOTE");
      expect((await understand(["cotizar hemograma", "no quiero cotizar"])).intent).toBe("DECLINE");
      expect((await understand(["cotizar hemograma", "no quiero cotizar", "mejor cotiza"])).intent).toBe("QUOTE");
      // lo que se pidió antes de negar el cotizar sigue anotado
      expect((await understand(["cotizar hemograma", "no quiero cotizar"])).studies.matchedIds).toEqual([HEMOGRAMA]);
    });

    it("un estudio que se pide y luego se niega queda fuera; uno que se niega y luego se pide queda dentro", async () => {
      expect((await understand(["hemograma y glucosa", "glucosa no"])).studies.matchedIds).toEqual([HEMOGRAMA]);
      expect((await understand(["hemograma y glucosa", "no quiero glucosa"])).studies.matchedIds).toEqual([HEMOGRAMA]);
      expect((await understand(["no quiero glucosa", "glucosa en ayunas"])).studies.matchedIds).toEqual([GLUCOSA]);
      expect((await understand(["no quiero hemograma, quiero hemograma completo"])).studies.matchedIds).toEqual([HEMOGRAMA]);
      expect((await understand(["hemograma completo, no hemograma"])).studies.matchedIds).toEqual([]);
    });

    it("negación al final de la cláusula: anula solo la última mención", async () => {
      expect((await understand(["hemograma completo y glucosa no"])).studies.matchedIds).toEqual([HEMOGRAMA]);
      expect((await understand(["hemograma, glucosa, tsh no"])).studies.matchedIds.sort()).toEqual([GLUCOSA, HEMOGRAMA].sort());
      expect((await understand(["glucosa no"])).studies.matchedIds).toEqual([]);
    });

    it("una ambigüedad que se niega después deja de ser una duda", async () => {
      const u = await understand(["creatinina", "creatinina no"]);
      expect(u.studies.ambiguous).toEqual([]);
      expect(u.request.pendingGroups).toEqual([]);
    });

    it("«no quiero» sin objeto y más mensajes después: DUDA, no se descarta nada en silencio y la política no cotiza", async () => {
      for (const messages of [["no quiero", "hemograma"], ["no quiero", "cotizar hemograma"], ["no deseo", "hemograma", "glucosa"]]) {
        const { u, plan } = await planOf(messages);
        expect(u.negationDoubts, JSON.stringify(messages)).toEqual(["DANGLING"]);
        expect(u.studies.matchedIds.length, JSON.stringify(messages)).toBeGreaterThan(0);
        expect(plan.core.kind, JSON.stringify(messages)).toBe("SUMMARY");
        expect(plan.reasons).toContain("NEGATION_UNCLEAR");
      }
      // sin más mensajes después no hay nada que esperar
      expect((await understand(["hola", "no quiero"])).negationDoubts).toEqual([]);
      // con objeto, no es una duda
      expect((await understand(["no quiero hemograma", "glucosa"])).negationDoubts).toEqual([]);
    });

    it("un «no» suelto al inicio de una cláusula tras una petición es una rectificación DUDOSA; sin petición previa es solo una respuesta", async () => {
      const { u, plan } = await planOf(["hemograma", "no, glucosa"]);
      expect(u.negationDoubts).toEqual(["RECTIFICATION"]);
      expect(u.studies.matchedIds.sort()).toEqual([GLUCOSA, HEMOGRAMA].sort());
      expect(plan.core.kind).toBe("SUMMARY");
      const alone = await understand(["no, glucosa"]);
      expect(alone.negationDoubts).toEqual([]);
      expect(alone.studies.matchedIds).toEqual([GLUCOSA]);
      // con una solicitud abierta (el «no» responde a nuestra pregunta) tampoco hay rectificación del lote
      const session: SessionContext = { open: true, studyIds: [HEMOGRAMA], pendingGroups: [], unresolved: 0, uncertain: false, unreadable: 0 };
      expect((await understand(["no, glucosa"], { session })).negationDoubts).toEqual([]);
    });

    it("negar un estudio que YA estaba anotado en la solicitud abierta es una duda (no se puede deshacer desde aquí)", async () => {
      const session: SessionContext = { open: true, studyIds: [HEMOGRAMA, GLUCOSA], pendingGroups: [], unresolved: 0, uncertain: false, unreadable: 0 };
      const { u, plan } = await planOf(["no quiero hemograma", "cotizar"], session);
      expect(u.negationDoubts).toEqual(["RETRACTS_SESSION"]);
      expect(plan.core.kind).not.toBe("QUOTE");
    });

    it("solo un «listo» explícito cierra aunque quede una duda de negación; una intención inferida o un «sí» no", async () => {
      expect((await planOf(["hemograma", "no, glucosa", "listo"])).plan.core).toMatchObject({ kind: "QUOTE", closeBy: "FINALIZE" });
      expect((await planOf(["hemograma", "no, glucosa", "sí"])).plan.core.kind).not.toBe("QUOTE");
      expect((await planOf(["cotizar hemograma", "no, glucosa"])).plan.core.kind).toBe("SUMMARY");
    });

    it("sin dudas de negación la política no cambia: la intención clara con estudios resueltos sigue cotizando directo", async () => {
      expect((await planOf(["quiero cotizar", "hemograma completo", "y glucosa"])).plan.core).toMatchObject({ kind: "QUOTE", closeBy: "INTENT" });
    });

    it("el modelo solo ve lo que el paciente NO negó", async () => {
      const seen: string[] = [];
      const interpret: StudyInterpreter = async (text) => {
        seen.push(text);
        return undefined;
      };
      await understand(["no quiero hemograma", "xhq"], { interpret });
      expect(seen).toHaveLength(1);
      expect(seen[0]).not.toMatch(/hemograma/i);
      expect(seen[0]).toContain("xhq");
    });
  });

  it("un «no» suelto sigue siendo la respuesta «falta algo» (comando), no una negación del mensaje siguiente", async () => {
    expect((await understand(["no"])).intent).toBe("MORE");
    const u = await understand(["no", "quiero cotizar hemograma"]);
    expect(u.intent).toBe("QUOTE");
    expect(u.studies.matchedIds).toEqual([HEMOGRAMA]);
  });

  it("la seguridad NO se relaja con la negación: lo médico y pedir a una persona se marcan aunque vengan negados (se prefiere avisar de más)", async () => {
    expect((await understand(["no tengo fiebre", "hemograma"])).safety.medical).toEqual(["m0"]);
    expect((await understand(["no quiero hablar con una persona"])).safety.humanRequest).toEqual(["m0"]);
  });

  it("negar el cotizar no borra una confirmación explícita ni una cancelación", async () => {
    expect((await understand(["hemograma", "no quiero cotizar", "listo"])).intent).toBe("CONFIRM");
    expect((await understand(["hemograma", "no quiero cotizar", "cancelar"])).intent).toBe("CANCEL");
  });

  it("con el modelo, la negación no necesita consultarlo: ya se resuelve sola, y el texto negado no se manda como pedido", async () => {
    const interpret = vi.fn(async () => ({ isQuoteRequest: true, wantsQuote: true, matched: [], ambiguous: [], unclear: [], notFound: [] }));
    const u = await understand(["no quiero cotizar"], { interpret });
    expect(u.intent).toBe("DECLINE");
    expect(interpret).not.toHaveBeenCalled();
  });
});
