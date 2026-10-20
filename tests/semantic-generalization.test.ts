import { describe, expect, it } from "vitest";
import { assembleAnalysis, finalVisualStudiesOf, judgeResolvedConfidence, type DocumentGate } from "../src/analyze.js";
import { approvedAliasOwner, checkIdentity, effectiveFragments, verifyDecision, type RawDecision, type ShadowContext } from "../src/catalog-shadow.js";
import { buildSimpleConsensus, normalizeStudyKey, type SimpleStudy } from "../src/consensus.js";
import type { SimpleReading } from "../src/ai.js";
import type { SimpleJudgement } from "../src/judge.js";
import type { CatalogStudy } from "../src/types.js";

// Correcciones GENERALES del matching semántico, probadas con analitos inventados (ninguna prueba depende de una receta, un archivo ni un estudio real):
//  1. un alias aprobado del catálogo no se degrada a ambiguo por variantes que el propio alias ya fija;
//  2. un fragmento coordinado que solo trae calificadores ("... total y libre") hereda el analito del fragmento hermano (misma familia);
//  3. un servicio adicional pedido (ATB/antibiograma) que el estudio no cubre deja el estudio en revisión;
//  4. la certeza de una disputa que existía solo por certeza y que el juez confirmó viendo la imagen queda resuelta (con nota y límites estrictos).

const study = (code: string, name: string, category: string, aliases: string[] = [], active = true): CatalogStudy => ({
  id: `uuid-${code}`, code, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs: 10, active, category
});

const zl = study("z1", "ZETAINA LIBRE (ECLIA)", "HORMONAS", ["ZL", "Zetaina libre simbolo"]);
const zt = study("z2", "ZETAINA TOTAL (ECLIA)", "HORMONAS", ["ZT"]);
const zn = study("z3", "ZETAINA NEONATAL", "HORMONAS");
const kl = study("k1", "KAPPAINA LIBRE", "HORMONAS");
const kt = study("k2", "KAPPAINA TOTAL", "HORMONAS");
const og = study("o1", "ANTICUERPO OMEGA IgG", "INMUNOSEROLOGIA");
const om = study("o2", "ANTICUERPO OMEGA IgM", "INMUNOSEROLOGIA");
const natria = study("n1", "NATRIA", "QUIMICA SANGUINEA", ["NA"]);
const natriaOrina = study("n2", "NATRIA EN ORINA OCACIONAL O 24 HORAS", "URIANALISIS");
const cultAlfa = study("c1", "CULTIVO DE ZONA ALFA", "BACTERIOLOGIA - MICROBIOLOGIA");
const cultBeta = study("c2", "CULTIVO DE ZONA BETA CON ANTIBIOGRAMA", "BACTERIOLOGIA - MICROBIOLOGIA");
const catalog = [zl, zt, zn, kl, kt, og, om, natria, natriaOrina, cultAlfa, cultBeta];

const decision = (status: RawDecision["status"], studies: CatalogStudy[], extra: Partial<RawDecision> = {}): RawDecision => ({
  index: 0, status, studies, alternatives: [], fragments: [], reading: "", confidence: "high", reason: "", notes: [], ...extra
});
const match = (chosen: CatalogStudy, extra: Partial<RawDecision> = {}) => decision("MATCH", [chosen], extra);
const composite = (studies: CatalogStudy[], fragments: string[]) => decision("COMPOSITE", studies, { fragments });
const withoutAliases = (list: CatalogStudy[]) => list.map((s) => ({ ...s, normalizedAliases: [] }));

