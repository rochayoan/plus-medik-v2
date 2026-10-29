// Herramienta de revisión de la configuración del agente conversacional de PlusMedik. La FUENTE ÚNICA es src/system-prompt.ts (SYSTEM_PROMPT: personalidad, tono, reglas de conversación; BUSINESS_DATA:
// datos comerciales): el agente lo IMPORTA como cualquier módulo, así que NO hay que generar nada después de editarlo. Esta herramienta solo ayuda a revisarlo.
//   npx tsx scripts/agent-config.ts check [--strict] [--json]   valida BUSINESS_DATA tal como lo validará el agente y lista lo que falta completar. --strict falla si queda algo pendiente o vencido
//   npx tsx scripts/agent-config.ts prompt                      muestra el prompt tal como lo recibirá el modelo (con los datos confirmados y vigentes de hoy)
//   npx tsx scripts/agent-config.ts texts [--write]             textos fijos del agente para aprobación (--write escribe agent-config/textos-a-aprobar.md)
// Todo es OFFLINE: solo lee el código local (y `texts --write` escribe un documento). No habla con Supabase, con el CRM ni con OpenAI.
// Precios, estudios, preparación clínica y tiempos de entrega NO se configuran aquí: salen de Supabase.
//
// Nada aquí inventa datos del laboratorio: una sección POR COMPLETAR no se envía al modelo, y una sección CONFIRMADA incompleta o inválida es un error.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderFacts, validateBusinessData, type DataSection, type DataSectionId, type PendingItem } from "../src/conversation-facts.js";
import { buildPromptSource, type PromptSource } from "../src/conversation-openai.js";
import { ANSWER_TEXTS } from "../src/knowledge-answers.js";
import { QUOTE_TEXTS } from "../src/quote-session.js";
import { BUSINESS_DATA } from "../src/system-prompt.js";
import { DRAFT_TEXTS } from "../src/text-handler.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_DIR = join(root, "agent-config");
export const TEXTS_FILE = join(CONFIG_DIR, "textos-a-aprobar.md");
export const MAX_VALIDITY_DAYS = 400;
const DAY_MS = 86_400_000;

// Defectos que dependen de la fecha (no impiden cargar el archivo: el agente descarta lo vencido al usarlo).
export function dateProblems(sections: readonly DataSection[], now: Date): { expired: DataSectionId[]; tooFar: DataSectionId[] } {
  const expired: DataSectionId[] = [];
  const tooFar: DataSectionId[] = [];
  for (const section of sections) {
    if (section.status !== "CONFIRMED" || !section.validUntil) continue;
    const end = Date.parse(`${section.validUntil}T23:59:59.000Z`);
    if (end < now.getTime()) expired.push(section.id);
    else if (end > now.getTime() + MAX_VALIDITY_DAYS * DAY_MS) tooFar.push(section.id);
  }
  return { expired, tooFar };
}

// ───────────────────────────── textos para aprobación ─────────────────────────────

