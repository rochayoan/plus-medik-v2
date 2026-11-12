import { describe, expect, it } from "vitest";
import { decideFuzzy, extractStudyRequests, extractWithNotes, FUZZY, matchOptionReply, parseSessionReply, preferredByMethod } from "../src/quote-session.js";
import type { SearchHit } from "../src/catalog-search.js";
import { study } from "./support/study-catalog.js";

// Listas reales de pacientes (11-nov), contra un catálogo sintético con los NOMBRES reales del laboratorio y precios inventados. Verifican que una lista escrita con siglas con puntos, títulos de sección,
// calificativos y nombres compuestos ya no se queda sin cotizar, y que lo dudoso se pregunta con opciones en vez de bloquear todo.
const C = [
  study(1, "HEMOGRAMA COMPLETO AUTOMATIZADO", ["hemograma completo", "hemograma"], 45),
  study(2, "GRUPO SANGUINEO", ["grupo sanguineo"], 25),
  study(3, "GLUCOSA", ["glucosa en ayunas"], 30),
  study(4, "CREATININA", [], 22),
  study(5, "TEST VDRL ( Semi Cuantitativo)", [], 60),
  study(6, "H.A.I. CHAGAS", [], 50),
  study(7, "H.A.I. TOXO", [], 55),
  study(8, "H.I.V 1,2", [], 70),
  study(9, "HIV 1,2 AG-AC 4ta GENERACION (Elisa)", [], 110),
  study(10, "HEPATITIS B ANTIGENO DE SUP. (PRUEBA RAPIDA)", [], 65),
  study(11, "HEPATITIS B ANTICUERPO DE SUP. PRUEBA RAPIDA", [], 65),
  study(12, "HEPATITIS B ANTIGENO DE SUP. (ECLIA)", [], 120),
  study(13, "EXAMEN GENERAL DE ORINA COMPLETA", [], 20),
  study(14, "TRANSAMINASA GOT", [], 28),
  study(15, "TRANSAMINASA GPT", [], 28),
  study(16, "FOSFATASA ALCALINA", [], 30),
  study(17, "BILIRRUBINA TOTAL Y FRACCIONES", [], 35),
  study(18, "GASOMETRIA", [], 150),
  study(19, "LACTATO EN SANGRE", [], 90),
  study(20, "COPROCULTIVO", [], 80),
  study(21, "UROCULTIVO", [], 75),
  study(22, "HEMOCULTIVO ADULTO - PEDIATRICO SERIADO X3- CONVENCIONAL", [], 400),
  study(23, "HEMOCULTIVO ADULTO - PEDIATRICO SERIADO X 2- CONVENCIONAL", [], 300),
  study(24, "TIEMPO DE SANGRIA", [], 15)
];
const name = (id: string) => C.find((s) => s.id === id)!.name;
const matchedNames = (text: string) => (extractStudyRequests(text, C, { fuzzy: true })?.matched ?? []).map((s) => s.name);

const LIST_A = "HEMATOLOGIA\n* Hemograma Completo\n* Grupo sanguíneo\nQUIMICA SANGUINEA\n* Glicemia (Basal)\n* Creatinina\nSEROLOGIA\n* V.D.R.L\n* H.A.I. Chagas\n* H.A.I.Toxo\n* H.I.V. 1.2.( P. Rápida)\n* Hepatitis B Ag.De Sup (P. Rápida)\nURIANALISIS\n* Examen General de Orina";
const LIST_B = "-Hemograma completo\n-Transaminasas GOT y GPT\n-Fosfatasa Alcalina\n-Bilirrubinas totales y fracciones\n-Gasometria arterial o venosa + lactato\n-Coprocultivo y antibiograma\n-Urocultivo y antibiograma\n-Hemocultivo seriado (dos muestras)";