describe("1. alias aprobado: la variante la fija el laboratorio", () => {
  it("approvedAliasOwner: único dueño activo del alias; nunca por nombre, ni si dos estudios lo reclaman o está inactivo", () => {
    expect(approvedAliasOwner("ZL", catalog)?.id).toBe(zl.id);
    expect(approvedAliasOwner(" zl. ", catalog)?.id).toBe(zl.id);
    expect(approvedAliasOwner("ZETAINA LIBRE (ECLIA)", catalog)).toBeUndefined();
    expect(approvedAliasOwner("", catalog)).toBeUndefined();
    const shared = [{ ...zl, normalizedAliases: ["xx"] }, { ...zt, normalizedAliases: ["xx"] }];
    expect(approvedAliasOwner("XX", shared)).toBeUndefined();
    const asName = [{ ...zl, normalizedAliases: ["zeta zeta"] }, { ...zt, name: "ZETA ZETA", normalizedName: "zeta zeta" }];
    expect(approvedAliasOwner("Zeta Zeta", asName)).toBeUndefined();
    expect(approvedAliasOwner("ZL", [{ ...zl, active: false }, zt])).toBeUndefined();
  });

  for (const [alias, chosen] of [["ZL", zl], ["ZT", zt]] as const) {
    it(`positivo: el alias «${alias}» se acepta como MATCH aunque existan variantes hermanas`, () => {
      const outcome = verifyDecision(alias, match(chosen), catalog);
      expect(outcome).toMatchObject({ kind: "MATCH", studyId: chosen.id, support: "EXACT" });
      expect((outcome as { notes: string[] }).notes.join(" ")).toContain("alias aprobado");
    });
    it(`control: sin el alias en el catálogo, «${alias}» sigue siendo ambiguo entre variantes`, () => {
      expect(verifyDecision(alias, match(chosen), withoutAliases(catalog)).kind).toBe("AMBIGUOUS");
    });
  }

  it("las alternativas que propone el modelo no degradan un alias aprobado", () => {
    expect(verifyDecision("ZL", match(zl, { alternatives: [zt, zn] }), catalog).kind).toBe("MATCH");
    expect(verifyDecision("ZL", match(zl, { alternatives: [zt, zn] }), withoutAliases(catalog)).kind).toBe("AMBIGUOUS");
  });

  it("un texto que NO es exactamente el alias conserva todo el rigor (siglas, errores, alias + algo más)", () => {
    expect(verifyDecision("ZLX", match(zl), catalog).kind).toBe("AMBIGUOUS");
    expect(verifyDecision("Zetaina", match(zl), catalog).kind).toBe("AMBIGUOUS");
  });

  it("calificador contradictorio: alias + 'total', alias de un estudio contra el calificador que dice el texto, siguen rechazándose", () => {
    expect(verifyDecision("ZL total", match(zl), catalog).kind).toBe("REJECTED");
    expect(verifyDecision("ZT libre", match(zt), catalog).kind).toBe("REJECTED");
    expect(verifyDecision("ZL neonatal", match(zl), catalog).kind).toBe("REJECTED");
    // un alias mal cargado que contradice a su propio estudio no se salva por ser alias
    const bad = catalog.map((s) => (s.id === zt.id ? { ...s, normalizedAliases: ["zetaina libre simbolo", "zt libre"] } : s));
    expect(verifyDecision("ZT libre", match(bad.find((s) => s.id === zt.id)!), bad).kind).toBe("REJECTED");
  });

  it("el contexto declarado del documento sigue mandando sobre un alias cuando existe una variante compatible", () => {
    const context: ShadowContext = { lines: ["Muestra de orina"], muestra: "orina" };
    expect(verifyDecision("NA", match(natria), catalog, context).kind).toBe("REJECTED");
    expect(verifyDecision("NA", match(natria), catalog, { lines: ["Solicitud de examen de sangre"], muestra: "sangre" }).kind).toBe("MATCH");
    expect(verifyDecision("NA", match(natria), catalog).kind).toBe("MATCH");
  });

  it("el nombre exacto (sin alias) no tiene esa autoridad: 'Natria' sin contexto sigue ambiguo", () => {
    expect(verifyDecision("Natria", match(natria), catalog).kind).toBe("AMBIGUOUS");
  });

  it("checkIdentity con alias: solo cuentan las contradicciones", () => {
    expect(checkIdentity("ZL", zl, catalog, undefined, { approvedAlias: true })).toMatchObject({ ok: true, plausibleSiblings: [] });
    expect(checkIdentity("ZL", zl, catalog).plausibleSiblings.map((s) => s.code).sort()).toEqual(["z2", "z3"]);
    expect(checkIdentity("ZL total", zl, catalog, undefined, { approvedAlias: true }).ok).toBe(false);
  });
});

