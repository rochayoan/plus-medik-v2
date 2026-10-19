import { describe, expect, it } from "vitest";
import { assembleAnalysis, type DocumentGate } from "../src/analyze.js";
import { approvedPackage, isPackageComponent, packageItems, plusItems, uncoveredPlusItems, verifyDecision, type RawDecision } from "../src/catalog-shadow.js";
import { buildSimpleConsensus, normalizeStudyKey, type SimpleStudy } from "../src/consensus.js";
import type { SimpleReading } from "../src/ai.js";
import type { CatalogStudy } from "../src/types.js";

// Tratamiento general de "+": paquetes aprobados cuyo NOMBRE los lista, estudios independientes y cobros duplicados. Analitos inventados.

const study = (code: string, name: string, category: string, priceBs = 10, aliases: string[] = [], active = true): CatalogStudy => ({
  id: `uuid-${code}`, code, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active, category
});
const zeta = study("z", "ZETAINA", "QUIMICA SANGUINEA", 30);
const kappa = study("k", "KAPPAINA EN SANGRE", "QUIMICA SANGUINEA", 40);
const zk = study("zk", "ZETAINA + KAPPAINA", "QUIMICA SANGUINEA", 60);
const omega = study("o", "OMEGAINA", "QUIMICA SANGUINEA", 15);
const cultAlfa = study("c1", "CULTIVO DE ALFA", "BACTERIOLOGIA - MICROBIOLOGIA", 50);
const cultBeta = study("c2", "CULTIVO DE BETA CON ANTIBIOGRAMA", "BACTERIOLOGIA - MICROBIOLOGIA", 90);
const panel = study("p", "PANEL ALFA + BETA + GAMMA + DELTA + EPSILON", "BIOLOGIA MOLECULAR", 500);
const parens = study("pp", "IONO UNO (zetaina, kappaina)", "QUIMICA SANGUINEA", 70);
const catalog = [zeta, kappa, zk, omega, cultAlfa, cultBeta, panel, parens];

const decision = (status: RawDecision["status"], studies: CatalogStudy[], fragments: string[] = []): RawDecision => ({
  index: 0, status, studies, alternatives: [], fragments, reading: "", confidence: "high", reason: "", notes: []
});

describe("plusItems: solo nombres cortos y simples listan componentes verificables", () => {
  it("positivos", () => {
    expect(plusItems("ZETAINA + KAPPAINA")).toEqual(["ZETAINA", "KAPPAINA"]);
    expect(plusItems("A + B + C + D")).toEqual(["A", "B", "C", "D"]);
    expect(plusItems("Gasometria arterial + Lactato")).toEqual(["Gasometria arterial", "Lactato"]);
  });
  it("negativos: sin '+', con paréntesis, perfiles/paneles/combos, demasiados elementos o elementos largos", () => {
    for (const name of ["ZETAINA", "ZETAINA (a + b)", "PERFIL A + B", "PANEL A + B", "COMBO A + B", "A + B + C + D + E", "UNO DOS TRES CUATRO CINCO + B", "A +", "+ B"]) expect(plusItems(name), name).toEqual([]);
  });
  it("packageItems los usa para el paquete aprobado y mantiene los paréntesis", () => {
    expect(packageItems(zk)).toEqual(["ZETAINA", "KAPPAINA"]);
    expect(packageItems(parens)).toEqual(["zetaina", "kappaina"]);
    expect(packageItems(panel)).toEqual([]);
  });
});

describe("paquete con '+' y componentes: nunca se cobran juntos", () => {
  it("isPackageComponent reconoce a cada componente (y no a otros estudios ni al propio paquete)", () => {
    expect(isPackageComponent(zk, zeta)).toBe(true);
    expect(isPackageComponent(zk, kappa)).toBe(true);
    expect(isPackageComponent(zk, omega)).toBe(false);
    expect(isPackageComponent(zk, zk)).toBe(false);
    expect(isPackageComponent(zeta, zk)).toBe(false);
  });

  const doc: DocumentGate = { documentType: "MARK_DEPENDENT_FORM", completeDocumentVisible: true, agreement: true, integrityProblems: [], integrityKinds: [] };
  const row = (literalText: string): SimpleStudy => ({ literalText, normalizedName: literalText, evidence: "check", confidence: "high" });
  const run = (...texts: string[]) => {
    const reading: SimpleReading = { requestedStudies: texts.map(row), uncertainStudies: [], notes: "" };
    return assembleAnalysis({ consensus: buildSimpleConsensus(reading, reading), judgement: { resolvedStudies: [], unresolvedDisputes: [] }, catalog, document: doc, partialAuto: true });
  };

  it("el paquete y uno de sus componentes pedidos a la vez: se cotiza el paquete y el componente queda pendiente (sin cobro doble)", () => {
    const result = run("ZETAINA + KAPPAINA", "Kappaina en sangre");
    expect(result.internal?.quoted.lines.map((l) => l.code)).toEqual(["zk"]);
    expect(result.internal?.studies.find((s) => s.text === "Kappaina en sangre")?.blockers).toContain("package_component_overlap");
    expect(result.publicQuote?.totalBs).toBe(60);
    // el contrato heredado tampoco cotiza en dos sentidos
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toContain("package_component_overlap");
    expect(result.quote).toBeUndefined();
  });

  it("los componentes pedidos por separado se cotizan por separado y el CRM recibe el aviso del paquete (sin sustituir el precio)", () => {
    const result = run("Zetaina", "Kappaina en sangre");
    expect(result.internal?.quoted.lines.map((l) => l.code)).toEqual(["z", "k"]);
    expect(result.publicQuote?.totalBs).toBe(70);
    expect(result.internal?.advisories.join(" ")).toContain("ZETAINA + KAPPAINA");
    expect(JSON.stringify(result.publicQuote)).not.toMatch(/paquete|aviso|advis/i);
  });

  it("un solo componente no genera aviso", () => {
    expect(run("Zetaina").internal?.advisories).toEqual([]);
  });
});

