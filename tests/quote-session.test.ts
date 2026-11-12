import { describe, expect, it } from "vitest";
import { normalizeStudyKey } from "../src/consensus.js";
import {
  assertSafeQuoteTexts, evaluateSession, extractStudyRequests, formatAck, formatSessionQuote, formatTextReply, isGeneralQuestion, optionsOf, parseSessionCommand, parseSessionReply, pendingGroupsOf, QUOTE_TEXTS,
  summarizeSession, UnsafeQuoteTextError, type QuoteTexts, type SessionItem
} from "../src/quote-session.js";
import type { CatalogStudy } from "../src/types.js";

// Parte PURA de las sesiones de cotización: comandos, estudios escritos, evaluación al cerrar y mensajes. Sin red ni base de datos.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const study = (n: number, name: string, aliases: string[] = [], priceBs = 10 * n, active = true): CatalogStudy => ({
  id: uuid(n), code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active
});
const CATALOG = [
  study(1, "HEMOGRAMA COMPLETO", ["hemograma", "biometria hemática"]),
  study(2, "GLUCOSA EN AYUNAS", ["glucosa", "glicemia"]),
  study(3, "COLESTEROL TOTAL", ["colesterol"]),
  study(4, "TSH", ["hormona estimulante de tiroides"]),
  study(5, "EXAMEN GENERAL DE ORINA", ["orina", "ego"]),
  study(6, "PERFIL LIPIDICO", ["perfil de lipidos"]),
  // dos estudios con el mismo alias: ambiguo
  study(7, "CREATININA SERICA", ["creatinina"]),
  study(8, "CREATININA EN ORINA", ["creatinina"]),
  study(9, "ÁCIDO ÚRICO", ["acido urico"], 55.5),
  study(10, "ESTUDIO RETIRADO", ["retirado"], 30, false),
  study(11, "VITAMINA B Y C", ["vitamina b y c"])
];
const SENTINEL = "TEXTO_CLINICO_SENTINELA_7788";

describe("comandos de la sesión", () => {
  it.each(["listo", "Listo!", "LISTA", "listo, gracias", "eso es todo", "Eso sería todo", "ya está todo", "nada más", "cotiza", "cotizar", "cotízame", "cotizalo por favor", "ahora sí listo", "ya terminé", "finalizar", "ok listo", "dale cotiza"])("FINALIZE: %s", (text) => {
    expect(parseSessionCommand(text)).toBe("FINALIZE");
  });

  it.each(["cancelar", "Cancela todo", "anular", "empezar de nuevo", "borrar todo", "reiniciar", "nueva solicitud"])("CANCEL: %s", (text) => {
    expect(parseSessionCommand(text)).toBe("CANCEL");
  });

  it.each([
    "aún no estoy listo", "todavía no, falta una foto", "no estoy lista", "listo el resultado de mi examen?", "¿ya está listo mi resultado?", "ya", "ok", "gracias", "si", "hola", "quiero cotizar hemograma",
    "cotizar hemograma y glucosa", "cuando estará listo el hemograma", "nada", "mas", "todo bien", "quiero cancelar mi cita", "", "   ", "listo listo listo listo listo listo"
  ])("no es un comando: %s", (text) => {
    expect(parseSessionCommand(text)).toBeUndefined();
  });

  it("solo mira el comienzo del mensaje", () => {
    expect(parseSessionCommand(`listo ${"x".repeat(5000)}`)).toBeUndefined();
  });
});

