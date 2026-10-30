import type { FactRefRecord } from "./audit.js";
import type { CatalogStudy } from "./types.js";
import type { StudyFactsQueries } from "./study-facts/service.js";
import { ANSWER_TEXTS, sampleLines, turnaroundLines } from "./knowledge-answers.js";
import { MAX_QUOTE_MESSAGE_CHARS, MAX_QUOTE_PREPARATION_STUDIES } from "./quote-preparation.js";

// Datos por estudio que ya fueron aprobados y siguen vigentes: no usar el LLM,
// no modificar precios y no afirmar nunca que falta una preparación o requisito.
export interface QuoteStudyDetailsInput {
  quote: string;
  studyIds: readonly string[];
  catalog: readonly CatalogStudy[];
  facts: StudyFactsQueries;
  // La referencia de cada dato mostrado se registra antes de autorizar WhatsApp.
  trace(refs: readonly FactRefRecord[]): Promise<boolean>;
}

const FOOTER = "\n\nRespóndenos por este chat para continuar. 😊";

export async function appendApprovedQuoteStudyDetails(input: QuoteStudyDetailsInput): Promise<string> {
  const ids = [...new Set(input.studyIds)];
  if (ids.length === 0 || ids.length > MAX_QUOTE_PREPARATION_STUDIES) return input.quote;
  const selected = ids.map((id) => input.catalog.find((study) => study.id === id && study.active));
  if (selected.some((study) => !study)) return input.quote;
  const catalog = selected as CatalogStudy[];

  let samples: Awaited<ReturnType<StudyFactsQueries["getSample"]>>;
  let turnarounds: Awaited<ReturnType<StudyFactsQueries["getTurnaround"]>>;
  try {
    [samples, turnarounds] = await Promise.all([
      input.facts.getSample(ids, catalog),
      input.facts.getTurnaround(ids, catalog)
    ]);
  } catch {
    return input.quote; // Nunca usar una copia no verificada de la base.
  }

  const sampleById = new Map(samples.items.map((item) => [item.studyId, item]));
  const turnaroundById = new Map(turnarounds.items.map((item) => [item.studyId, item]));
  const refs: FactRefRecord[] = [];
  const blocks: string[] = [];

  for (const study of catalog) {
    const lines: string[] = [];
    const sample = sampleById.get(study.id);
    if (sample?.result.status === "AVAILABLE") {
      const proof = sample.result.provenance;
      if (proof.kind !== "SAMPLE" || proof.labTestId !== study.id) return input.quote;
      lines.push(...sampleLines(sample.result.data, ANSWER_TEXTS));
      refs.push({ kind: "SAMPLE", labTestId: study.id, version: proof.version, contentHash: proof.contentHash });
    }
    const turnaround = turnaroundById.get(study.id);
    if (turnaround?.result.status === "AVAILABLE") {
      const proof = turnaround.result.provenance;
      if (proof.kind !== "TURNAROUND" || proof.labTestId !== study.id) return input.quote;
      lines.push(...turnaroundLines(turnaround.result.data, ANSWER_TEXTS));
      refs.push({ kind: "TURNAROUND", labTestId: study.id, version: proof.version, contentHash: proof.contentHash });
    }
    if (lines.length > 0) blocks.push("*" + study.name + "*\n" + lines.join("\n"));
  }
  if (blocks.length === 0 || refs.length === 0) return input.quote;

  const section = "📋 *Muestras, requisitos y tiempos de entrega*\n\n" + blocks.join("\n\n");
  const hasFooter = input.quote.endsWith(FOOTER);
  const base = hasFooter ? input.quote.slice(0, -FOOTER.length) : input.quote;
  const combined = base + "\n\n" + section + (hasFooter ? FOOTER : "");
  if (combined.length > MAX_QUOTE_MESSAGE_CHARS) return input.quote;

  const distinct = [...new Map(refs.map((ref) => [ref.kind + "|" + ref.labTestId + "|" + ref.version + "|" + ref.contentHash, ref])).values()];
  try {
    if (!(await input.trace(distinct))) return input.quote;
  } catch {
    return input.quote;
  }
  return combined;
}
