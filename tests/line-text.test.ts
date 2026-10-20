import { describe, expect, it } from "vitest";
import { assembleAnalysis, finalVisualStudiesOf, type DocumentGate } from "../src/analyze.js";
import { legacyReadingSchema, simpleReaderInstructionsFor, simpleReadingSchema, type SimpleReading } from "../src/ai.js";
import { buildSimpleConsensus, normalizeStudyKey, type SimpleStudy } from "../src/consensus.js";
import { collapseExplicitPackages, droppedLineItems, heldPackageGroups, lineServiceGap, reliableLineText, separatelyRequested } from "../src/line-groups.js";
import type { CatalogStudy } from "../src/types.js";

// lineText: el texto completo de la línea conserva la agrupación original de los estudios (también con "+", "/" o combinaciones). Analitos inventados.

const study = (code: string, name: string, priceBs: number, category = "QUIMICA SANGUINEA", aliases: string[] = []): CatalogStudy => ({
  id: `uuid-${code}`, code, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active: true, category
});
const zeta = study("z", "ZETAINA", 30);
const kappa = study("k", "KAPPAINA EN SANGRE", 40);
const zk = study("zk", "ZETAINA + KAPPAINA", 60);
const slash = study("zs", "OMEGAINA + SIGMAINA", 90, "QUIMICA SANGUINEA", ["Omegaina / Sigmaina", "Omegaina y Sigmaina"]);
const ratio = study("ra", "COCIENTE ALFAINA / BETAINA", 70);
const alfaina = study("al", "ALFAINA", 12);
const betaina = study("be", "BETAINA", 14);
const omega = study("o", "OMEGAINA", 15);
const sigma = study("s", "SIGMAINA", 25);
const cultAlfa = study("c1", "CULTIVO DE ALFA", 50, "BACTERIOLOGIA - MICROBIOLOGIA");
const cultBeta = study("c2", "CULTIVO DE BETA CON ANTIBIOGRAMA", 90, "BACTERIOLOGIA - MICROBIOLOGIA");
const catalog = [zeta, kappa, zk, slash, omega, sigma, cultAlfa, cultBeta, ratio, alfaina, betaina];

const doc: DocumentGate = { documentType: "MARK_DEPENDENT_FORM", completeDocumentVisible: true, agreement: true, integrityProblems: [], integrityKinds: [] };
const row = (literalText: string, lineText?: string, confidence: SimpleStudy["confidence"] = "high"): SimpleStudy => ({ literalText, normalizedName: literalText, evidence: "check", confidence, ...(lineText === undefined ? {} : { lineText }) });
const reading = (...rows: SimpleStudy[]): SimpleReading => ({ requestedStudies: rows, uncertainStudies: [], notes: "" });
const finals = (a: SimpleReading, b: SimpleReading = a, cat = catalog) => finalVisualStudiesOf(buildSimpleConsensus(a, b), { resolvedStudies: [], unresolvedDisputes: [] }, cat);
const analyze = (a: SimpleReading, b: SimpleReading = a, cat = catalog) =>
  assembleAnalysis({ consensus: buildSimpleConsensus(a, b), judgement: { resolvedStudies: [], unresolvedDisputes: [] }, catalog: cat, document: doc, partialAuto: true });

describe("contrato de los lectores: lineText", () => {
  it("el prompt actual pide lineText con la misma línea para estudios agrupados; el anterior no", () => {
    const current = simpleReaderInstructionsFor(false);
    expect(current).toContain("- lineText: el texto COMPLETO de la línea");
    expect(current).toContain("todos devuelven la MISMA lineText");
    expect(current).toContain("No inventes ni completes texto que no se vea");
    expect(simpleReaderInstructionsFor(true)).not.toContain("lineText");
  });
  it("el esquema actual exige lineText (obligatorio) y el anterior lo ignora", () => {
    const base = { literalText: "a", normalizedName: "a", evidence: "check", confidence: "high" };
    expect(simpleReadingSchema.safeParse({ requestedStudies: [base], uncertainStudies: [], notes: "" }).success).toBe(false);
    expect(simpleReadingSchema.safeParse({ requestedStudies: [{ ...base, lineText: "a" }], uncertainStudies: [], notes: "" }).success).toBe(true);
    expect(legacyReadingSchema.safeParse({ requestedStudies: [base], uncertainStudies: [], notes: "" }).success).toBe(true);
  });
});