describe("2. estudios coordinados: el analito se hereda dentro de la misma familia, nunca entre familias", () => {
  it("effectiveFragments: un fragmento solo de calificadores hereda el analito del hermano (en cualquier orden)", () => {
    expect(effectiveFragments(["Zetaina total", "libre"], [zt, zl])).toEqual(["Zetaina total", "zetaina libre"]);
    expect(effectiveFragments(["libre", "Zetaina total"], [zl, zt])).toEqual(["zetaina libre", "Zetaina total"]);
    expect(effectiveFragments(["Zetaina total", "libre", "neonatal"], [zt, zl, zn])).toEqual(["Zetaina total", "zetaina libre", "zetaina neonatal"]);
  });

  it("no hereda entre familias distintas, ni sin hermano con analito, ni si el fragmento ya nombra algo", () => {
    expect(effectiveFragments(["Zetaina total", "libre"], [zt, kl])).toEqual(["Zetaina total", "libre"]);
    expect(effectiveFragments(["libre", "total"], [zl, zt])).toEqual(["libre", "total"]);
    expect(effectiveFragments(["Zetaina total", "kappaina libre"], [zt, kl])).toEqual(["Zetaina total", "kappaina libre"]);
  });

  it("positivo: 'X total y libre' se descompone en las dos variantes", () => {
    const outcome = verifyDecision("Zetaina total y libre", composite([zt, zl], ["Zetaina total", "libre"]), catalog);
    expect(outcome).toMatchObject({ kind: "COMPOSITE" });
    expect((outcome as { components: Array<{ studyId: string; fragment: string }> }).components.map((c) => [c.studyId, c.fragment])).toEqual([[zt.id, "Zetaina total"], [zl.id, "libre"]]);
  });

  it("variaciones independientes: orden inverso, tres variantes, isotipos IgG/IgM y otro analito", () => {
    expect(verifyDecision("libre y Zetaina total", composite([zl, zt], ["libre", "Zetaina total"]), catalog).kind).toBe("COMPOSITE");
    expect(verifyDecision("Zetaina total, libre y neonatal", composite([zt, zl, zn], ["Zetaina total", "libre", "neonatal"]), catalog).kind).toBe("COMPOSITE");
    expect(verifyDecision("Anticuerpo omega IgG e IgM", composite([og, om], ["Anticuerpo omega IgG", "IgM"]), catalog).kind).toBe("COMPOSITE");
    expect(verifyDecision("Kappaina total y libre", composite([kt, kl], ["Kappaina total", "libre"]), catalog).kind).toBe("COMPOSITE");
  });

  it("control: sin la herencia el fragmento 'libre' parecería pedir cualquier estudio libre (rival de otra familia) y el resultado era ambiguo", () => {
    const outcome = verifyDecision("Zetaina total y libre", composite([zt, zl], ["Zetaina total", "libre"]), catalog);
    expect(outcome.kind).toBe("COMPOSITE");
    // el mismo fragmento aislado, sin hermano de su familia, sigue ambiguo
    expect(verifyDecision("libre", match(zl), catalog).kind).toBe("AMBIGUOUS");
  });

  it("negativos: familias mezcladas, componentes repetidos, calificador contradictorio o lista sin cubrir NO se aceptan", () => {
    expect(verifyDecision("Zetaina total y libre", composite([zt, kl], ["Zetaina total", "libre"]), catalog).kind).not.toBe("COMPOSITE");
    expect(verifyDecision("Zetaina total y libre", composite([zt, zt], ["Zetaina total", "libre"]), catalog).kind).toBe("REJECTED");
    // el fragmento dice 'total' pero el estudio elegido es el libre: contradicción
    expect(verifyDecision("Zetaina libre y total", composite([zl, zl, zt].slice(0, 2), ["Zetaina libre", "total"]), catalog).kind).toBe("REJECTED");
    // un elemento de la lista sin componente
    expect(verifyDecision("Zetaina total, libre y algo", composite([zt, zl], ["Zetaina total", "libre"]), catalog).kind).toBe("REJECTED");
  });

  it("un componente inventado que no aparece en el texto sigue rechazándose", () => {
    expect(verifyDecision("Zetaina total y libre", composite([zt, zl], ["Zetaina total", "fraccion libre"]), catalog).kind).toBe("REJECTED");
  });
});