describe("listas escritas reales: búsqueda por parecido con opciones", () => {
  it("lista de 10 estudios con títulos de sección, siglas con puntos y calificativos: casi todo se identifica y lo dudoso se pregunta", () => {
    const { extraction, notes } = extractWithNotes(LIST_A, C, { fuzzy: true });
    expect(extraction!.matched.map((s) => s.name).sort()).toEqual(["CREATININA", "EXAMEN GENERAL DE ORINA COMPLETA", "GLUCOSA", "GRUPO SANGUINEO", "H.A.I. CHAGAS", "H.A.I. TOXO", "H.I.V 1,2", "HEMOGRAMA COMPLETO AUTOMATIZADO", "TEST VDRL ( Semi Cuantitativo)"].sort());
    // los títulos HEMATOLOGIA, QUIMICA SANGUINEA, SEROLOGIA y URIANALISIS no cuentan como estudios sin resolver
    expect(extraction!.result.unresolved).toBe(0);
    expect(notes.notFound).toEqual([]);
    // hepatitis B rápida: dos opciones plausibles (antígeno o anticuerpo)
    const groups = extraction!.result.ambiguous.map((group) => group.map(name).sort());
    expect(groups).toContainEqual(["HEPATITIS B ANTICUERPO DE SUP. PRUEBA RAPIDA", "HEPATITIS B ANTIGENO DE SUP. (PRUEBA RAPIDA)"]);
    expect(extraction!.result.status).toBe("AMBIGUOUS");
    // lo interpretado se le muestra al paciente
    expect(notes.interpreted.map((item) => item.studyName)).toEqual(expect.arrayContaining(["TEST VDRL ( Semi Cuantitativo)", "EXAMEN GENERAL DE ORINA COMPLETA"]));
  });

  it("lista de 8 estudios con nombres compuestos: GOT y GPT son dos estudios; «totales y fracciones» y «arterial o venosa» no se rompen; el antibiograma no es un estudio", () => {
    const { extraction, notes } = extractWithNotes(LIST_B, C, { fuzzy: true });
    expect(extraction!.matched.map((s) => s.name).sort()).toEqual(["BILIRRUBINA TOTAL Y FRACCIONES", "COPROCULTIVO", "FOSFATASA ALCALINA", "GASOMETRIA", "HEMOCULTIVO ADULTO - PEDIATRICO SERIADO X 2- CONVENCIONAL", "HEMOGRAMA COMPLETO AUTOMATIZADO", "LACTATO EN SANGRE", "TRANSAMINASA GOT", "TRANSAMINASA GPT", "UROCULTIVO"].sort());
    expect(extraction!.result.unresolved).toBe(0);
    // «gasometría + lactato» son dos estudios; «hemocultivo seriado (dos muestras)» es la versión X 2: no se pregunta
    expect(extraction!.result.ambiguous).toEqual([]);
    expect(notes.notFound).toEqual([]);
  });

  it("«dos muestras» es la versión X 2; sin decir cuántas se pregunta X3 o X 2, y un estudio de otro nombre (retrocultivo) no se ofrece como opción", () => {
    const withRetro = [...C, study(91, "RETROCULTIVO ADULTO - PEDRIATRICO SERIADO X 2 - CONVENCIONAL", [], 300)];
    const two = extractStudyRequests("Hemocultivo seriado (dos muestras)", withRetro, { fuzzy: true })!;
    expect(two.matched.map((s) => s.name)).toEqual(["HEMOCULTIVO ADULTO - PEDIATRICO SERIADO X 2- CONVENCIONAL"]);
    const three = extractStudyRequests("Hemocultivo seriado tres muestras", withRetro, { fuzzy: true })!;
    expect(three.matched.map((s) => s.name)).toEqual(["HEMOCULTIVO ADULTO - PEDIATRICO SERIADO X3- CONVENCIONAL"]);
    const unspecified = extractStudyRequests("Hemocultivo seriado", withRetro, { fuzzy: true })!;
    expect(unspecified.matched).toEqual([]);
    expect(unspecified.result.ambiguous.map((group) => group.map((id) => withRetro.find((s) => s.id === id)!.name).sort())).toEqual([["HEMOCULTIVO ADULTO - PEDIATRICO SERIADO X 2- CONVENCIONAL", "HEMOCULTIVO ADULTO - PEDIATRICO SERIADO X3- CONVENCIONAL"]]);
  });

  it("un estudio que el catálogo no tiene se dice y no se confunde con otro; el resto se identifica", () => {
    const result = extractWithNotes("cotiza hemograma y VSG", C, { fuzzy: true });
    expect(result.extraction!.matched.map((s) => s.name)).toEqual(["HEMOGRAMA COMPLETO AUTOMATIZADO"]);
    expect(result.notes.notFound).toEqual(["VSG"]);
    expect(result.extraction!.result.status).toBe("RESOLVED");
  });

  it("palabras de relleno o de familia no son estudios ni se ofrecen como opciones", () => {
    const result = extractWithNotes("disculpe, es para mi hijo, hemograma", C, { fuzzy: true });
    expect(result.extraction!.matched.map((s) => s.name)).toEqual(["HEMOGRAMA COMPLETO AUTOMATIZADO"]);
    expect(result.extraction!.result.ambiguous).toEqual([]);
    expect(result.notes.notFound).toEqual([]);
  });

  it("solo estudios inexistentes: no hay solicitud que anotar, pero se informa cuáles faltan", () => {
    const result = extractWithNotes("quiero cotizar una radiografia de torax", C, { fuzzy: true });
    expect(result.extraction).toBeUndefined();
    expect(result.notes.notFound).toEqual(["radiografia de torax"]);
  });

  it("sin la búsqueda por parecido (por defecto) nada cambia: «glucoza» sigue sin resolverse", () => {
    const plain = extractStudyRequests("cotiza glucoza", C);
    expect(plain?.result.status).toBe("UNRESOLVED");
    expect(matchedNames("cotiza glucoza")).toEqual(["GLUCOSA"]);
  });

  it("una palabra suelta que es parte de muchos nombres, o una frase de cortesía, no se convierte en estudio", () => {
    const wide = [...C, study(41, "HEMOGRAMA COMPLETO", [], 1), study(42, "PERFIL COMPLETO A", [], 1), study(43, "PERFIL COMPLETO B", [], 1), study(44, "ORINA COMPLETA", [], 1), study(45, "SERICA COMPLETA", [], 1), study(46, "CREATININA SERICA", [], 1)];
    expect(extractWithNotes("completo", wide, { fuzzy: true }).extraction).toBeUndefined();
    expect(extractWithNotes("completo", wide, { fuzzy: true }).notes.notFound).toEqual([]);
    expect(extractWithNotes("¿cuánto sería todo?", wide, { fuzzy: true }).extraction).toBeUndefined();
  });
  it("nunca se acepta un estudio solo por parecerse: una frase larga o una palabra suelta que aparece en un nombre largo no se adivina", () => {
    expect(extractWithNotes("quiero saber si ustedes realizan cualquier tipo de examen con muestra de sangre", C, { fuzzy: true }).extraction).toBeUndefined();
  });
});