describe("estudios escritos", () => {
  const ids = (text: string) => extractStudyRequests(text, CATALOG)?.result.studyIds ?? [];

  it("reconoce nombres y alias exactos, con relleno de cortesía alrededor y separadores variados", () => {
    expect(ids("hemograma")).toEqual([uuid(1)]);
    expect(ids("Hola, quiero cotizar hemograma")).toEqual([uuid(1)]);
    for (const phrase of ["Oye, quiero cotizar hemograma y glucosa", "oye quiero cotizar hemograma y glucosa", "Oiga, cotízame hemograma y glucosa"]) {
      const extraction = extractStudyRequests(phrase, CATALOG);
      expect(extraction?.result).toMatchObject({ status: "RESOLVED", studyIds: [uuid(1), uuid(2)], unresolved: 0 });
      expect(extraction?.wantsQuote).toBe(true);
    }
    expect(ids("hemograma, glucosa y colesterol")).toEqual([uuid(1), uuid(2), uuid(3)]);
    expect(ids("necesito: Glucosa + TSH / orina")).toEqual([uuid(2), uuid(4), uuid(5)]);
    expect(ids("¿cuánto cuesta el hemograma?")).toEqual([uuid(1)]);
    expect(ids("hemograma\nglicemia\nperfil de lípidos por favor")).toEqual([uuid(1), uuid(2), uuid(6)]);
    expect(ids("BIOMETRÍA HEMÁTICA")).toEqual([uuid(1)]);
    expect(ids("ácido úrico")).toEqual([uuid(9)]);
  });

  it("un nombre que contiene «y» se resuelve entero antes de separarse", () => {
    expect(ids("vitamina b y c")).toEqual([uuid(11)]);
    expect(ids("vitamina b y c, hemograma")).toEqual([uuid(11), uuid(1)]);
  });

  it("lo repetido cuenta una vez y se informa cuántas veces se repitió dentro del mensaje", () => {
    const extraction = extractStudyRequests("hemograma, hemograma y glicemia, glucosa", CATALOG)!;
    expect(extraction.result.studyIds).toEqual([uuid(1), uuid(2)]);
    expect(extraction.repeatedInMessage).toBe(2);
    expect(extraction.result.status).toBe("RESOLVED");
  });

  it("un alias de varios estudios es AMBIGUO: no se elige ninguno", () => {
    const extraction = extractStudyRequests("creatinina y hemograma", CATALOG)!;
    expect(extraction.result).toMatchObject({ status: "AMBIGUOUS", studyIds: [uuid(1)], ambiguous: [[uuid(7), uuid(8)]], unresolved: 0, reasons: ["AMBIGUOUS_STUDY"] });
  });

  it("lo que no está en el catálogo queda SIN RESOLVER (jamás se aproxima ni se infiere una equivalencia)", () => {
    for (const text of ["hemograma, examen de la vista", "quiero cotizar hemogramas", "hemogram", "glucosa postprandial", "colesterol hdl", "sangre completa"]) {
      const extraction = extractStudyRequests(text, CATALOG);
      expect(extraction?.result.status ?? "NINGUNO", text).not.toBe("RESOLVED_ALL");
      if (extraction) expect(extraction.result.unresolved + extraction.result.studyIds.length + extraction.result.ambiguous.length, text).toBeGreaterThan(0);
    }
    expect(extractStudyRequests("hemograma, examen de la vista", CATALOG)!.result).toMatchObject({ status: "UNRESOLVED", studyIds: [uuid(1)], unresolved: 1, reasons: ["UNRESOLVED_TEXT"] });
    expect(ids("glucosa postprandial")).toEqual([]);
    expect(ids("colesterol hdl")).toEqual([]);
  });

  it("un estudio retirado del catálogo (inactivo) no existe para el paciente", () => {
    expect(ids("retirado")).toEqual([]);
    expect(extractStudyRequests("retirado", CATALOG)).toBeUndefined();
  });

  it("un mensaje sin estudios que no habla de cotizar NO abre un caso: gracias, hola, preguntas de otra cosa", () => {
    for (const text of ["gracias", "hola", "ok", "muy amable", "no sé", "¿a qué hora abren?", ""]) expect(extractStudyRequests(text, CATALOG), text).toBeUndefined();
  });

  it("un mensaje de cotización con algo que no se resuelve sí queda como solicitud sin resolver", () => {
    expect(extractStudyRequests("quiero cotizar xyzabc", CATALOG)?.result).toMatchObject({ status: "UNRESOLVED", unresolved: 1 });
    expect(extractStudyRequests("quiero cotizar", CATALOG)).toBeUndefined();
    expect(extractStudyRequests("precio", CATALOG)).toBeUndefined();
  });

  it("el relleno solo se quita de los extremos: nunca cambia el nombre de un estudio", () => {
    // «de» en el interior de un nombre no se pierde; «examen de orina» no equivale a «orina» salvo que el catálogo lo diga
    expect(ids("examen de orina")).toEqual([]);
    expect(ids("examen general de orina")).toEqual([uuid(5)]);
  });

  it("acota la cantidad de fragmentos y el tamaño del texto", () => {
    const many = Array.from({ length: 60 }, () => "hemograma").join(", ");
    expect(extractStudyRequests(many, CATALOG)!.result.studyIds).toEqual([uuid(1)]);
    expect(() => extractStudyRequests(`hemograma ${"x".repeat(100_000)}`, CATALOG)).not.toThrow();
    expect(extractStudyRequests(`quiero cotizar ${"x".repeat(100_000)}`, CATALOG)?.result).toMatchObject({ status: "UNRESOLVED", unresolved: 1 });
  });

  it("el resultado nunca contiene el texto del paciente", () => {
    const extraction = extractStudyRequests(`hemograma, ${SENTINEL}`, CATALOG)!;
    expect(JSON.stringify(extraction.result)).not.toContain(SENTINEL);
  });
});