describe("3. servicios adicionales (ATB/antibiograma): solo si el catálogo los cubre", () => {
  it("el texto pide el servicio y el estudio no lo incluye: queda en revisión con el motivo", () => {
    for (const text of ["Cultivo de zona alfa y ATB", "Cultivo de zona alfa con antibiograma", "Cultivo de zona alfa + antibiogramas"]) {
      const outcome = verifyDecision(text, match(cultAlfa), catalog);
      expect(outcome.kind).toBe("REJECTED");
      expect((outcome as { reason: string }).reason).toContain("servicio");
    }
  });

  it("sin el servicio en el texto no hay problema", () => {
    expect(verifyDecision("Cultivo de zona alfa", match(cultAlfa), catalog).kind).toBe("MATCH");
  });

  it("si el nombre del estudio incluye el antibiograma, pedirlo es coherente", () => {
    expect(verifyDecision("Cultivo de zona beta y ATB", match(cultBeta), catalog).kind).toBe("MATCH");
  });

  it("un alias aprobado cubre el servicio (decisión comercial del laboratorio)", () => {
    const covered = catalog.map((s) => (s.id === cultAlfa.id ? { ...s, normalizedAliases: [normalizeStudyKey("Cultivo de zona alfa y ATB")] } : s));
    expect(verifyDecision("Cultivo de zona alfa y ATB", match(covered.find((s) => s.id === cultAlfa.id)!), covered).kind).toBe("MATCH");
    // pero otro texto con el servicio, que no es el alias, sigue en revisión
    expect(verifyDecision("Cultivo de zona alfa con ATB seriado", match(covered.find((s) => s.id === cultAlfa.id)!), covered).kind).toBe("REJECTED");
  });

  it("el servicio no altera la identificación de variantes hermanas ni de estudios sin servicio", () => {
    expect(verifyDecision("Zetaina libre", match(zl), catalog).kind).toBe("MATCH");
    expect(verifyDecision("Zetaina libre y ATB", match(zl), catalog).kind).toBe("REJECTED");
  });
});