describe("decisión de la búsqueda por parecido", () => {
  const hit = (n: number, score: number, via = "x"): SearchHit => ({ study: C[n]!, score, via });
  it("acepta solo si lidera con claridad; si no, opciones; si nada se parece, no está", () => {
    expect(decideFuzzy([hit(12, 0.9), hit(9, 0.5)], "ego")).toMatchObject({ kind: "MATCHED" });
    expect(decideFuzzy([hit(4, 0.8)], "vdrl")).toMatchObject({ kind: "MATCHED" });
    expect(decideFuzzy([hit(9, 0.68), hit(10, 0.66)], "hepatitis")).toMatchObject({ kind: "AMBIGUOUS" });
    expect(decideFuzzy([hit(0, 0.5)], "algo")).toMatchObject({ kind: "NOTFOUND", mention: "algo" });
    expect(decideFuzzy([], "algo")).toMatchObject({ kind: "NOTFOUND" });
    expect(decideFuzzy([hit(9, 0.68), hit(10, 0.66)], "hepatitis", "STRONG_ONLY")).toEqual({ kind: "UNMATCHED" });
    expect(FUZZY.strong).toBeGreaterThan(FUZZY.unique);
  });
  it("las opciones nunca pasan de cuatro ni incluyen lo que apenas se parece", () => {
    const many = [hit(1, 0.7), hit(2, 0.69), hit(3, 0.68), hit(4, 0.67), hit(5, 0.66), hit(6, 0.4)];
    const decided = decideFuzzy(many, "x");
    expect(decided.kind).toBe("AMBIGUOUS");
    if (decided.kind === "AMBIGUOUS") expect(decided.candidates).toHaveLength(FUZZY.maxOptions);
  });
});

describe("elegir una o varias opciones, como en una votación", () => {
  it("«el segundo de 300» (con el precio que ve en la opción) es la opción 2", () => {
    expect(parseSessionReply("el segundo de 300")).toEqual({ kind: "CHOICE", index: 2 });
    expect(parseSessionReply("la 1 de Bs 160")).toEqual({ kind: "CHOICE", index: 1 });
    expect(parseSessionReply("quiero 300 hemogramas")).toBeUndefined();
  });
  it("«1 y 3», «1, 2 y 4» y «la 1 y la 2» eligen varias; un número solo sigue eligiendo una", () => {
    expect(parseSessionReply("1 y 3")).toEqual({ kind: "CHOICE", index: 1, indexes: [1, 3] });
    expect(parseSessionReply("1, 2 y 4")).toEqual({ kind: "CHOICE", index: 1, indexes: [1, 2, 4] });
    expect(parseSessionReply("la 1 y la 2")).toEqual({ kind: "CHOICE", index: 1, indexes: [1, 2] });
    expect(parseSessionReply("2")).toEqual({ kind: "CHOICE", index: 2 });
    expect(parseSessionReply("la 2 por favor")).toEqual({ kind: "CHOICE", index: 2 });
  });
  it("una elección con cortesías alrededor también se entiende: «estaría bien la 1», «mejor la 2», «me quedo con la 1 y la 3»", () => {
    expect(parseSessionReply("estaría bien la 1")).toEqual({ kind: "CHOICE", index: 1 });
    expect(parseSessionReply("mejor la 2 por favor")).toEqual({ kind: "CHOICE", index: 2 });
    expect(parseSessionReply("la 1 está bien")).toEqual({ kind: "CHOICE", index: 1 });
    expect(parseSessionReply("me quedo con la 1 y la 3")).toEqual({ kind: "CHOICE", index: 1, indexes: [1, 3] });
    expect(parseSessionReply("si dale la opcion 2")).toEqual({ kind: "CHOICE", index: 2 });
  });
  it("un mensaje que mezcla números con otras palabras no es una elección", () => {
    expect(parseSessionReply("1 y hemograma")).toBeUndefined();
    expect(parseSessionReply("quiero 2 hemogramas")).toBeUndefined();
  });
});

