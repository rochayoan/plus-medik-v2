import { assembleAnalysis, type DocumentGate } from "../../src/analyze.js";
import type { SimpleReading } from "../../src/ai.js";
import { buildSimpleConsensus, normalizeStudyKey, type SimpleStudy } from "../../src/consensus.js";
import type { SimpleJudgement } from "../../src/judge.js";
import type { ImpactStatus, StudyImpactResult } from "../../src/study-impact.js";
import type { CatalogStudy } from "../../src/types.js";

// Batería SINTÉTICA de generalización: lecturas inventadas de dos lectores (con analitos inventados) que ejercitan el motor determinista
// (consenso, juez simulado, agrupación de líneas, certeza, resolución contra el catálogo y decisión por estudio) con formatos distintos.
// NO prueba la visión ni el emparejamiento semántico de los modelos reales: las lecturas ya vienen dadas. Cada caso declara qué se DEBE
// cotizar y qué se DEBE retener, según un principio general (no según una receta).

const study = (code: string, name: string, category = "QUIMICA SANGUINEA", aliases: string[] = []): CatalogStudy => ({
  id: `uuid-${code}`, code, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs: 10, active: true, category
});

export const BATTERY_CATALOG: CatalogStudy[] = [
  study("z", "ZETAINA"),
  study("k", "KAPPAINA EN SANGRE", "QUIMICA SANGUINEA", ["Kappaina"]),
  study("o", "OMEGAINA"),
  study("s", "SIGMAINA"),
  study("zk", "ZETAINA + KAPPAINA"),
  study("l1", "ANTI-LAMBDA IGG", "INMUNOLOGIA"),
  study("l2", "ANTI-LAMBDA IGM", "INMUNOLOGIA"),
  study("l3", "ANTI-LAMBDA IGA", "INMUNOLOGIA"),
  study("t1", "TAUINA TOTAL", "HORMONAS"),
  study("t2", "TAUINA LIBRE", "HORMONAS"),
  study("c1", "CULTIVO DE ALFA", "BACTERIOLOGIA - MICROBIOLOGIA"),
  study("c2", "CULTIVO DE ALFA CON ANTIBIOGRAMA", "BACTERIOLOGIA - MICROBIOLOGIA"),
  study("u", "UPSILONA", "QUIMICA SANGUINEA", ["Upsilona basal"]),
  study("z24", "ZETAINA EN ORINA DE 24 HORAS", "URIANALISIS")
];

const DOC: DocumentGate = { documentType: "MARK_DEPENDENT_FORM", completeDocumentVisible: true, agreement: true, integrityProblems: [], integrityKinds: [] };

export const row = (literalText: string, lineText?: string, confidence: SimpleStudy["confidence"] = "high"): SimpleStudy => ({
  literalText, normalizedName: literalText, evidence: "check", confidence, ...(lineText === undefined ? {} : { lineText })
});
export const reading = (rows: SimpleStudy[], uncertainStudies: string[] = []): SimpleReading => ({ requestedStudies: rows, uncertainStudies, notes: "" });

export type JudgeMode = "none" | "confirm_all" | "reject_all";

export interface BatteryCase {
  id: string;
  principle: string;
  kind: "positive" | "negative";
  a: SimpleReading;
  b?: SimpleReading; // por omisión, el segundo lector coincide con el primero
  judge?: JudgeMode; // qué hace el juez simulado con las disputas (por omisión, ninguna resolución)
  expectQuoted: string[]; // códigos del catálogo que DEBEN cotizarse (exacto)
  mustHold?: string[]; // textos leídos que DEBEN quedar sin cotizar (para medir retenciones correctas)
  // Zonas del documento que no se ven (tipos de problema) y qué dijo la verificación de impacto por estudio (clave = texto leído).
  document?: { kinds: string[]; impact?: { available: boolean; statuses?: Record<string, ImpactStatus>; qualifierRisk?: boolean } };
  note?: string;
}