describe("evaluación de la sesión al cerrar", () => {
  const item = (n: number, over: Partial<SessionItem> = {}): SessionItem => ({ id: uuid(100 + n), seq: n, kind: "TEXT", status: "RESOLVED", studyIds: [], ambiguous: [], unresolved: 0, reasons: [], ...over });

  it("sin ítems, o solo con repetidos: vacía", () => {
    expect(evaluateSession([], CATALOG)).toEqual({ kind: "EMPTY" });
    expect(evaluateSession([item(1, { status: "DUPLICATE", kind: "IMAGE" })], CATALOG)).toEqual({ kind: "EMPTY" });
  });

  it("cotiza TODO lo identificado, sin repetidos, con los precios del catálogo vigente y el total exacto", () => {
    const result = evaluateSession([item(1, { studyIds: [uuid(1), uuid(9)] }), item(2, { kind: "IMAGE", studyIds: [uuid(1), uuid(2)] }), item(3, { status: "DUPLICATE", kind: "IMAGE" })], CATALOG);
    expect(result).toEqual({
      kind: "QUOTE",
      lines: [{ studyId: uuid(1), name: "HEMOGRAMA COMPLETO", priceBs: 10 }, { studyId: uuid(9), name: "ÁCIDO ÚRICO", priceBs: 55.5 }, { studyId: uuid(2), name: "GLUCOSA EN AYUNAS", priceBs: 20 }],
      totalBs: 85.5,
      duplicates: 1
    });
  });

  it("el total se calcula en centavos: no hay errores de coma flotante", () => {
    const cheap = [study(21, "A", [], 0.1), study(22, "B", [], 0.2)];
    const result = evaluateSession([item(1, { studyIds: [uuid(21), uuid(22)] })], cheap);
    expect(result).toMatchObject({ kind: "QUOTE", totalBs: 0.3 });
  });

  it("usa el precio de ESTE catálogo, no el que hubiera cuando se identificó el estudio", () => {
    const items = [item(1, { studyIds: [uuid(1)] })];
    expect(evaluateSession(items, CATALOG)).toMatchObject({ totalBs: 10 });
    expect(evaluateSession(items, [study(1, "HEMOGRAMA COMPLETO", [], 99)])).toMatchObject({ totalBs: 99 });
  });

  it("un estudio que ya no está activo o no existe manda a revisión: nunca se cotiza por memoria", () => {
    expect(evaluateSession([item(1, { studyIds: [uuid(10)] })], CATALOG)).toEqual({ kind: "REVIEW", reasons: ["STUDY_UNAVAILABLE"] });
    expect(evaluateSession([item(1, { studyIds: [uuid(1), uuid(99)] })], CATALOG)).toEqual({ kind: "REVIEW", reasons: ["STUDY_UNAVAILABLE"] });
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY, 10.005, 1e-9])("un precio inválido (%s) manda a revisión, nunca se inventa uno", (price) => {
    expect(evaluateSession([item(1, { studyIds: [uuid(31)] })], [study(31, "RARO", [], price)])).toEqual({ kind: "REVIEW", reasons: ["PRICE_INVALID"] });
  });

  it("ambiguo, sin resolver o dudoso del motor: revisión (con los motivos), aunque lo demás esté claro", () => {
    expect(evaluateSession([item(1, { studyIds: [uuid(1)] }), item(2, { status: "AMBIGUOUS", ambiguous: [[uuid(7), uuid(8)]], reasons: ["AMBIGUOUS_STUDY"] })], CATALOG)).toEqual({ kind: "REVIEW", reasons: ["AMBIGUOUS_STUDY"] });
    expect(evaluateSession([item(1, { status: "UNRESOLVED", unresolved: 2, reasons: ["UNRESOLVED_TEXT"] })], CATALOG)).toEqual({ kind: "REVIEW", reasons: ["UNRESOLVED_TEXT"] });
    expect(evaluateSession([item(1, { kind: "IMAGE", status: "UNCERTAIN", studyIds: [uuid(1)], reasons: ["ENGINE_PARTIAL"] })], CATALOG)).toEqual({ kind: "REVIEW", reasons: ["ENGINE_PARTIAL"] });
    const mixed = evaluateSession([item(1, { status: "AMBIGUOUS", reasons: ["AMBIGUOUS_STUDY"] }), item(2, { status: "UNRESOLVED", reasons: ["UNRESOLVED_TEXT"] })], CATALOG);
    expect(mixed).toMatchObject({ kind: "REVIEW" });
    expect((mixed as { reasons: string[] }).reasons.sort()).toEqual(["AMBIGUOUS_STUDY", "UNRESOLVED_TEXT"]);
  });

  it("una foto ilegible pide reenviar ANTES que cualquier otra cosa", () => {
    expect(evaluateSession([item(1, { kind: "IMAGE", status: "UNREADABLE", reasons: ["UNREADABLE_IMAGE"] }), item(2, { status: "AMBIGUOUS", reasons: ["AMBIGUOUS_STUDY"] }), item(3, { kind: "IMAGE", status: "UNREADABLE", reasons: ["UNSUPPORTED_IMAGE"] })], CATALOG)).toEqual({ kind: "RESEND", unreadable: 2 });
  });

  it("jamás cotiza un estudio que ningún ítem identificó", () => {
    const result = evaluateSession([item(1, { studyIds: [uuid(3)] })], CATALOG);
    expect(result).toMatchObject({ kind: "QUOTE" });
    expect((result as { lines: Array<{ studyId: string }> }).lines.map((line) => line.studyId)).toEqual([uuid(3)]);
  });
});