describe("reliableLineText: solo cuando las dos lecturas coinciden", () => {
  it("coinciden (con otro espaciado o mayúsculas), una es truncación de la otra, o no hay", () => {
    expect(reliableLineText(row("a", "Zetaina + Kappaina"), row("a", "ZETAINA +  KAPPAINA"))).toBe("Zetaina + Kappaina");
    // una línea más corta o de otra línea NO se completa con la otra lectura
    expect(reliableLineText(row("a", "Zetaina + Kappaina"), row("a", "Zetaina"))).toBeUndefined();
    expect(reliableLineText(row("a", "Zetaina + Kappaina"), row("a", "Zetaina +"))).toBeUndefined();
    expect(reliableLineText(row("a", "Zetaina + Kappaina"), row("a", "Zetaina + Omegaina"))).toBeUndefined();
    expect(reliableLineText(row("a", "Zetaina"), row("a"))).toBeUndefined();
    expect(reliableLineText(row("a", "  "), row("a", "  "))).toBeUndefined();
    expect(reliableLineText(undefined, undefined)).toBeUndefined();
  });
  it("finalVisualStudiesOf conserva el lineText fiable, también cuando el juez confirma, y lo omite si las lecturas discrepan", () => {
    const agreed = finals(reading(row("Zetaina", "Zetaina + Kappaina")), reading(row("Zetaina", "zetaina + kappaina")), []);
    expect(agreed[0]?.lineText).toBe("Zetaina + Kappaina");
    expect(finals(reading(row("Zetaina", "Zetaina + Kappaina")), reading(row("Zetaina", "otra cosa")), [])[0]?.lineText).toBeUndefined();
    const a = reading(row("Glucosa", "Glucosa", "medium"));
    const b = reading(row("Glucosa", "Glucosa"));
    const consensus = buildSimpleConsensus(a, b);
    const judged = finalVisualStudiesOf(consensus, { resolvedStudies: consensus.disputes.map((d) => ({ key: d.key, verdict: "confirmed" as const, study: d.readerA.requested!, reason: "" })), unresolvedDisputes: [] });
    expect(judged[0]).toMatchObject({ source: "judge_confirmed", lineText: "Glucosa" });
  });
});