const PURPOSE: Record<string, Record<string, string>> = {
  "Conversación (src/text-handler.ts)": {
    greeting: "Saludo cuando el paciente solo saluda.",
    send_recipe: "Pide la foto de la receta cuando el mensaje es un pedido de cotización sin foto.",
    fallback: "Mensaje que no se entiende ni se puede derivar.",
    handoff_confirmed: "Confirma la derivación a una persona. SOLO se envía con el caso ya registrado en el CRM.",
    handoff_unavailable: "Se envía cuando la derivación no se pudo registrar: no promete a una persona.",
    medical_unavailable: "Consulta médica sin caso registrado: sin orientación médica y aviso de urgencias.",
    medical_handoff_confirmed: "Consulta médica con caso registrado: conserva el aviso de urgencias y promete a una persona."
  },
  "Sesión de cotización (src/quote-session.ts)": {
    added_image: "Acuse al recibir una foto.",
    added_text: "Acuse al anotar estudios escritos.",
    more_hint: "Indica que puede enviar más y que escriba LISTO para cotizar.",
    uncertain_note: "Aviso de que algo no se identificó con certeza.",
    duplicate_image: "Foto repetida: no se cuenta dos veces.",
    full: "Se alcanzó el máximo de mensajes de la solicitud.",
    empty: "Escribió LISTO sin estudios anotados.",
    resend: "Algunas fotos no se pudieron leer.",
    review: "Estudios inciertos: no se da precio y no se promete a una persona.",
    review_confirmed: "Estudios inciertos con el caso ya registrado en el CRM: promete a una persona.",
    cancelled: "Solicitud cancelada por el paciente.",
    nothing_to_cancel: "Quiso cancelar sin solicitud abierta.",
    waiting: "Aún se procesan mensajes anteriores.",
    repeated_note: "Aviso de estudios repetidos contados una vez.",
    unreadable_image: "Imagen ilegible.",
    identified_so_far: "Encabezado de la lista de estudios anotados (los nombres salen del catálogo).",
    confirm_done: "Pregunta si eso es todo, tras anotar estudios escritos sin pedir cotizar. «SÍ» o «LISTO» cotiza.",
    ask_option_intro: "Introduce las opciones numeradas cuando un nombre corresponde a varios estudios del catálogo.",
    ask_option_outro: "Indica cómo elegir una opción (número o nombre exacto).",
    ask_unresolved: "Pide el nombre exacto o una foto cuando algo no se pudo identificar. No promete a nadie.",
    choose_invalid: "La opción respondida no existe en la lista.",
    not_done: "El paciente dijo que aún falta algo: se espera lo que envíe."
  }
};

function renderTable(title: string, texts: Record<string, string>, purpose: Record<string, string>): string[] {
  const cell = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");
  return [
    `## ${title}`,
    "",
    "| Clave | Cuándo se usa | Texto actual (BORRADOR) | Aprobado por / fecha |",
    "| --- | --- | --- | --- |",
    ...Object.entries(texts).map(([key, value]) => `| \`${key}\` | ${cell(purpose[key] ?? "—")} | ${cell(value)} | |`),
    ""
  ];
}

export function renderTextsDoc(): string {
  const answers = ANSWER_TEXTS as unknown as Record<string, string>;
  const answerPurpose: Record<string, string> = {
    hoursTitle: "Título de cada horario; {service} = nombre del servicio.",
    unavailableTopics: "Aviso de los temas sin dato aprobado; {topics} = lista de temas.",
    askStudy: "Pide el nombre del estudio para indicar la preparación.",
    prepMissing: "No hay preparación aprobada para el estudio; {study}.",
    askStudyInfo: "Pide el nombre del estudio para plazo o muestra.",
    turnaroundMissing: "No hay plazo aprobado para el estudio; {study}.",
    sampleMissing: "No hay muestra ni requisitos aprobados; {study}.",
    contextIntro: "Introduce los datos de los estudios de la última cotización."
  };
  const lines = [
    "# Textos fijos del agente — para aprobación del laboratorio",
    "",
    "> GENERADO por `npx tsx scripts/agent-config.ts texts --write` a partir del código. No editar a mano: para cambiar un texto, editar la constante indicada y regenerar.",
    "> Estado: **BORRADORES sin aprobar**. Ninguno contiene cifras, importes, plazos ni horarios (el constructor del manejador lo rechaza). Solo los marcados abajo prometen a una persona, y solo se envían con el caso ya registrado en el CRM.",
    "> Son los textos de la ruta determinista (siempre disponible y usada como respaldo). La conversación con el modelo se configura en `src/system-prompt.ts`.",
    "> Los marcadores entre llaves (`{study}`, `{max}`…) los rellena el sistema con datos aprobados o del catálogo.",
    "",
    ...renderTable("Conversación (`src/text-handler.ts` · `DRAFT_TEXTS`)", DRAFT_TEXTS as unknown as Record<string, string>, PURPOSE["Conversación (src/text-handler.ts)"]!),
    ...renderTable("Sesión de cotización (`src/quote-session.ts` · `QUOTE_TEXTS`)", QUOTE_TEXTS as unknown as Record<string, string>, PURPOSE["Sesión de cotización (src/quote-session.ts)"]!),
    ...renderTable("Respuestas con conocimiento aprobado (`src/knowledge-answers.ts` · `ANSWER_TEXTS`)", answers, answerPurpose)
  ];
  return `${lines.join("\n")}\n`;
}