describe("mensajes", () => {
  it("los textos fijos son seguros: sin cifras, moneda, promesas ni menciones a una persona", () => {
    expect(() => assertSafeQuoteTexts(QUOTE_TEXTS)).not.toThrow();
    for (const [key, bad] of Object.entries({ full: "Tienes 5 fotos", empty: "Un asesor te atenderá", review: "Cuesta Bs 5", cancelled: "Es gratis", waiting: "El equipo te escribirá", resend: "Respuesta inmediata" })) {
      expect(() => assertSafeQuoteTexts({ ...QUOTE_TEXTS, [key]: bad } as QuoteTexts), key).toThrow(UnsafeQuoteTextError);
    }
    expect(() => assertSafeQuoteTexts({ ...QUOTE_TEXTS, empty: "" })).toThrow(UnsafeQuoteTextError);
  });

  it("el aviso de estudios dudosos no promete que una persona revisará el caso (la revisión humana todavía no existe)", () => {
    expect(QUOTE_TEXTS.review).not.toMatch(/persona|equipo|asesor|te escribir|te llamar/i);
    expect(QUOTE_TEXTS.review).toMatch(/no te doy un precio/);
  });

  it("la confirmación lista los nombres del CATÁLOGO, la cantidad de mensajes y cómo cerrar; avisa si hay dudas o repetidos", () => {
    const body = formatAck({ texts: QUOTE_TEXTS, kind: "TEXT", names: ["HEMOGRAMA COMPLETO", "TSH"], position: 2, hasDoubt: true, repeated: 1 });
    expect(body).toContain("Estudios identificados: HEMOGRAMA COMPLETO, TSH.");
    expect(body).toContain(QUOTE_TEXTS.uncertain_note);
    expect(body).toContain(QUOTE_TEXTS.repeated_note);
    expect(body).toContain("Llevas 2 mensajes");
    expect(body).toContain("LISTO");
    expect(formatAck({ texts: QUOTE_TEXTS, kind: "IMAGE", names: [], position: 1, hasDoubt: false, repeated: 0 })).toContain("Llevas 1 mensaje en");
  });

  it("la cotización usa el formato de siempre y avisa de repetidos solo si los hubo", () => {
    const lines = [{ studyId: uuid(1), name: "HEMOGRAMA COMPLETO", priceBs: 10 }, { studyId: uuid(9), name: "ÁCIDO ÚRICO", priceBs: 55.5 }];
    const plain = formatSessionQuote(lines, 0, QUOTE_TEXTS);
    expect(plain).toContain("HEMOGRAMA COMPLETO — Bs 10");
    expect(plain).toContain("ÁCIDO ÚRICO — Bs 55,50");
    expect(plain).toContain("Total de los estudios cotizados: Bs 65,50");
    expect(plain).not.toContain(QUOTE_TEXTS.repeated_note);
    expect(formatSessionQuote(lines, 2, QUOTE_TEXTS)).toContain(QUOTE_TEXTS.repeated_note);
  });
});