describe("paquete aprobado por IDENTIDAD EXPLÍCITA de la línea", () => {
  const both = (...pairs: Array<[string, string]>) => reading(...pairs.map(([text, line]) => row(text, line)));

  it("las filas que los lectores separaron se reconstruyen en el paquete cuando la línea ES su nombre aprobado", () => {
    const result = analyze(both(["Zetaina", "ZETAINA + KAPPAINA"], ["Kappaina en sangre", "ZETAINA + KAPPAINA"]));
    expect(result.finalVisualStudies).toHaveLength(1);
    expect(result.finalVisualStudies[0]).toMatchObject({ literalText: "ZETAINA + KAPPAINA", collapsedFrom: ["Zetaina", "Kappaina en sangre"] });
    expect(result.decision).toBe("AUTO_SAFE");
    expect(result.internal?.quoted.lines.map((l) => [l.code, l.priceBs])).toEqual([["zk", 60]]);
    expect(result.publicQuote?.totalBs).toBe(60);
    expect(result.quote?.lines.map((l) => l.code)).toEqual(["zk"]);
  });

  it("con '/' y con un alias aprobado de la línea también", () => {
    const viaName = analyze(both(["Omegaina", "OMEGAINA / SIGMAINA"], ["Sigmaina", "OMEGAINA / SIGMAINA"]));
    expect(viaName.internal?.quoted.lines.map((l) => l.code)).toEqual(["zs"]);
    // un estudio aprobado con '/' que NO es un paquete de componentes (un cociente) separado en filas: queda pendiente, nunca cobrar A y B por separado
    const ratioRows = analyze(both(["Alfaina", "COCIENTE ALFAINA / BETAINA"], ["Betaina", "COCIENTE ALFAINA / BETAINA"]));
    expect(ratioRows.internal?.quoted.lines).toEqual([]);
    expect(ratioRows.internal?.studies.every((s) => s.blockers.includes("package_line_unreconstructable"))).toBe(true);
    // y una fila que solo acorta el nombre de un estudio simple NO se bloquea
    expect(analyze(both(["Alfaina", "ALFAINA"])).internal?.quoted.lines.map((l) => l.code)).toEqual(["al"]);
    const viaAlias = analyze(both(["Omegaina", "Omegaina y Sigmaina"], ["Sigmaina", "Omegaina y Sigmaina"]));
    expect(viaAlias.internal?.quoted.lines.map((l) => l.code)).toEqual(["zs"]);
  });

  it("no es una aproximación: sin identidad exacta de la línea nada se reemplaza, y el grupo se retiene (no se sabe si era el paquete)", () => {
    const result = analyze(both(["Zetaina", "Zetaina y Kappaina"], ["Kappaina en sangre", "Zetaina y Kappaina"]));
    expect(result.finalVisualStudies.map((s) => s.literalText)).toEqual(["Zetaina", "Kappaina en sangre"]);
    expect(result.internal?.quoted.lines).toEqual([]);
    expect(result.internal?.studies.map((s) => s.blockers)).toEqual([["package_alternative_unresolved"], ["package_alternative_unresolved"]]);
  });

  it("estudios pedidos en LÍNEAS SEPARADAS no se reemplazan por el paquete ni se retienen: se cotizan por separado, sin inventar precios", () => {
    const result = analyze(both(["Zetaina", "Zetaina"], ["Kappaina en sangre", "Kappaina en sangre"]));
    expect(result.internal?.quoted.lines.map((l) => [l.code, l.priceBs])).toEqual([["z", 30], ["k", 40]]);
    expect(result.publicQuote?.totalBs).toBe(70);
    expect(result.internal?.advisories).toEqual([]);
    expect(result.decision).toBe("AUTO_SAFE");
  });

  it("el mismo par SIN lineText (lecturas antiguas) conserva el comportamiento seguro: grupo retenido", () => {
    const result = analyze(reading(row("Zetaina"), row("Kappaina en sangre")));
    expect(result.internal?.quoted.lines).toEqual([]);
    expect(result.reasons).toContain("package_alternative_unresolved");
  });

  it("una línea que ES el paquete pero cuyas filas no lo reconstruyen sin ambigüedad queda pendiente (no se cobra el paquete ni componentes)", () => {
    const missing = analyze(both(["Zetaina", "ZETAINA + KAPPAINA"]));
    expect(missing.internal?.quoted.lines).toEqual([]);
    expect(missing.internal?.studies[0]?.blockers).toEqual(["package_line_unreconstructable"]);
    expect(missing.decision).toBe("HUMAN_REVIEW");
    expect(missing.reasons).toContain("package_line_unreconstructable");
    const extra = analyze(both(["Zetaina", "ZETAINA + KAPPAINA"], ["Kappaina en sangre", "ZETAINA + KAPPAINA"], ["Omegaina", "ZETAINA + KAPPAINA"]));
    expect(extra.internal?.quoted.lines).toEqual([]);
    expect(extra.internal?.studies.every((s) => s.blockers.includes("package_line_unreconstructable"))).toBe(true);
    const wrong = analyze(both(["Zetaina", "ZETAINA + KAPPAINA"], ["Omegaina", "ZETAINA + KAPPAINA"]));
    expect(wrong.internal?.quoted.lines).toEqual([]);
  });

  it("un estudio independiente de otra línea se cotiza aunque el grupo quede pendiente", () => {
    const result = analyze(both(["Zetaina", "ZETAINA + KAPPAINA"], ["Omegaina", "Omegaina"]));
    expect(result.internal?.quoted.lines.map((l) => l.code)).toEqual(["o"]);
    expect(result.outcome).toBe("AUTO_PARTIAL");
    expect(JSON.stringify(result.publicQuote)).not.toMatch(/paquete|pendiente|unreconstructable|ZETAINA/i);
  });

  it("si las lecturas discrepan en la línea no hay reconstrucción: se comporta como sin lineText", () => {
    const a = both(["Zetaina", "ZETAINA + KAPPAINA"], ["Kappaina en sangre", "ZETAINA + KAPPAINA"]);
    const b = both(["Zetaina", "Zetaina"], ["Kappaina en sangre", "Kappaina en sangre"]);
    const result = analyze(a, b);
    expect(result.finalVisualStudies.every((s) => s.lineText === undefined)).toBe(true);
    expect(result.internal?.quoted.lines).toEqual([]);
  });

  it("una sola fila cuyo texto ya es la línea completa no necesita reconstrucción", () => {
    const result = analyze(both(["ZETAINA + KAPPAINA", "ZETAINA + KAPPAINA"]));
    expect(result.internal?.quoted.lines.map((l) => l.code)).toEqual(["zk"]);
  });

  it("collapseExplicitPackages es puro: no modifica la entrada y conserva la confianza más débil", () => {
    const studies = finals(reading(row("Zetaina", "ZETAINA + KAPPAINA", "high"), row("Kappaina en sangre", "ZETAINA + KAPPAINA", "high")), undefined, []).map((s, i) => (i === 1 ? { ...s, confidence: "medium" as const } : s));
    const copy = JSON.stringify(studies);
    const out = collapseExplicitPackages(studies, catalog);
    expect(JSON.stringify(studies)).toBe(copy);
    expect(out).toHaveLength(1);
    expect(out[0]?.confidence).toBe("medium");
  });
});