describe("4. certeza: una disputa solo de certeza que el juez confirmó viendo la imagen", () => {
  const row = (literalText: string, confidence: SimpleStudy["confidence"], evidence: SimpleStudy["evidence"] = "check"): SimpleStudy => ({ literalText, normalizedName: literalText, evidence, confidence });
  const reading = (rows: SimpleStudy[], uncertain: string[] = []): SimpleReading => ({ requestedStudies: rows, uncertainStudies: uncertain, notes: "" });
  const confirmedBy = (a: SimpleReading, b: SimpleReading): { consensus: ReturnType<typeof buildSimpleConsensus>; judgement: SimpleJudgement } => {
    const consensus = buildSimpleConsensus(a, b);
    return {
      consensus,
      judgement: { resolvedStudies: consensus.disputes.map((d) => ({ key: d.key, verdict: "confirmed" as const, study: (d.readerA.requested ?? d.readerB.requested)!, reason: "se ve" })), unresolvedDisputes: [] }
    };
  };

  it("positivo: una lectura 'medium' y otra 'high' del mismo estudio, sin incertidumbres, y el juez confirma -> certeza alta con nota", () => {
    const { consensus, judgement } = confirmedBy(reading([row("Glucosa", "medium", "scribble")]), reading([row("Glucosa", "high")]));
    const [final] = finalVisualStudiesOf(consensus, judgement);
    expect(final).toMatchObject({ literalText: "Glucosa", source: "judge_confirmed", confidence: "high" });
    expect(final!.confidenceNote).toContain("medium/high");
  });

  it("simétrico: la lectura 'medium' puede ser la otra", () => {
    const { consensus, judgement } = confirmedBy(reading([row("Glucosa", "high")]), reading([row("Glucosa", "medium")]));
    expect(finalVisualStudiesOf(consensus, judgement)[0]?.confidence).toBe("high");
  });

  it("negativos: dos lecturas medium, una low, o ninguna alta conservan la certeza del lector", () => {
    for (const [ca, cb] of [["medium", "medium"], ["low", "high"], ["high", "low"], ["low", "medium"]] as const) {
      const { consensus, judgement } = confirmedBy(reading([row("Glucosa", ca)]), reading([row("Glucosa", cb)]));
      const [final] = finalVisualStudiesOf(consensus, judgement);
      expect(final?.confidence).not.toBe("high");
      expect(final?.confidenceNote).toBeUndefined();
    }
  });

  it("negativos: una incertidumbre relacionada, un solo lector, o variantes distintas entre lectores NO se resuelven por certeza", () => {
    const withUncertainty = confirmedBy(reading([row("Hormona K IgG", "medium")]), reading([row("Hormona K IgG", "high")], ["Hormona K IgM"]));
    expect(finalVisualStudiesOf(withUncertainty.consensus, withUncertainty.judgement).every((s) => s.confidence !== "high" || s.confidenceNote === undefined)).toBe(true);
    const oneReader = confirmedBy(reading([row("Glucosa", "high")]), reading([]));
    expect(finalVisualStudiesOf(oneReader.consensus, oneReader.judgement)[0]?.confidenceNote).toBeUndefined();
    const variants = confirmedBy(reading([row("Hormona K IgG", "medium")]), reading([row("Hormona K IgM", "high")]));
    for (const final of finalVisualStudiesOf(variants.consensus, variants.judgement)) expect(final.confidenceNote).toBeUndefined();
  });

  it("un veredicto del juez que no es 'confirmed' nunca agrega el estudio", () => {
    const consensus = buildSimpleConsensus(reading([row("Glucosa", "medium")]), reading([row("Glucosa", "high")]));
    const rejected: SimpleJudgement = { resolvedStudies: consensus.disputes.map((d) => ({ key: d.key, verdict: "rejected" as const, study: d.readerA.requested!, reason: "no" })), unresolvedDisputes: [] };
    expect(finalVisualStudiesOf(consensus, rejected)).toEqual([]);
  });

  it("judgeResolvedConfidence solo actúa sobre disputas de certeza con ambos lectores", () => {
    const consensus = buildSimpleConsensus(reading([row("Glucosa", "high")]), reading([]));
    const resolved = { key: consensus.disputes[0]!.key, verdict: "confirmed" as const, study: row("Glucosa", "high"), reason: "" };
    expect(judgeResolvedConfidence(resolved, consensus)).toEqual({});
    expect(judgeResolvedConfidence({ ...resolved, key: "no-existe" }, consensus)).toEqual({});
  });

  it("de extremo a extremo: con la resolución el estudio puede cotizarse; sin ella (dos 'medium') sigue en revisión", () => {
    const doc: DocumentGate = { documentType: "MARK_DEPENDENT_FORM", completeDocumentVisible: true, agreement: true, integrityProblems: [], integrityKinds: [] };
    const glucosa = study("g1", "GLUCOSA", "QUIMICA SANGUINEA");
    const run = (a: SimpleReading, b: SimpleReading) => {
      const { consensus, judgement } = confirmedBy(a, b);
      return assembleAnalysis({ consensus, judgement, catalog: [glucosa], document: doc, partialAuto: true });
    };
    const resolved = run(reading([row("Glucosa", "medium")]), reading([row("Glucosa", "high")]));
    expect(resolved.decision).toBe("AUTO_SAFE");
    expect(resolved.publicQuote?.studies.map((s) => s.name)).toEqual(["GLUCOSA"]);
    const stuck = run(reading([row("Glucosa", "medium")]), reading([row("Glucosa", "medium")]));
    expect(stuck.decision).toBe("HUMAN_REVIEW");
    expect(stuck.reasons).toContain("non_high_certainty_study");
    expect(stuck.publicQuote).toBeUndefined();
  });
});