export function runCase(testCase: BatteryCase) {
  const consensus = buildSimpleConsensus(testCase.a, testCase.b ?? testCase.a);
  const mode = testCase.judge ?? "none";
  const judgement: SimpleJudgement = mode === "none"
    ? { resolvedStudies: [], unresolvedDisputes: consensus.disputes.map((dispute) => ({ dispute, reason: "no resuelto" })) }
    : {
        resolvedStudies: consensus.disputes.flatMap((dispute) => {
          const study = dispute.preferred ?? dispute.readerA.requested ?? dispute.readerB.requested;
          return study ? [{ key: dispute.key, verdict: mode === "confirm_all" ? "confirmed" as const : "rejected" as const, study, reason: "simulado" }] : [];
        }),
        unresolvedDisputes: consensus.disputes.filter((d) => !(d.preferred ?? d.readerA.requested ?? d.readerB.requested)).map((dispute) => ({ dispute, reason: "no resuelto" }))
      };
  const zone = testCase.document;
  const document: DocumentGate = zone ? { ...DOC, completeDocumentVisible: false, integrityProblems: ["zona sin ver"], integrityKinds: zone.kinds } : DOC;
  const impact: StudyImpactResult | undefined = zone?.impact && {
    available: zone.impact.available,
    unaffected: new Set(Object.entries(zone.impact.statuses ?? {}).filter(([, status]) => status === "INDEPENDENT").map(([text]) => normalizeStudyKey(text))),
    findings: new Map(Object.entries(zone.impact.statuses ?? {}).map(([text, status]) => [normalizeStudyKey(text), status] as const)),
    qualifierRisk: zone.impact.qualifierRisk ?? false,
    notes: []
  };
  const result = assembleAnalysis({ consensus, judgement, catalog: BATTERY_CATALOG, document, partialAuto: true, impact });
  const quoted = (result.internal?.quoted.lines ?? []).map((line) => line.code ?? line.id).sort();
  return { result, quoted };
}

