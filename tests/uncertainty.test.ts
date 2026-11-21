import { describe, expect, it } from "vitest";
import { UNCERTAINTY_OF, uncertaintyKinds } from "../src/uncertainty.js";
import { BATTERY, runCase } from "./support/generalization-battery.js";

// Clasifica el bloqueo en incertidumbre de LECTURA, de IDENTIDAD, DOCUMENTAL o de POLÍTICA. Solo diagnóstico: no cambia ninguna decisión.

describe("clases de incertidumbre", () => {
  it("cada motivo de bloqueo tiene una clase y las zonas del documento son documentales", () => {
    expect(Object.values(UNCERTAINTY_OF).every((kind) => ["READING", "IDENTITY", "DOCUMENT", "POLICY"].includes(kind))).toBe(true);
    expect(uncertaintyKinds(["ERASED", "CUT_EDGE", "UNTYPED"])).toEqual(["DOCUMENT"]);
  });
  it("devuelve las clases distintas en orden estable, ignora texto libre y no inventa clases", () => {
    expect(uncertaintyKinds(["catalog_unmatched", "non_high_certainty_study", "document_may_alter_study"])).toEqual(["READING", "IDENTITY", "DOCUMENT"]);
    expect(uncertaintyKinds(["catalog_price_invalid", "texto libre del juez"])).toEqual(["POLICY"]);
    expect(uncertaintyKinds([])).toEqual([]);
  });
  it("un mismo bloqueo no cambia de clase según la receta: la clase depende solo del motivo", () => {
    expect(UNCERTAINTY_OF.semantic_ambiguous).toBe("IDENTITY");
    expect(UNCERTAINTY_OF.non_high_certainty_study).toBe("READING");
    expect(UNCERTAINTY_OF.document_study_not_fully_visible).toBe("DOCUMENT");
    expect(UNCERTAINTY_OF.semantic_composite_requires_policy).toBe("POLICY");
  });
});

describe("clases en los registros internos (batería sintética)", () => {
  const byId = (id: string) => runCase(BATTERY.find((c) => c.id === id)!).result.internal!;
  it("estudio fuera del catálogo: identidad", () => {
    expect(byId("N08").studies.find((s) => s.decision !== "AUTO")?.uncertainty).toEqual(["IDENTITY"]);
  });
  it("certeza no alta: lectura; la disputa sin resolver también es de lectura", () => {
    expect(byId("N06").studies[0]?.uncertainty).toEqual(["READING"]);
    expect(byId("N05").pending.find((p) => p.kind === "DISPUTE")?.uncertainty).toEqual(["READING"]);
  });
  it("estudio afectado por una zona que no se ve: documental; la zona pendiente también", () => {
    expect(byId("D01").studies.find((s) => s.decision !== "AUTO")?.uncertainty).toEqual(["DOCUMENT"]);
    expect(byId("D01").pending.find((p) => p.kind === "UNSEEN_REGION")?.uncertainty).toEqual(["DOCUMENT"]);
  });
  it("los estudios aprobados no tienen incertidumbre", () => {
    expect(byId("P01").studies.every((s) => s.uncertainty.length === 0)).toBe(true);
  });
});