describe("G5.9 · nombres habituales, abreviaturas y sinónimos: siempre validados contra el catálogo", () => {
  const ids = (text: string, catalog = CATALOG) => extractStudyRequests(text, catalog)?.result.studyIds ?? [];

  it("una abreviatura o sinónimo se reconoce SOLO si el catálogo tiene el estudio al que apunta", () => {
    expect(ids("bh")).toEqual([uuid(1)]);
    expect(ids("quiero una BH completa por favor")).toEqual([]);
    expect(ids("glucemia")).toEqual([uuid(2)]);
    expect(ids("azúcar en sangre")).toEqual([uuid(2)]);
    expect(ids("uroanálisis")).toEqual([uuid(5)]);
    expect(ids("orina completa")).toEqual([uuid(5)]);
    expect(ids("tirotropina")).toEqual([uuid(4)]);
    // el catálogo manda: sin estudio equivalente no hay nada que cotizar, y el fragmento queda sin resolver
    expect(ids("bh", [])).toEqual([]);
    expect(ids("vsg")).toEqual([]);
    expect(extractStudyRequests("hemograma y vsg", CATALOG)!.result).toMatchObject({ status: "UNRESOLVED", studyIds: [uuid(1)], unresolved: 1 });
    expect(ids("tgo")).toEqual([]);
  });

  it("si las frases del grupo llegan a estudios DISTINTOS del catálogo, es ambiguo: se pregunta, no se elige", () => {
    const split = [study(1, "HEMOGRAMA", []), study(2, "HEMOGRAMA COMPLETO", [])];
    expect(extractStudyRequests("bh", split)!.result).toMatchObject({ status: "AMBIGUOUS", studyIds: [], ambiguous: [[uuid(1), uuid(2)]] });
    // lo que el catálogo tiene tal cual gana a cualquier sinónimo
    expect(ids("hemograma", split)).toEqual([uuid(1)]);
    expect(ids("hemograma completo", split)).toEqual([uuid(2)]);
  });

  it("un sinónimo nunca cambia a un estudio retirado ni inventa uno", () => {
    expect(ids("bh", [study(1, "HEMOGRAMA COMPLETO", ["hemograma"], 10, false)])).toEqual([]);
  });

  it("los grupos solo contienen frases (nada de ids ni precios) y no se repiten entre grupos de forma contradictoria", async () => {
    const { STUDY_SYNONYM_GROUPS, synonymsOf } = await import("../src/study-synonyms.js");
    for (const group of STUDY_SYNONYM_GROUPS) {
      expect(group.length, group.join("|")).toBeGreaterThanOrEqual(2);
      for (const phrase of group) expect(phrase, phrase).toMatch(/^[a-z0-9áéíóúñ ]+$/i);
    }
    expect(synonymsOf("BH")).toContain("hemograma completo");
    expect(synonymsOf("hemograma")).toContain("bh");
    expect(synonymsOf("frase que no existe")).toEqual([]);
    expect(synonymsOf("bh")).not.toContain("bh");
  });
});