describe("sin método especificado se asume el más rápido (ECLIA, luego CLIA) — regla del laboratorio, 12-nov", () => {
  const TSH_E = study(61, "TSH (ECLIA)", ["tsh"], 80);
  const TSH_F = study(62, "TSH (FIA Fluorescencia)", ["tsh"], 70);
  const TSH_N = study(63, "TSH NEONATAL", ["tsh"], 60);
  const VIT_E = study(64, "VITAMINA D 25 (OH) (ECLIA)", ["vitamina d"], 120);
  const VIT_F = study(65, "VITAMINA D 25 (OH) (FIA Fluorescencia)", ["vitamina d"], 100);
  const VIT_1 = study(66, "VITAMINA D 1,25 Dihidroxi Calciferol", ["vitamina d"], 200);
  const FER_C = study(67, "FERRITINA (CLIA)", ["ferritina"], 90);
  const FER_P = study(68, "PERFIL FERROCINETICO (HIERRO, FERRITINA, TRANSFERRINA)", ["ferritina"], 150);
  const ANTI_S = study(69, "ANTI-DNA ss (Simple Cadena) IgG (Elisa)", ["anti dna"], 90);
  const ANTI_D = study(70, "ANTI-DNA ds (Doble Cadena) IgG (Elisa)", ["anti dna"], 95);
  const M = [TSH_E, TSH_F, TSH_N, VIT_E, VIT_F, VIT_1, FER_C, FER_P, ANTI_S, ANTI_D];
  const ids = (text: string) => (extractStudyRequests(text, M, { fuzzy: true })?.matched ?? []).map((s) => s.id);

  it("TSH, vitamina D y ferritina sin método van a la versión ECLIA/CLIA y se le dice al paciente", () => {
    expect(ids("tsh")).toEqual([TSH_E.id]);
    expect(ids("vitamina D")).toEqual([VIT_E.id]);
    expect(ids("ferritina")).toEqual([FER_C.id]);
    expect(extractWithNotes("tsh", M, { fuzzy: true }).notes.interpreted).toEqual([{ mention: "tsh", studyName: "TSH (ECLIA)" }]);
  });
  it("si el paciente dice el método o la variante, se respeta", () => {
    expect(ids("tsh neonatal")).toEqual([TSH_N.id]);
    expect(ids("tsh fia")).toEqual([TSH_F.id]);
  });
  it("sin un método rápido único (estudios distintos entre sí) se sigue preguntando: anti-DNA simple o doble cadena", () => {
    const result = extractStudyRequests("anti dna", M, { fuzzy: true })!;
    expect(result.matched).toEqual([]);
    expect(result.result.ambiguous).toHaveLength(1);
  });
  it("sin la búsqueda por parecido (por defecto) nada cambia: «tsh» sigue siendo una duda", () => {
    expect(extractStudyRequests("tsh", M)!.result.ambiguous).toHaveLength(1);
  });
  it("preferredByMethod: uno solo con el mejor método; dos con ECLIA no se eligen; sin ECLIA ni CLIA no hay preferida", () => {
    expect(preferredByMethod([TSH_E, TSH_F])).toBe(TSH_E);
    expect(preferredByMethod([FER_C, FER_P])).toBe(FER_C);
    expect(preferredByMethod([TSH_E, VIT_E])).toBeUndefined();
    expect(preferredByMethod([ANTI_S, ANTI_D])).toBeUndefined();
    expect(preferredByMethod([study(71, "X (ECLIA)", [], 1), study(72, "Y (CLIA)", [], 1)])).toMatchObject({ name: "X (ECLIA)" });
  });
});

