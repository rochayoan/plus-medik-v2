import { describe, expect, it } from "vitest";
import { decideFuzzy, extractStudyRequests, extractWithNotes, FUZZY, parseSessionReply, preferredByMethod } from "../src/quote-session.js";
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
    expect(extraction!.matched.map((s) => s.name).sort()).toEqual(["BILIRRUBINA TOTAL Y FRACCIONES", "COPROCULTIVO", "FOSFATASA ALCALINA", "GASOMETRIA", "HEMOGRAMA COMPLETO AUTOMATIZADO", "LACTATO EN SANGRE", "TRANSAMINASA GOT", "TRANSAMINASA GPT", "UROCULTIVO"].sort());
    expect(extraction!.result.unresolved).toBe(0);
    // «gasometría + lactato» son dos estudios; el hemocultivo seriado se pregunta: dos opciones
    expect(extraction!.result.ambiguous.map((group) => group.map(name).sort())).toContainEqual(["HEMOCULTIVO ADULTO - PEDIATRICO SERIADO X 2- CONVENCIONAL", "HEMOCULTIVO ADULTO - PEDIATRICO SERIADO X3- CONVENCIONAL"]);
    expect(notes.notFound).toEqual([]);
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