describe("G5.9 · listas de estudios", () => {
  const ids = (text: string) => extractStudyRequests(text, CATALOG)?.result.studyIds ?? [];

  it("una línea sin separadores se divide en los nombres del catálogo (el más largo primero) solo si TODA la línea queda cubierta", () => {
    expect(ids("hemograma glucosa tsh")).toEqual([uuid(1), uuid(2), uuid(4)]);
    expect(ids("quiero cotizar hemograma glucosa y orina")).toEqual([uuid(1), uuid(2), uuid(5)]);
    expect(ids("perfil de lipidos colesterol")).toEqual([uuid(6), uuid(3)]);
    // sobra una palabra que no es relleno: no se adivina nada
    expect(ids("hemograma glucosa postprandial")).toEqual([]);
    expect(extractStudyRequests("quiero cotizar hemograma glucosa postprandial", CATALOG)!.result).toMatchObject({ status: "UNRESOLVED", studyIds: [], unresolved: 1 });
  });

  it("viñetas y numeración al comienzo de cada línea no estorban", () => {
    expect(ids("1. hemograma\n2) glucosa\n- tsh\n• colesterol")).toEqual([uuid(1), uuid(2), uuid(4), uuid(3)]);
  });

  it("frases generales sin ningún estudio («unos análisis», «estudios de laboratorio») no dicen nada: no abren una solicitud sin resolver", () => {
    for (const text of ["quiero cotizar unos análisis", "necesito cotizar estudios de laboratorio", "me gustaría cotizar unos exámenes", "cotización de mi receta"]) expect(extractStudyRequests(text, CATALOG), text).toBeUndefined();
  });

  it("detecta si el mensaje pide cotizar o preguntar un precio", () => {
    expect(extractStudyRequests("cotízame hemograma y glucosa", CATALOG)).toMatchObject({ wantsQuote: true });
    expect(extractStudyRequests("¿cuánto cuesta el hemograma?", CATALOG)).toMatchObject({ wantsQuote: true });
    expect(extractStudyRequests("quiero que me cotices la glucosa", CATALOG)).toMatchObject({ wantsQuote: true });
    expect(extractStudyRequests("hemograma y glucosa", CATALOG)).toMatchObject({ wantsQuote: false });
    // Piloto 31/10/2026: un pedido claro («necesito…», «quiero…») se cotiza directamente; nombrar estudios sueltos sigue acumulando.
    expect(extractStudyRequests("necesito hacerme una glucosa", CATALOG)).toMatchObject({ wantsQuote: true });
  });
});