describe("lista que llega como mensajes separados (motor de lotes, producción)", () => {
  it("una sigla con puntos y un título de sección suelto no se pierden ni se reportan como «no está en el catálogo»", async () => {
    const { understandBatch, EMPTY_SESSION } = await import("../src/batch-understanding.js");
    const { decideBatch } = await import("../src/batch-policy.js");
    const fragments = ["SEROLOGIA", "* V.D.R.L", "* Hemograma Completo", "QUIMICA SANGUINEA", "* Glicemia (Basal)"].map((text, index) => ({ id: `f${index}`, text }));
    const understanding = await understandBatch({ fragments, catalog: C, session: EMPTY_SESSION, modelUse: "never" });
    expect(understanding.studies.notFound).toEqual([]);
    expect(understanding.studies.matchedIds.map(name).sort()).toEqual(["GLUCOSA", "HEMOGRAMA COMPLETO AUTOMATIZADO", "TEST VDRL ( Semi Cuantitativo)"]);
    // una lista de varios estudios sin dudas se cotiza directo
    const plan = decideBatch({ understanding });
    expect(plan.core.kind, JSON.stringify([plan.core, understanding.request])).toBe("QUOTE");
  });
  it("un título de sección que también es un estudio («urianálisis») no se descarta", () => {
    const withUrinalysis = extractStudyRequests("urianalisis", C, { fuzzy: true });
    expect(withUrinalysis?.matched.map((s) => s.name) ?? []).toEqual(["EXAMEN GENERAL DE ORINA COMPLETA"]);
  });
});

describe("palabras sueltas y frases corrientes dentro de una conversación (motor de lotes)", () => {
  const plan = async (messages: string[]) => {
    const { understandBatch, EMPTY_SESSION } = await import("../src/batch-understanding.js");
    const { decideBatch } = await import("../src/batch-policy.js");
    const understanding = await understandBatch({ fragments: messages.map((text, index) => ({ id: `f${index}`, text })), catalog: C, session: EMPTY_SESSION, modelUse: "never" });
    return decideBatch({ understanding });
  };
  it("«es para mi hijo» no es un estudio ni una duda: sigue la conversación de siempre, sin «no pude identificar»", async () => {
    const p = await plan(["es para mi hijo"]);
    expect(p.core).toMatchObject({ kind: "PROMPT", reason: "OTHER" });
  });
  it("junto a una lista, esa frase no estorba: se cotiza la lista", async () => {
    const p = await plan(["Hemograma", "Glucosa", "es para mi hijo"]);
    expect(p.core.kind).toBe("QUOTE");
    expect(p.notices).toEqual([]);
  });
  it("una palabra suelta que no existe en el catálogo, dentro de una lista, se cotiza el resto y se AVISA cuál no está (nunca se descarta en silencio)", async () => {
    const p = await plan(["Hemograma", "Glucosa", "Tiroides"]);
    expect(p.core.kind).toBe("QUOTE");
    expect(p.notices).toContainEqual({ kind: "STUDIES_NOT_IN_CATALOG", mentions: ["Tiroides"] });
  });
  it("«quiero cotizar tiroides» (nada identificado): se dice que no está en el catálogo y se pide el estudio", async () => {
    const p = await plan(["Quiero cotizar tiroides"]);
    expect(p.core).toMatchObject({ kind: "PROMPT", reason: "QUOTE_WITHOUT_STUDIES" });
    expect(p.notices).toContainEqual({ kind: "STUDIES_NOT_IN_CATALOG", mentions: ["tiroides"] });
  });
});