describe("5. cierre técnico: calificadores múltiples y certeza con variantes decisivas", () => {
  const row = (literalText: string, confidence: SimpleStudy["confidence"]): SimpleStudy => ({ literalText, normalizedName: literalText, evidence: "check", confidence });
  const reading = (rows: SimpleStudy[]): SimpleReading => ({ requestedStudies: rows, uncertainStudies: [], notes: "" });
  const judged = (a: SimpleStudy, b: SimpleStudy) => {
    const consensus = buildSimpleConsensus(reading([a]), reading([b]));
    const judgement: SimpleJudgement = { resolvedStudies: consensus.disputes.map((d) => ({ key: d.key, verdict: "confirmed" as const, study: d.readerA.requested!, reason: "" })), unresolvedDisputes: [] };
    return finalVisualStudiesOf(consensus, judgement)[0]!;
  };

  it("un texto que afirma DOS valores de la misma dimensión no se resuelve a un estudio que cubre solo uno", () => {
    expect(verifyDecision("Zetaina libre y total", match(zl), catalog).kind).toBe("REJECTED");
    expect(verifyDecision("Anticuerpo omega IgG IgM", match(og), catalog).kind).toBe("REJECTED");
    expect(verifyDecision("Anticuerpo omega IgG", match(og), catalog).kind).toBe("MATCH");
    expect(verifyDecision("Zetaina libre", match(zl), catalog).kind).toBe("MATCH");
  });

  it("propiedad: ningún alias del catálogo + un calificador que lo contradice puede ser MATCH", () => {
    const contradictions: Record<string, string[]> = { z1: ["total", "neonatal"], z2: ["libre", "neonatal"], o1: ["igm"], o2: ["igg"] };
    const aliased = catalog.map((s) => (s.id === "uuid-o1" ? { ...s, normalizedAliases: ["omega g"] } : s.id === "uuid-o2" ? { ...s, normalizedAliases: ["omega m"] } : s));
    let checked = 0;
    for (const owner of aliased.filter((s) => s.normalizedAliases.length > 0)) {
      for (const token of contradictions[owner.code ?? ""] ?? []) {
        for (const alias of owner.normalizedAliases) {
          checked++;
          expect(verifyDecision(`${alias} ${token}`, match(owner), aliased).kind, `${alias} ${token}`).not.toBe("MATCH");
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(8);
  });

  it("certeza media/alta con una variante decisiva (isotipo, libre/total, cualitativo, población) NO se resuelve por certeza", () => {
    for (const text of ["Anticuerpo omega IgG", "Zetaina libre", "Zetaina total", "Prueba K cualitativa", "Zetaina neonatal"]) {
      const study = judged(row(text, "medium"), row(text, "high"));
      expect(study.confidence, text).toBe("medium");
      expect(study.confidenceNote, text).toBeUndefined();
    }
  });

  it("sin variante decisiva sí se resuelve (con nota), aunque el nombre lleve muestra o método", () => {
    for (const text of ["Glucosa", "Examen general de orina", "Hemograma completo automatizado"]) {
      const study = judged(row(text, "medium"), row(text, "high"));
      expect(study.confidence, text).toBe("high");
      expect(study.confidenceNote, text).toContain("juez");
    }
  });

  it("transcripciones distintas del mismo estudio no se resuelven por certeza", () => {
    const study = judged(row("Glucosa en ayunas", "medium"), row("Glucosa", "high"));
    expect(study.confidenceNote).toBeUndefined();
  });
});