describe("G5.9 · respuestas cortas y preguntas generales", () => {
  it.each(["sí", "Si", "sii", "claro que si", "sí, esos estudios", "si por favor", "sí, eso es todo", "correcto", "de acuerdo", "adelante"])("YES: %s", (text) => {
    expect(parseSessionReply(text)).toEqual({ kind: "YES" });
  });
  it.each(["no", "aún no", "todavía no", "falta uno", "no, falta una foto", "espera", "un momento"])("NO: %s", (text) => {
    expect(parseSessionReply(text)).toEqual({ kind: "NO" });
  });
  it.each([["1", 1], ["2", 2], ["el segundo", 2], ["la primera", 1], ["opción 3", 3], ["el número 2", 2], ["quiero el tercero", 3], ["la 2 por favor", 2]])("CHOICE: %s", (text, index) => {
    expect(parseSessionReply(text)).toEqual({ kind: "CHOICE", index });
  });
  it.each(["hola", "gracias", "ya", "hemograma", "no sé qué estudios necesito", "sí quiero saber el horario de atención en la tarde", "9", "0", "no estoy listo", "", "ok listo ya mismo vamos a ver"])("no es una respuesta corta: %s", (text) => {
    expect(parseSessionReply(text)).toBeUndefined();
  });

  it.each(["¿qué es el hemograma?", "¿para qué sirve la glucosa?", "¿cómo se hace el examen de orina?", "¿puedo hacerme la glucosa sin ayuno?", "¿cuál es la diferencia entre hemograma y glucosa?"])("pregunta general: %s", (text) => {
    expect(isGeneralQuestion(text)).toBe(true);
  });
  it.each(["¿cuánto cuesta el hemograma?", "¿me puedes cotizar glucosa?", "precio del hemograma?", "hemograma y glucosa", "hemograma?", "quiero saber el costo de la tsh", "¿cuánto es el total?"])("no es una pregunta general: %s", (text) => {
    expect(isGeneralQuestion(text)).toBe(false);
  });
});