describe("temas en lugar de nombres («tiroides», «hígado»): el agente ofrece los estudios del catálogo con su precio", () => {
  const TSH_E = study(81, "TSH (ECLIA)", ["tsh"], 90);
  const TSH_F = study(82, "TSH (FIA Fluorescencia)", ["tsh"], 100);
  const T4 = study(83, "T4 LIBRE (ECLIA)", [], 90);
  const T3 = study(84, "T3 LIBRE (ECLIA)", [], 150);
  const HEMO = study(85, "HEMOGRAMA COMPLETO AUTOMATIZADO", ["hemograma completo", "hemograma"], 45);
  const FERR = study(86, "FERRITINA (CLIA)", ["ferritina"], 130);
  const FERR_P = study(87, "PERFIL FERROCINETICO (HIERRO, FERRITINA, TRANSFERRINA)", ["ferritina"], 350);
  const HIERRO = study(88, "HIERRO SERICO", [], 60);
  const GLU = study(89, "GLUCOSA", ["glucosa"], 30);
  const T = [TSH_E, TSH_F, T4, T3, HEMO, FERR, FERR_P, HIERRO, GLU];
  const names = (ids: readonly string[]) => ids.map((id) => T.find((s) => s.id === id)!.name);

  it("«tiroides» no es un estudio: se ofrecen TSH, T4 libre y T3 libre del catálogo (sin elegir uno por su método)", () => {
    const result = extractStudyRequests("Tiroides", T, { fuzzy: true })!;
    expect(result.matched).toEqual([]);
    expect(result.result.ambiguous).toHaveLength(1);
    expect(names(result.result.ambiguous[0]!).sort()).toEqual(["T3 LIBRE (ECLIA)", "T4 LIBRE (ECLIA)", "TSH (ECLIA)"]);
  });
  it("lo mismo dentro de una frase corta: «necesito algo de la tiroides» y «los de la tiroides»", () => {
    for (const text of ["necesito algo de la tiroides", "los de la tiroides"]) expect(extractStudyRequests(text, T, { fuzzy: true })!.result.ambiguous).toHaveLength(1);
  });
  it("anemia ofrece hemograma, ferritina y hierro: tres estudios distintos que NO se reducen a uno por su método (CLIA)", () => {
    const result = extractStudyRequests("anemia", T, { fuzzy: true })!;
    expect(result.matched).toEqual([]);
    expect(names(result.result.ambiguous[0]!).sort()).toEqual(["FERRITINA (CLIA)", "HEMOGRAMA COMPLETO AUTOMATIZADO", "HIERRO SERICO"]);
  });
  it("si el catálogo solo tiene UN estudio del tema se anota ese; si no tiene ninguno, se dice que no está", () => {
    const only = extractStudyRequests("azucar", [GLU], { fuzzy: true })!;
    expect(only.matched.map((s) => s.name)).toEqual(["GLUCOSA"]);
    const none = extractWithNotes("tiroides", [HEMO], { fuzzy: true });
    expect(none.extraction).toBeUndefined();
    expect(none.notes.notFound).toEqual(["tiroides"]);
  });
  it("el paciente elige con números, con «y» o con «todos»; las opciones muestran el precio vigente", async () => {
    expect(parseSessionReply("todos")).toEqual({ kind: "CHOICE", index: 1, all: true });
    expect(parseSessionReply("ambos por favor")).toEqual({ kind: "CHOICE", index: 1, all: true });
    expect(parseSessionReply("quiero todos")).toEqual({ kind: "CHOICE", index: 1, all: true });
    const { optionsOf } = await import("../src/quote-session.js");
    expect(optionsOf([TSH_E.id, T4.id], T).map((option) => option.label)).toEqual(["TSH (ECLIA) — Bs 90", "T4 LIBRE (ECLIA) — Bs 90"]);
  });
  it("de punta a punta: «tiroides» pregunta con las opciones; «todos» las cotiza", async () => {
    const { understandBatch, EMPTY_SESSION } = await import("../src/batch-understanding.js");
    const { decideBatch } = await import("../src/batch-policy.js");
    const first = await understandBatch({ fragments: [{ id: "a", text: "Tiroides" }], catalog: T, session: EMPTY_SESSION, modelUse: "never" });
    const ask = decideBatch({ understanding: first });
    expect(ask.core.kind).toBe("CLARIFY");
    const group = first.studies.ambiguous[0]!.candidateIds;
    expect(group).toHaveLength(3);
    const all = await understandBatch({ fragments: [{ id: "b", text: "todos" }], catalog: T, session: { ...EMPTY_SESSION, open: true, pendingGroups: [group] }, modelUse: "never" });
    const quote = decideBatch({ understanding: all });
    expect(quote.core.kind).toBe("QUOTE");
    expect(names((quote.core as { studyIds: string[] }).studyIds).sort()).toEqual(["T3 LIBRE (ECLIA)", "T4 LIBRE (ECLIA)", "TSH (ECLIA)"]);
  });
});