export const BATTERY: BatteryCase[] = [
  // ───────────── documento con zonas que no se ven: la evaluación es POR ESTUDIO, no global ─────────────
  { id: "D01", principle: "Zona borrada: se cotiza lo que la verificación confirma independiente y se retiene solo lo afectado", kind: "positive", a: reading([row("Sigmaina"), row("Omegaina")]), document: { kinds: ["ERASED"], impact: { available: true, statuses: { Sigmaina: "INDEPENDENT", Omegaina: "AFFECTED" } } }, expectQuoted: ["s"], mustHold: ["Omegaina"] },
  { id: "D02", principle: "Sin verificación de impacto disponible no se confirma ningún estudio (falla cerrado)", kind: "negative", a: reading([row("Omegaina"), row("Sigmaina")]), document: { kinds: ["CUT_EDGE"], impact: { available: false } }, expectQuoted: [], mustHold: ["Omegaina", "Sigmaina"] },
  { id: "D03", principle: "Borde cortado localizado y todos independientes: se cotiza", kind: "positive", a: reading([row("Omegaina"), row("Sigmaina")]), document: { kinds: ["CUT_EDGE"], impact: { available: true, statuses: { Omegaina: "INDEPENDENT", Sigmaina: "INDEPENDENT" } } }, expectQuoted: ["o", "s"] },
  { id: "D04", principle: "Un título oculto podría calificar solo a los estudios sensibles al contexto", kind: "positive", a: reading([row("Zetaina"), row("Omegaina")]), document: { kinds: ["CUT_EDGE"], impact: { available: true, qualifierRisk: true, statuses: { Zetaina: "INDEPENDENT", Omegaina: "INDEPENDENT" } } }, expectQuoted: ["o"], mustHold: ["Zetaina"] },
  { id: "D05", principle: "Texto o marca no entera de un estudio: se retiene ese estudio, no los demás", kind: "positive", a: reading([row("Omegaina"), row("Sigmaina"), row("Kappaina")]), document: { kinds: ["ERASED"], impact: { available: true, statuses: { Omegaina: "INDEPENDENT", Sigmaina: "NOT_FULLY_VISIBLE", Kappaina: "INDEPENDENT" } } }, expectQuoted: ["k", "o"], mustHold: ["Sigmaina"] },
  { id: "D06", principle: "Zona sin tipificar: cada estudio exige verificación; sin respuesta sobre un estudio se retiene solo ese", kind: "positive", a: reading([row("Omegaina"), row("Sigmaina")]), document: { kinds: [], impact: { available: true, statuses: { Omegaina: "INDEPENDENT", Sigmaina: "NO_ANSWER" } } }, expectQuoted: ["o"], mustHold: ["Sigmaina"] },

  // ───────────── positivos: lo claro y bien leído debe cotizarse, con cualquier formato ─────────────
  { id: "P01", principle: "Nombre exacto, ambos lectores seguros", kind: "positive", a: reading([row("Zetaina"), row("Omegaina")]), expectQuoted: ["o", "z"] },
  { id: "P02", principle: "Mayúsculas, tildes y puntuación distintas entre lectores son el mismo texto", kind: "positive", a: reading([row("ZETAÍNA.")]), b: reading([row("zetaina")]), expectQuoted: ["z"] },
  { id: "P03", principle: "Singular/plural del mismo nombre largo no genera disputa", kind: "positive", a: reading([row("Kappaina en sangre")]), b: reading([row("Kappainas en sangre")]), expectQuoted: ["k"], note: "el texto representativo es el del primer lector; el plural lo resuelve la capa semántica en producción" },
  { id: "P04", principle: "Variantes explícitas en filas separadas, cada una con su analito", kind: "positive", a: reading([row("Anti-lambda IgG"), row("Anti-lambda IgM")]), expectQuoted: ["l1", "l2"] },
  { id: "P05", principle: "Filas que solo traen la variante heredan el analito de la línea compartida", kind: "positive", a: reading([row("Anti-lambda", "Anti-lambda IgG, IgM"), row("IgG", "Anti-lambda IgG, IgM"), row("IgM", "Anti-lambda IgG, IgM")]), expectQuoted: ["l1", "l2"], note: "la fila 'Anti-lambda' sin variante no se cotiza sola" },
  { id: "P06", principle: "Tres variantes de una misma línea de texto llano, la primera con su analito", kind: "positive", a: reading([row("Anti-lambda IgG", "Anti-lambda: IgG, IgM, IgA"), row("IgM", "Anti-lambda: IgG, IgM, IgA"), row("IgA", "Anti-lambda: IgG, IgM, IgA")]), expectQuoted: ["l1", "l2", "l3"] },
  { id: "P07", principle: "Línea que ES un paquete aprobado, leída como filas separadas, se reconstruye", kind: "positive", a: reading([row("Zetaina", "ZETAINA + KAPPAINA"), row("Kappaina", "ZETAINA + KAPPAINA")]), expectQuoted: ["zk"] },
  { id: "P08", principle: "Varios estudios independientes en una línea con comas se cotizan por separado", kind: "positive", a: reading([row("Zetaina", "Zetaina, Omegaina, Sigmaina"), row("Omegaina", "Zetaina, Omegaina, Sigmaina"), row("Sigmaina", "Zetaina, Omegaina, Sigmaina")]), expectQuoted: ["o", "s", "z"] },
  { id: "P09", principle: "El mismo estudio escrito dos veces se cotiza una vez", kind: "positive", a: reading([row("Zetaina"), row("ZETAINA")]), expectQuoted: ["z"] },
  { id: "P10", principle: "Una incertidumbre ajena a un estudio claro no lo bloquea", kind: "positive", a: reading([row("Zetaina"), row("Omegaina")], ["Palabra ilegible xyz"]), expectQuoted: ["o", "z"], mustHold: [] },
  { id: "P11", principle: "Total y libre dichos explícitamente en filas separadas", kind: "positive", a: reading([row("Tauina total"), row("Tauina libre")]), expectQuoted: ["t1", "t2"] },
  { id: "P12", principle: "Alias aprobado del catálogo", kind: "positive", a: reading([row("Upsilona basal")]), expectQuoted: ["u"] },
  { id: "P13", principle: "Disputa de certeza (uno medium) que el juez confirma con el mismo texto visible", kind: "positive", a: reading([row("Omegaina", "Omegaina", "medium")]), b: reading([row("Omegaina")]), judge: "confirm_all", expectQuoted: ["o"] },
  { id: "P14", principle: "Transcripción truncada de un lector resuelta por el juez con el texto completo", kind: "positive", a: reading([row("Cultivo de")]), b: reading([row("Cultivo de alfa")]), judge: "confirm_all", expectQuoted: ["c1"] },
  { id: "P15", principle: "Servicio explícito (con antibiograma) coincide con el estudio que lo incluye", kind: "positive", a: reading([row("Cultivo de alfa con antibiograma")]), expectQuoted: ["c2"] },
  { id: "P16", principle: "Estudios de orden distinto entre lectores", kind: "positive", a: reading([row("Zetaina"), row("Omegaina"), row("Sigmaina")]), b: reading([row("Sigmaina"), row("Zetaina"), row("Omegaina")]), expectQuoted: ["o", "s", "z"] },

  { id: "P17", principle: "La variante suelta libre hereda el analito del donante en una línea que lo nombra una vez", kind: "positive", a: reading([row("Tauina total", "Tauina total y libre"), row("libre", "Tauina total y libre")]), expectQuoted: ["t1", "t2"] },
  { id: "P18", principle: "Lo que ya viene completo no depende de la línea: una línea con marcas no afecta a filas con su analito", kind: "positive", a: reading([row("Anti-lambda IgG", "Anti-lambda IgG ✓  IgM ✗")]), expectQuoted: ["l1"] },
  { id: "P19", principle: "Los signos y marcas de la línea (cruces, subrayados) no impiden reconstruir la variante suelta: sigue el flujo normal", kind: "positive", a: reading([row("Anti-lambda IgG", "Anti-lambda IgG ✓  IgM ✓"), row("IgM", "Anti-lambda IgG ✓  IgM ✓")]), expectQuoted: ["l1", "l2"] },
  { id: "P20", principle: "Un guion o un signo más entre variantes de una línea de un solo analito no impide la reconstrucción", kind: "positive", a: reading([row("Anti-lambda IgG", "Anti-lambda: IgG - IgM + IgA"), row("IgM", "Anti-lambda: IgG - IgM + IgA"), row("IgA", "Anti-lambda: IgG - IgM + IgA")]), expectQuoted: ["l1", "l2", "l3"] },
  // ───────────── negativos: ante evidencia insuficiente o contradictoria no se cotiza ─────────────
  { id: "N01", principle: "Variante sola sin línea no identifica el estudio", kind: "negative", a: reading([row("IgG")]), expectQuoted: [], mustHold: ["IgG"] },
  { id: "N02", principle: "Variante sola con una línea que nombra dos analitos distintos no hereda", kind: "negative", a: reading([row("IgG", "Anti-lambda y Zetaina IgG")]), expectQuoted: [], mustHold: ["IgG"] },
  { id: "N03", principle: "Los lectores discrepan en la variante de la misma fila", kind: "negative", a: reading([row("Anti-lambda IgG")]), b: reading([row("Anti-lambda IgM")]), expectQuoted: [], mustHold: ["Anti-lambda IgG", "Anti-lambda IgM"] },
  { id: "N04", principle: "Solo un lector pidió el estudio", kind: "negative", a: reading([row("Zetaina"), row("Omegaina")]), b: reading([row("Zetaina")]), expectQuoted: ["z"], mustHold: ["Omegaina"] },
  { id: "N05", principle: "Certeza no alta en ambos lectores", kind: "negative", a: reading([row("Omegaina", "Omegaina", "medium")]), b: reading([row("Omegaina", "Omegaina", "medium")]), expectQuoted: [], mustHold: ["Omegaina"] },
  { id: "N06", principle: "Disputa de certeza sobre una variante decisiva, el juez confirma pero la certeza se mantiene en la más débil", kind: "negative", a: reading([row("Anti-lambda IgG", "Anti-lambda IgG", "low")]), b: reading([row("Anti-lambda IgG")]), judge: "confirm_all", expectQuoted: [], mustHold: ["Anti-lambda IgG"] },
  { id: "N07", principle: "Total vs libre: los lectores discrepan", kind: "negative", a: reading([row("Tauina total")]), b: reading([row("Tauina libre")]), expectQuoted: [], mustHold: ["Tauina total", "Tauina libre"] },
  { id: "N08", principle: "Estudio fuera del catálogo", kind: "negative", a: reading([row("Fisiona rara"), row("Zetaina")]), expectQuoted: ["z"], mustHold: ["Fisiona rara"] },
  { id: "N09", principle: "El juez rechaza lo que no se ve", kind: "negative", a: reading([row("Omegaina", "Omegaina", "medium")]), b: reading([row("Omegaina")]), judge: "reject_all", expectQuoted: [], mustHold: ["Omegaina"] },
  { id: "N10", principle: "Solo incertidumbre: no se cotiza", kind: "negative", a: reading([], ["Zetaina?"]), expectQuoted: [], mustHold: ["Zetaina?"] },
  { id: "N11", principle: "Un lector duda del estudio que el otro pide", kind: "negative", a: reading([row("Omegaina")]), b: reading([row("Omegaina")], ["Omegaina (¿o Sigmaina?)"]), expectQuoted: [], mustHold: ["Omegaina"] },
  { id: "N13", principle: "Variante suelta con una línea que mezcla dos analitos no hereda ninguno", kind: "negative", a: reading([row("IgG", "Zetaina y Anti-lambda IgG")]), expectQuoted: [], mustHold: ["IgG"] },
  { id: "N14", principle: "La variante de la fila no aparece en la línea: no se completa", kind: "negative", a: reading([row("IgA", "Anti-lambda IgG, IgM")]), expectQuoted: [], mustHold: ["IgA"] },
  { id: "N15", principle: "Los lectores no coinciden en la línea: no hay línea fiable", kind: "negative", a: reading([row("IgG", "Anti-lambda IgG, IgM")]), b: reading([row("IgG", "Zetaina IgG, IgM")]), expectQuoted: [], mustHold: ["IgG"] },
  { id: "N16", principle: "Heredar no inventa estudios: el analito con la variante debe existir en el catálogo", kind: "negative", a: reading([row("IgG", "Omegaina, IgG")]), expectQuoted: [], mustHold: ["IgG"] },
  { id: "N17", principle: "Heredar no duplica un estudio ya pedido en otra fila", kind: "negative", a: reading([row("Anti-lambda IgG", "Anti-lambda IgG, IgM"), row("IgG", "Anti-lambda IgG, IgM")]), expectQuoted: ["l1"], mustHold: [] },
  { id: "N18", principle: "Sin ninguna fila que nombre el analito, la variante suelta no hereda de la línea", kind: "negative", a: reading([row("IgG", "Anti-lambda: IgG, IgM, IgA"), row("IgM", "Anti-lambda: IgG, IgM, IgA"), row("IgA", "Anti-lambda: IgG, IgM, IgA")]), expectQuoted: [], mustHold: ["IgG", "IgM", "IgA"] },
  { id: "N19", principle: "Total y libre sueltos, sin donante: no hereda", kind: "negative", a: reading([row("total", "Tauina total y libre"), row("libre", "Tauina total y libre")]), expectQuoted: [], mustHold: ["total", "libre"] },
  { id: "N20", principle: "Una sola variante suelta, sin donante: no hereda", kind: "negative", a: reading([row("IgG", "Anti-lambda IgG")]), expectQuoted: [], mustHold: ["IgG"] },
  { id: "N21", principle: "Una negación escrita con palabras en la línea impide completar la variante suelta", kind: "negative", a: reading([row("Anti-lambda IgG", "Anti-lambda IgG, sin IgM"), row("IgM", "Anti-lambda IgG, sin IgM")]), expectQuoted: ["l1"], mustHold: ["IgM"] },
  { id: "N22", principle: "La variante suelta de la otra mitad de una línea con dos analitos no se asigna al analito de la fila nombrada", kind: "negative", a: reading([row("Zetaina", "Zetaina, Anti-lambda IgG"), row("IgG", "Zetaina, Anti-lambda IgG")]), expectQuoted: ["z"], mustHold: ["IgG"] },
  { id: "N12",principle: "Un componente de paquete sin el otro componente no se cotiza como el paquete", kind: "negative", a: reading([row("Zetaina", "ZETAINA + KAPPAINA")]), expectQuoted: [], mustHold: ["Zetaina"], note: "la línea pide dos estudios; cotizar solo uno ocultaría el otro" }
];
