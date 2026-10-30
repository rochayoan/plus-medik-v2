import type { KnowledgeRefRecord } from "./audit.js";
import type { KnowledgeService } from "./knowledge/service.js";
import type { CatalogStudy } from "./types.js";

// Apéndice clínico opt-in: no hace matching, no calcula precios y nunca combina
// instrucciones distintas. Solo usa el lector existente de versiones APROBADAS y vigentes.
export const MAX_QUOTE_PREPARATION_STUDIES = 5;
export const MAX_QUOTE_MESSAGE_CHARS = 3800;

export interface QuotePreparationInput {
  quote: string;
  studyIds: readonly string[];
  catalog: readonly CatalogStudy[];
  knowledge: Pick<KnowledgeService, "getStudyPreparation">;
  // El rastro de TODAS las versiones mostradas debe persistirse antes de reservar el envío.
  trace(refs: readonly KnowledgeRefRecord[]): Promise<boolean>;
}

const FOOTER = "\n\nRespóndenos por este chat para continuar. 😊";
const cleaned = (value: string): string => value.trim();
const unique = (values: readonly string[]): string[] => [...new Set(values)];

export async function appendApprovedQuotePreparations(input: QuotePreparationInput): Promise<string> {
  const ids = unique(input.studyIds);
  if (ids.length === 0 || ids.length > MAX_QUOTE_PREPARATION_STUDIES) return input.quote;

  // Nunca se publica preparación de un estudio no cotizado, ausente o inactivo.
  const selected = ids.map((id) => input.catalog.find((item) => item.id === id && item.active));
  if (selected.some((item) => item === undefined)) return input.quote;

  let checked: Awaited<ReturnType<QuotePreparationInput["knowledge"]["getStudyPreparation"]>>;
  try {
    checked = await input.knowledge.getStudyPreparation(ids, selected as CatalogStudy[]);
  } catch {
    return input.quote;
  }

  const groups = new Map<string, string[]>();
  const refs: KnowledgeRefRecord[] = [];
  let missing = 0;
  for (const item of checked.items) {
    if (!ids.includes(item.studyId) || item.result.status !== "AVAILABLE" || item.result.provenance.length === 0) {
      missing++;
      continue;
    }
    const study = selected.find((candidate) => candidate?.id === item.studyId);
    if (!study) return input.quote;
    const prep = item.result.data;
    const details: string[] = [];
    if (prep.prepState === "NO_PREPARATION_REQUIRED") {
      details.push("El laboratorio indica que no requiere preparación especial.");
    } else {
      if (prep.fastingHours !== undefined) details.push(`Ayuno: ${prep.fastingHours} ${prep.fastingHours === 1 ? "hora" : "horas"}.`);
      if (prep.collectionWindow) details.push(`Ventana de toma: ${cleaned(prep.collectionWindow)}`);
      if (prep.instructions) details.push(cleaned(prep.instructions));
    }
    const instruction = details.filter(Boolean).join("\n");
    if (!instruction) {
      missing++;
      continue;
    }
    groups.set(instruction, [...(groups.get(instruction) ?? []), study.name]);
    for (const ref of item.result.provenance) {
      if (ref.kind !== "STUDY_PREPARATION" || ref.key !== `study:${item.studyId}`) return input.quote;
      refs.push({ kind: ref.kind, key: ref.key, version: ref.version, contentHash: ref.contentHash });
    }
  }
  if (groups.size === 0 || refs.length === 0) return input.quote;

  const sections = [...groups.entries()].map(([instructions, names]) => {
    // Solo cambia la presentación de las instrucciones aprobadas; no su contenido.
    const bullets = instructions.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => `• ${line}`).join("\n");
    return `▫️ *${names.join(" / ")}*\n${bullets}`;
  });
  const section = [
    "🧪 *PREPARACIÓN Y AYUNO*",
    "",
    sections.join("\n\n"),
    ...(missing > 0 ? ["", "Para otros estudios de esta cotización, la preparación aún no está confirmada por este canal."] : []),
    ...(groups.size > 1 ? ["", "Para combinarlas, consulta al laboratorio."] : [])
  ].join("\n");

  const hasFooter = input.quote.endsWith(FOOTER);
  const base = hasFooter ? input.quote.slice(0, -FOOTER.length) : input.quote;
  const combined = `${base}\n\n${section}${hasFooter ? FOOTER : ""}`;
  // Nunca truncar una instrucción clínica, ni enviar dos mensajes para completar el contenido.
  if (combined.length > MAX_QUOTE_MESSAGE_CHARS) return input.quote;

  const distinctRefs = [...new Map(refs.map((ref) => [`${ref.kind}|${ref.key}|${ref.version}|${ref.contentHash}`, ref])).values()];
  try {
    if (!(await input.trace(distinctRefs))) return input.quote;
  } catch {
    return input.quote;
  }
  return combined;
}