describe("una respuesta que no se entiende con una pregunta abierta: se vuelve a preguntar, no se pierde el hilo", () => {
  const A = study(101, "LACTATO EN SANGRE", [], 160);
  const B = study(102, "GASOMETRIA + LACTATO", [], 330);
  const H = study(103, "HEMOGRAMA COMPLETO AUTOMATIZADO", ["hemograma"], 45);
  const catalog = [A, B, H];
  const open = async (text: string) => {
    const { understandBatch, EMPTY_SESSION } = await import("../src/batch-understanding.js");
    const { decideBatch } = await import("../src/batch-policy.js");
    const understanding = await understandBatch({ fragments: [{ id: "x", text }], catalog, session: { ...EMPTY_SESSION, open: true, studyIds: [H.id], pendingGroups: [[A.id, B.id]] }, modelUse: "never" });
    return decideBatch({ understanding });
  };
  it("«el que sea» vuelve a mostrar las opciones con el aviso de opción inválida y no se le deja a la conversación libre (que perdería el hilo)", async () => {
    const plan = await open("el que sea");
    expect(plan.core).toMatchObject({ kind: "CLARIFY", questions: [{ kind: "OPTIONS", invalidChoice: true }] });
  });
  it("«no sé cuál» y «mmm» también vuelven a preguntar las mismas opciones", async () => {
    for (const text of ["no se cual", "mmm"]) expect((await open(text)).core, text).toMatchObject({ kind: "CLARIFY", questions: [{ kind: "OPTIONS" }] });
  });
  it("«el segundo de 330», «estaría bien la 1» y «todos» sí se entienden", async () => {
    for (const text of ["el segundo de 330", "estaria bien la 1", "todos"]) expect((await open(text)).core.kind, text).toBe("QUOTE");
  });
  it("una pregunta de información en medio sigue su camino (no se confunde con una respuesta inválida)", async () => {
    const plan = await open("¿a qué hora abren?");
    expect(plan.delegatedQuestionIds.length).toBeGreaterThan(0);
  });
});

describe("responder a las opciones con palabras, no solo con números", () => {
  const options = [
    { name: "LACTATO EN SANGRE", priceBs: 160 },
    { name: "GASOMETRIA + LACTATO", priceBs: 330 },
    { name: "LDH (Lactato deshidrogenasa) de LIQUIDOS", priceBs: 80 }
  ];
  const hemo = [
    { name: "HEMOCULTIVO ADULTO - PEDIATRICO SERIADO X 2- CONVENCIONAL", priceBs: 300 },
    { name: "HEMOCULTIVO ADULTO - PEDIATRICO SERIADO X3- CONVENCIONAL", priceBs: 450 }
  ];
  it("lo que distingue a cada opción: «el de sangre», «la gasometría con lactato», «el ldh»", () => {
    expect(matchOptionReply("el de sangre", options)).toEqual([1]);
    expect(matchOptionReply("la gasometria con lactato", options)).toEqual([2]);
    expect(matchOptionReply("el ldh", options)).toEqual([3]);
    expect(matchOptionReply("el de liquidos por favor", options)).toEqual([3]);
  });
  it("por precio y por cantidad de muestras: «el de 450», «el de tres muestras», «el x2»", () => {
    expect(matchOptionReply("el de 450", hemo)).toEqual([2]);
    expect(matchOptionReply("el de tres muestras", hemo)).toEqual([2]);
    expect(matchOptionReply("el de dos muestras", hemo)).toEqual([1]);
    expect(matchOptionReply("el x3", hemo)).toEqual([2]);
  });
  it("superlativos: «el más barato», «el más caro», «el último»", () => {
    expect(matchOptionReply("el mas barato", options)).toEqual([3]);
    expect(matchOptionReply("el mas caro", options)).toEqual([2]);
    expect(matchOptionReply("el ultimo", options)).toEqual([3]);
  });
  it("varias unidas con «y»", () => {
    expect(matchOptionReply("el de sangre y la gasometria", options)).toEqual([1, 2]);
    expect(matchOptionReply("ambos, el de sangre y la gasometria", options)).toEqual([1, 2]);
  });
  it("lo que no habla de las opciones (otro estudio, una pregunta) NO es una respuesta: no se toma por una elección", () => {
    for (const text of ["quiero tambien glucosa", "hemograma", "cuanto tarda", "no se cual", "mmm"]) expect(matchOptionReply(text, options), text).toBeUndefined();
  });
  it("si lo escrito cuadra con varias opciones y no las une, no se adivina: se vuelve a preguntar", () => {
    expect(matchOptionReply("el de lactato", options)).toBeUndefined();
  });
  it("de punta a punta con una pregunta abierta: «el de sangre» elige y cotiza; «hemograma» no estorba", async () => {
    const { understandBatch, EMPTY_SESSION } = await import("../src/batch-understanding.js");
    const { decideBatch } = await import("../src/batch-policy.js");
    const A = study(111, "LACTATO EN SANGRE", [], 160), B = study(112, "GASOMETRIA + LACTATO", [], 330), H = study(113, "HEMOGRAMA COMPLETO AUTOMATIZADO", ["hemograma"], 45);
    const run = async (text: string) => decideBatch({ understanding: await understandBatch({ fragments: [{ id: "x", text }], catalog: [A, B, H], session: { ...EMPTY_SESSION, open: true, studyIds: [H.id], pendingGroups: [[A.id, B.id]] }, modelUse: "never" }) });
    const chosen = await run("el de sangre");
    expect(chosen.core).toMatchObject({ kind: "QUOTE" });
    expect((chosen.core as { studyIds: string[] }).studyIds.sort()).toEqual([A.id, H.id].sort());
    const both = await run("la gasometria");
    expect((both.core as { studyIds: string[] }).studyIds.sort()).toEqual([B.id, H.id].sort());
    expect((await run("no se cual")).core.kind).toBe("CLARIFY");
  });
});