// ───────────────────────────── revisión ─────────────────────────────

export interface CheckResult {
  source: Required<PromptSource>;
  expired: DataSectionId[];
  tooFar: DataSectionId[];
  pending: PendingItem[];
  // true: los datos no tienen defectos.
  valid: boolean;
  // true: no queda nada pendiente, vencido ni fuera de rango.
  complete: boolean;
}

// Revisa los datos EXACTAMENTE como los valida el agente (misma función) y calcula lo que depende de la fecha.
export function checkSource(source: Required<PromptSource>, pending: CheckResult["pending"], now: Date = new Date()): CheckResult {
  const { expired, tooFar } = dateProblems(source.sections, now);
  const valid = source.problems.length === 0;
  return { source, expired, tooFar, pending, valid, complete: valid && pending.length === 0 && expired.length === 0 && tooFar.length === 0 };
}

function printCheck(result: CheckResult): void {
  console.log(`Prompt de src/system-prompt.ts · versión ${result.source.sha256.slice(0, 12)}`);
  console.log("Datos comerciales (BUSINESS_DATA en src/system-prompt.ts):");
  for (const section of result.source.sections) {
    const state = section.status === "CONFIRMED" && section.text !== "" ? (result.expired.includes(section.id) ? "VENCIDA" : "CONFIRMADA") : "POR COMPLETAR";
    console.log(`  [${state.padEnd(13)}] ${section.id}${section.status === "CONFIRMED" ? `  (fuente ${section.source ?? "?"}, hasta ${section.validUntil ?? "?"})` : ""}`);
  }
  for (const item of result.pending) {
    if (item.missing.length > 0) console.log(`\n  Falta en ${item.section}:\n${item.missing.map((label) => `    - ${label}`).join("\n")}`);
  }
  if (result.tooFar.length > 0) console.log(`\n  AVISO: «Vigente hasta» supera ${MAX_VALIDITY_DAYS} días en ${result.tooFar.join(", ")}`);
  if (result.source.problems.length > 0) console.log(`\nERRORES:\n${result.source.problems.map((problem) => `  - ${problem}`).join("\n")}`);
  const confirmed = result.source.sections.filter((section) => section.status === "CONFIRMED" && section.text !== "" && !result.expired.includes(section.id)).length;
  console.log(`\nResumen: ${confirmed} de ${result.source.sections.length} secciones confirmadas y vigentes · ${result.pending.length} por completar · ${result.expired.length} vencidas · ${result.source.problems.length} errores`);
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "texts") {
    const doc = renderTextsDoc();
    if (rest.includes("--write")) {
      writeFileSync(TEXTS_FILE, doc);
      console.log(`escrito ${TEXTS_FILE}`);
    } else process.stdout.write(doc);
    return 0;
  }
  if (command === "check" || command === "prompt") {
    const source = { ...buildPromptSource(), problems: buildPromptSource().problems ?? [], origin: "code" } as Required<PromptSource>;
    if (command === "prompt") {
      process.stdout.write(`${source.prompt.split("{{DATOS}}").join(renderFacts(source.sections, new Date()).block)}\n`);
      return 0;
    }
    // Lo pendiente (las líneas [POR COMPLETAR] de cada sección) sale del mismo validador que usa el agente.
    const pending = validateBusinessData(BUSINESS_DATA).pending;
    const result = checkSource(source, pending);
    if (rest.includes("--json")) console.log(JSON.stringify({ sha256: source.sha256, problems: source.problems, pending: result.pending, expired: result.expired, tooFar: result.tooFar, sections: source.sections.map((section) => ({ id: section.id, status: section.status, validUntil: section.validUntil })) }, null, 2));
    else printCheck(result);
    if (!result.valid) return 1;
    if (rest.includes("--strict") && !result.complete) return 1;
    return 0;
  }
  console.error("uso: agent-config <check|prompt|texts> [opciones] (ver el encabezado de scripts/agent-config.ts)");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