describe("la línea completa no deja que se pierda parte de lo pedido", () => {
  it("servicio pedido en la línea que el estudio no cubre (ATB / antibiograma) bloquea el estudio", () => {
    const result = analyze(reading(row("Cultivo de alfa", "Cultivo de alfa + ATB")));
    expect(result.internal?.quoted.lines).toEqual([]);
    expect(result.internal?.studies[0]?.blockers).toContain("line_service_not_covered");
    expect(result.reasons).toContain("line_service_not_covered");
  });
  it("si el estudio elegido incluye el servicio, o la línea no lo pide, se cotiza", () => {
    expect(analyze(reading(row("CULTIVO DE BETA CON ANTIBIOGRAMA", "CULTIVO DE BETA CON ANTIBIOGRAMA (ATB)"))).internal?.quoted.lines.map((l) => l.code)).toEqual(["c2"]);
    expect(analyze(reading(row("Cultivo de alfa", "Cultivo de alfa"))).internal?.quoted.lines.map((l) => l.code)).toEqual(["c1"]);
  });
  it("lineServiceGap: el servicio puede venir del texto del estudio o de un alias aprobado", () => {
    const [source] = finals(reading(row("Cultivo de alfa", "Cultivo de alfa y antibiograma")), undefined, []);
    expect(lineServiceGap(source!, [cultAlfa])).toEqual(["antibiograma"]);
    expect(lineServiceGap(source!, [cultBeta])).toEqual([]);
    expect(lineServiceGap(source!, [{ ...cultAlfa, normalizedAliases: ["cultivo alfa antibiograma"] }])).toEqual([]);
    const [withText] = finals(reading(row("Cultivo de alfa con antibiograma", "Cultivo de alfa con antibiograma")), undefined, []);
    expect(lineServiceGap(withText!, [cultAlfa])).toEqual([]);
  });
  it("un elemento de la línea que ninguna fila representa se avisa al CRM (el lector lo dejó fuera)", () => {
    const studies = finals(reading(row("Zetaina", "Zetaina + Omegaina")), undefined, []);
    expect(droppedLineItems(studies)).toEqual(["la línea «Zetaina + Omegaina» menciona «Omegaina» y ninguna fila de esa línea lo representa"]);
    expect(droppedLineItems(finals(reading(row("Zetaina", "Zetaina + Omegaina"), row("Omegaina", "Zetaina + Omegaina")), undefined, []))).toEqual([]);
    expect(droppedLineItems(finals(reading(row("Zetaina", "Zetaina")), undefined, []))).toEqual([]);
    const result = analyze(reading(row("Zetaina", "Zetaina + Omegaina")));
    expect(result.internal?.advisories.join(" ")).toContain("Omegaina");
    expect(result.internal?.quoted.lines.map((l) => l.code)).toEqual(["z"]);
  });
});