describe("varias opciones escritas como cada quien quiera: comas, «y», «/», «+», «&», espacios, rangos o ninguna palabra de unión", () => {
  const options = [
    { name: "LACTATO EN SANGRE", priceBs: 160 },
    { name: "GASOMETRIA + LACTATO", priceBs: 330 },
    { name: "LDH (Lactato deshidrogenasa) de LIQUIDOS", priceBs: 80 }
  ];
  it.each(["1,3", "1, 3", "1 y 3", "1/3", "1+3", "1&3", "1 3", "1 e 3", "la 1 y la 3", "1 también el 3", "1;3"])("números: «%s» elige 1 y 3", (text) => {
    const reply = parseSessionReply(text);
    expect(reply?.kind === "CHOICE" ? (reply.indexes ?? [reply.index]) : undefined, text).toEqual([1, 3]);
  });
  it.each([["del 1 al 3", [1, 2, 3]], ["de la 2 a la 3", [2, 3]], ["1-2", [1, 2]]] as const)("rangos: «%s»", (text, expected) => {
    const reply = parseSessionReply(text);
    expect(reply?.kind === "CHOICE" ? (reply.indexes ?? [reply.index]) : undefined, text).toEqual([...expected]);
  });
  it.each(["el de sangre, la gasometria", "sangre / gasometria", "sangre + gasometria", "sangre & gasometria", "sangre gasometria", "el de sangre y la gasometria", "sangre; gasometria", "ambos: el de sangre y la gasometria"])("palabras: «%s» elige las opciones 1 y 2", (text) => {
    expect(matchOptionReply(text, options), text).toEqual([1, 2]);
  });
  it("precios: «160, 330» elige 1 y 2; un precio repetido o inexistente no adivina", () => {
    expect(matchOptionReply("160, 330", options)).toEqual([1, 2]);
    expect(matchOptionReply("el de 999", options)).toBeUndefined();
  });
  it("una palabra que encaja con varias opciones no se adivina («lactato» es de las tres)", () => {
    expect(matchOptionReply("lactato", options)).toBeUndefined();
    expect(matchOptionReply("lactato, ldh", options)).toEqual([3]);
  });
});

describe("confirmar, agregar y cancelar con las palabras de cada quien (auditoría de rigidez, 12-nov)", () => {
  const H = study(121, "HEMOGRAMA COMPLETO AUTOMATIZADO", ["hemograma"], 45);
  const intentOf = async (text: string) => {
    const { understandBatch, EMPTY_SESSION } = await import("../src/batch-understanding.js");
    const understanding = await understandBatch({ fragments: [{ id: "x", text }], catalog: [H], session: { ...EMPTY_SESSION, open: true, studyIds: [H.id] }, modelUse: "never" });
    return understanding.intent;
  };
  const CONFIRM = ["sí", "listo", "ya está", "ya esta todo", "eso es todo", "nada más", "nomás eso", "así está bien", "está bien así", "correcto", "no falta nada", "ya no necesito más", "con eso nomás", "me parece bien", "eso sería todo gracias", "gracias, eso es todo"];
  it.each(CONFIRM)("«%s» confirma (cotiza lo anotado)", async (text) => {
    expect(["CONFIRM", "QUOTE"]).toContain(await intentOf(text));
  });
  it.each(["tengo más", "me faltan", "falta uno", "hay otro", "espera", "no"])("«%s» dice que falta algo (no cotiza aún)", async (text) => {
    expect(await intentOf(text)).toBe("MORE");
  });
  it.each(["cancelar", "cancela todo por favor", "olvídalo", "ya no quiero", "mejor cancélalo", "borra todo", "empezar de nuevo", "anula la solicitud"])("«%s» cancela la solicitud", async (text) => {
    expect(await intentOf(text)).toBe("CANCEL");
  });
  it.each(["cancelar mi cita", "quiero cancelar mi cita médica", "ok", "gracias", "hola", "dale", "perfecto", "vale"])("«%s» NO cancela ni confirma (otra cosa o solo un acuse)", async (text) => {
    expect(["CANCEL", "CONFIRM"]).not.toContain(await intentOf(text));
  });
});