describe("texto con '+': un solo estudio no puede ignorar parte de lo pedido", () => {
  it("uncoveredPlusItems: qué elementos NO cubre el estudio elegido", () => {
    expect(uncoveredPlusItems("Zetaina + Kappaina", zeta)).toEqual(["Kappaina"]);
    expect(uncoveredPlusItems("Zetaina + Kappaina", zk)).toEqual([]);
    expect(uncoveredPlusItems("Zetaina + Omegaina", zeta)).toEqual(["Omegaina"]);
    expect(uncoveredPlusItems("Zetaina", zeta)).toEqual([]);
    expect(uncoveredPlusItems("Cultivo de beta + ATB", cultBeta)).toEqual([]);
  });

  it("MATCH de un componente para un texto «A + B» sin paquete en el catálogo: se rechaza, no se cobra solo A", () => {
    const small = [zeta, kappa, omega];
    const outcome = verifyDecision("Zetaina + Kappaina", decision("MATCH", [zeta]), small);
    expect(outcome.kind).toBe("REJECTED");
    expect((outcome as { reason: string }).reason).toContain("Kappaina");
  });

  it("el orden y la capitalización no importan, y vale para cualquier analito", () => {
    expect(verifyDecision("kappaina en sangre + ZETAINA", decision("MATCH", [kappa]), catalog).kind).toBe("REJECTED");
    expect(verifyDecision("Omegaina + Zetaina + Kappaina", decision("MATCH", [omega]), catalog).kind).toBe("REJECTED");
  });

  it("si el texto es EXACTAMENTE el nombre del paquete y el modelo elige un componente, manda el catálogo: se rechaza", () => {
    const outcome = verifyDecision("Zetaina + Kappaina", decision("MATCH", [zeta]), catalog);
    expect(outcome.kind).toBe("REJECTED");
    expect((outcome as { reason: string }).reason).toContain("nombre aprobado");
  });

  it("el paquete se acepta tanto si el modelo lo elige como MATCH como si lo describe como COMPOSITE verificado", () => {
    expect(verifyDecision("Zetaina + Kappaina", decision("MATCH", [zk]), catalog)).toMatchObject({ kind: "MATCH", studyId: zk.id });
    expect(verifyDecision("Zetaina + Kappaina", decision("COMPOSITE", [zeta, kappa], ["Zetaina", "Kappaina"]), catalog)).toMatchObject({ kind: "MATCH", studyId: zk.id, support: "EXACT" });
  });

  it("un compuesto que no es exactamente el paquete sigue exigiendo la composición completa", () => {
    expect(verifyDecision("Zetaina + Kappaina", decision("COMPOSITE", [zeta, omega], ["Zetaina", "Omegaina"]), catalog).kind).toBe("REJECTED");
    expect(verifyDecision("Zetaina + Kappaina", decision("COMPOSITE", [zeta], ["Zetaina"]), catalog).kind).not.toBe("MATCH");
  });

  it("sin paquete en el catálogo, «A + B» sí se descompone en estudios independientes (sin cobro doble)", () => {
    const small = [zeta, kappa, omega];
    const outcome = verifyDecision("Zetaina + Kappaina", decision("COMPOSITE", [zeta, kappa], ["Zetaina", "Kappaina"]), small);
    expect(outcome.kind).toBe("COMPOSITE");
    expect(approvedPackage("Zetaina + Kappaina", small)).toBeUndefined();
  });

  it("un servicio unido por «+» lo cubre solo el estudio que lo incluye (ATB / antibiograma)", () => {
    expect(verifyDecision("Cultivo de alfa + ATB", decision("MATCH", [cultAlfa]), catalog).kind).toBe("REJECTED");
    expect(verifyDecision("Cultivo de beta + ATB", decision("MATCH", [cultBeta]), catalog).kind).toBe("MATCH");
  });

  it("un panel largo con '+' en su nombre no se trata como paquete de componentes", () => {
    expect(approvedPackage("Panel alfa + beta + gamma + delta + epsilon", catalog)?.id).toBe(panel.id);
    expect(isPackageComponent(panel, zeta)).toBe(false);
    expect(verifyDecision("Panel alfa + beta + gamma + delta + epsilon", decision("MATCH", [panel]), catalog).kind).toBe("MATCH");
  });

  it("sin '+', nada cambia: «Zetaina» sigue siendo un MATCH simple", () => {
    expect(verifyDecision("Zetaina", decision("MATCH", [zeta]), catalog).kind).toBe("MATCH");
  });
});