describe("G5.9 · aclaraciones y estado de la sesión", () => {
  const item = (n: number, over: Partial<SessionItem> = {}): SessionItem => ({ id: uuid(100 + n), seq: n, kind: "TEXT", status: "RESOLVED", studyIds: [], ambiguous: [], unresolved: 0, reasons: [], ...over });
  const amb = (n: number, groups: number[][], studyIds: number[] = []): SessionItem => item(n, { status: "AMBIGUOUS", studyIds: studyIds.map(uuid), ambiguous: groups.map((g) => g.map(uuid)), reasons: ["AMBIGUOUS_STUDY"] });

  it("una ambigüedad queda aclarada cuando un mensaje de TEXTO POSTERIOR identificado con certeza trae una de sus opciones", () => {
    const items = [item(1, { studyIds: [uuid(1)] }), amb(2, [[7, 8]]), item(3, { studyIds: [uuid(8)] })];
    expect(pendingGroupsOf(items[1]!, items)).toEqual([]);
    const result = evaluateSession(items, CATALOG);
    expect(result).toMatchObject({ kind: "QUOTE" });
    expect((result as { lines: Array<{ studyId: string }> }).lines.map((l) => l.studyId)).toEqual([uuid(1), uuid(8)]);
  });

  it("aporta los estudios que el mensaje ambiguo sí había identificado, y nunca la opción que no se eligió", () => {
    const items = [amb(1, [[7, 8]], [1]), item(2, { studyIds: [uuid(7)] })];
    const result = evaluateSession(items, CATALOG) as { kind: string; lines: Array<{ studyId: string }> };
    expect(result.kind).toBe("QUOTE");
    expect(result.lines.map((l) => l.studyId)).toEqual([uuid(1), uuid(7)]);
  });

  it("NO se aclara con un mensaje anterior, con una foto, con otro grupo, ni con una duda más", () => {
    const earlier = [item(1, { studyIds: [uuid(8)] }), amb(2, [[7, 8]])];
    expect(pendingGroupsOf(earlier[1]!, earlier)).toEqual([[uuid(7), uuid(8)]]);
    expect(evaluateSession(earlier, CATALOG)).toEqual({ kind: "REVIEW", reasons: ["AMBIGUOUS_STUDY"] });
    const photo = [amb(1, [[7, 8]]), item(2, { kind: "IMAGE", studyIds: [uuid(8)] })];
    expect(pendingGroupsOf(photo[0]!, photo)).toEqual([[uuid(7), uuid(8)]]);
    const twoGroups = [amb(1, [[7, 8], [9, 10]]), item(2, { studyIds: [uuid(8)] })];
    expect(pendingGroupsOf(twoGroups[0]!, twoGroups)).toEqual([[uuid(9), uuid(10)]]);
    const stillDoubtful = [amb(1, [[7, 8]]), item(2, { status: "AMBIGUOUS", studyIds: [uuid(8)], ambiguous: [[uuid(9), uuid(10)]] })];
    expect(pendingGroupsOf(stillDoubtful[0]!, stillDoubtful)).toEqual([[uuid(7), uuid(8)]]);
  });

  it("lo sin resolver y lo incierto siguen mandando a revisión aunque haya mensajes posteriores", () => {
    expect(evaluateSession([item(1, { status: "UNRESOLVED", unresolved: 1, reasons: ["UNRESOLVED_TEXT"] }), item(2, { studyIds: [uuid(1)] })], CATALOG)).toEqual({ kind: "REVIEW", reasons: ["UNRESOLVED_TEXT"] });
  });

  it("el resumen reúne lo anotado (sin repetidos) y las dudas, y las opciones salen solo de estudios ACTIVOS del catálogo", () => {
    const items = [item(1, { studyIds: [uuid(1), uuid(2)] }), amb(2, [[7, 8], [9, 10]], [2, 3]), item(3, { kind: "IMAGE", status: "UNCERTAIN", studyIds: [uuid(1)], reasons: ["ENGINE_PARTIAL"] }), item(4, { status: "DUPLICATE", kind: "IMAGE" })];
    expect(summarizeSession(items)).toEqual({ studyIds: [uuid(1), uuid(2), uuid(3)], pendingGroups: [[uuid(7), uuid(8)], [uuid(9), uuid(10)]], unresolved: 0, uncertain: true, unreadable: 0 });
    expect(optionsOf([uuid(7), uuid(8), uuid(10), uuid(99)], CATALOG)).toEqual([{ id: uuid(7), name: "CREATININA SERICA" }, { id: uuid(8), name: "CREATININA EN ORINA" }]);
  });

  it("con una duda de opciones va directo a la pregunta (sin repetir lo anotado); las opciones salen numeradas del catálogo, sin repetir lo que escribió el paciente", () => {
    const options = formatTextReply({ texts: QUOTE_TEXTS, head: QUOTE_TEXTS.added_text, names: ["HEMOGRAMA COMPLETO"], options: ["CREATININA SERICA", "CREATININA EN ORINA"], doubt: "OPTIONS", repeated: 0 });
    expect(options).toBe([QUOTE_TEXTS.ask_option_intro, "1. CREATININA SERICA", "2. CREATININA EN ORINA", QUOTE_TEXTS.ask_option_outro].join("\n"));
    expect(formatTextReply({ texts: QUOTE_TEXTS, names: ["TSH"], options: [], doubt: "NONE", repeated: 2 })).toBe(["Estudios anotados: TSH.", QUOTE_TEXTS.repeated_note, QUOTE_TEXTS.confirm_done].join("\n"));
    expect(formatTextReply({ texts: QUOTE_TEXTS, names: [], options: [], doubt: "UNRESOLVED", repeated: 0 })).toBe(QUOTE_TEXTS.ask_unresolved);
    for (const body of [options, QUOTE_TEXTS.confirm_done, QUOTE_TEXTS.ask_unresolved]) expect(body).not.toMatch(/Bs\s?\d|persona|equipo|asesor/i);
  });
});