describe("separatelyRequested y heldPackageGroups", () => {
  const sources = (...pairs: Array<[string, string | undefined]>) => pairs.map(([text, line]) => finals(reading(row(text, line)), undefined, [])[0]!);
  it("cada componente en su propia línea simple = pedidos por separado; listas, líneas repetidas o sin lineText = no", () => {
    expect(separatelyRequested([sources(["Zetaina", "Zetaina"]), sources(["Kappaina en sangre", "Kappaina en sangre"])])).toBe(true);
    expect(separatelyRequested([sources(["Zetaina", "Zetaina + Kappaina"]), sources(["Kappaina en sangre", "Zetaina + Kappaina"])])).toBe(false);
    expect(separatelyRequested([sources(["Zetaina", "Zetaina, Kappaina"]), sources(["Kappaina en sangre", "Kappaina en sangre"])])).toBe(false);
    expect(separatelyRequested([sources(["Zetaina", undefined]), sources(["Kappaina en sangre", "Kappaina en sangre"])])).toBe(false);
    expect(separatelyRequested([sources(["Zetaina", "Zetaina"]), sources(["Kappaina en sangre", "Zetaina"])])).toBe(false);
    expect(separatelyRequested([[], sources(["Zetaina", "Zetaina"])])).toBe(false);
  });
  it("heldPackageGroups descarta el grupo solo si todos los componentes se pidieron por separado", () => {
    const [z, k] = [sources(["Zetaina", "Zetaina"])[0]!, sources(["Kappaina en sangre", "Kappaina en sangre"])[0]!];
    expect(heldPackageGroups([{ study: zeta, source: z }, { study: kappa, source: k }], catalog)).toEqual([]);
    const [zl, kl] = [sources(["Zetaina", undefined])[0]!, sources(["Kappaina en sangre", undefined])[0]!];
    expect(heldPackageGroups([{ study: zeta, source: zl }, { study: kappa, source: kl }], catalog).map((g) => g.pkg.code)).toEqual(["zk"]);
  });
});

describe("un elemento de la línea no leído impide el AUTO completo", () => {
  it("queda como pendiente de estudio (CRM), el resto se cotiza y la receta no es AUTO_COMPLETE ni AUTO_SAFE", () => {
    const result = analyze(reading(row("Zetaina", "Zetaina + Omegaina")));
    expect(result.outcome).toBe("AUTO_PARTIAL");
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toContain("line_item_unrepresented");
    expect(result.internal?.quoted.lines.map((l) => l.code)).toEqual(["z"]);
    expect(result.internal?.pending).toEqual([{ key: "line:omegaina", kind: "STUDY", text: "Omegaina", blockers: ["line_item_unrepresented"] }]);
    expect(result.internal?.recipeComplete).toBe(false);
    expect(JSON.stringify(result.publicQuote)).not.toMatch(/omegaina|pendiente|line_item/i);
  });

  it("una persona puede completarlo (asignar el estudio) sin duplicar cobros", async () => {
    const { completeQuote } = await import("../src/quote-completion.js");
    const record = analyze(reading(row("Zetaina", "Zetaina + Omegaina"))).internal!;
    const done = completeQuote(record, [{ pendingKey: "line:omegaina", action: "ASSIGN", studyIds: [omega.id], reviewer: "ana" }], { revision: record.revision, catalog });
    expect(done.rejected).toEqual([]);
    expect(done.record.quoted.lines.map((l) => l.code)).toEqual(["z", "o"]);
    expect(done.publicQuote?.totalBs).toBe(45);
  });

  it("si la línea se lee completa no hay pendiente", () => {
    const result = analyze(reading(row("Zetaina", "Zetaina + Omegaina"), row("Omegaina", "Zetaina + Omegaina")));
    expect(result.internal?.pending).toEqual([]);
    expect(result.outcome).toBe("AUTO_COMPLETE");
  });
});

describe("fila que es solo una variante: hereda el analito de su MISMA línea (nunca de otra)", () => {
  const og = study("og", "OMEGAINA IgG", 80, "INMUNOSEROLOGIA");
  const om = study("om", "OMEGAINA IgM", 85, "INMUNOSEROLOGIA");
  const kg = study("kg", "KAPPAINA IgG", 70, "INMUNOSEROLOGIA");
  const cat = [...catalog, og, om, kg];
  const line = "Omegaina IgM  IgG";
  const both = (...pairs: Array<[string, string | undefined]>) => reading(...pairs.map(([text, l]) => row(text, l)));

  it("'Omegaina IgM' + 'IgG' en la misma línea: la segunda se resuelve como 'Omegaina IgG' y se cotiza; sin lineText quedaba sin identificar", () => {
    const withLine = analyze(both(["Omegaina IgM", line], ["IgG", line]), undefined, cat);
    expect(withLine.finalVisualStudies.map((s) => s.literalText)).toEqual(["Omegaina IgM", "omegaina IgG"]);
    expect(withLine.finalVisualStudies[1]).toMatchObject({ inheritedFrom: "IgG" });
    expect(withLine.internal?.quoted.lines.map((l) => l.code)).toEqual(["om", "og"]);
    const withoutLine = analyze(both(["Omegaina IgM", undefined], ["IgG", undefined]), undefined, cat);
    expect(withoutLine.internal?.quoted.lines.map((l) => l.code)).toEqual(["om"]);
    expect(withoutLine.internal?.pending.some((p) => p.text === "IgG")).toBe(true);
  });

  it("funciona en cualquier orden y con variantes de otra dimensión", () => {
    const reversed = analyze(both(["IgG", line], ["Omegaina IgM", line]), undefined, cat);
    expect(reversed.internal?.quoted.lines.map((l) => l.code).sort()).toEqual(["og", "om"]);
  });

  it("no hereda entre líneas distintas ni si la línea no es fiable (las lecturas discrepan)", () => {
    const other = analyze(both(["Omegaina IgM", "Omegaina IgM"], ["IgG", "IgG"]), undefined, cat);
    expect(other.internal?.quoted.lines.map((l) => l.code)).toEqual(["om"]);
    const a = both(["Omegaina IgM", line], ["IgG", line]);
    const b = both(["Omegaina IgM", line], ["IgG", "otra línea"]);
    expect(analyze(a, b, cat).internal?.quoted.lines.map((l) => l.code)).toEqual(["om"]);
  });

  it("no hereda si la línea nombra analitos distintos (ambiguo) ni si el resultado repetiría otra fila", () => {
    const two = analyze(both(["Omegaina IgM", line], ["Kappaina IgG", line], ["IgG", line]), undefined, cat);
    expect(two.finalVisualStudies.map((s) => s.literalText)).toEqual(["Omegaina IgM", "Kappaina IgG", "IgG"]);
    expect(two.internal?.pending.some((p) => p.text === "IgG")).toBe(true);
    const repeat = analyze(both(["Omegaina IgG", line], ["IgG", line]), undefined, cat);
    expect(repeat.finalVisualStudies.map((s) => s.literalText)).toEqual(["Omegaina IgG", "IgG"]);
  });

  it("una fila con analito propio no se toca, y la identidad se sigue verificando (variante contradictoria no pasa)", () => {
    const own = analyze(both(["Omegaina IgM", line], ["Omegaina IgG", line]), undefined, cat);
    expect(own.finalVisualStudies.every((s) => s.inheritedFrom === undefined)).toBe(true);
    const wrong = analyze(both(["Omegaina IgM", "Omegaina IgM IgM"], ["IgM", "Omegaina IgM IgM"]), undefined, cat);
    expect(wrong.internal?.quoted.lines.map((l) => l.code)).toEqual(["om"]);
  });
});
