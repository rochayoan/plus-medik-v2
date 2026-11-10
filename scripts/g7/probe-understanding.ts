// G7 · Fase 0 — Sondeo de la comprensión DETERMINISTA actual sobre los escenarios sintéticos. Solo lectura, sin red ni modelos.
//
//   npx tsx scripts/g7/probe-understanding.ts [--json]
//
// Para cada mensaje del paciente con categoría esperada mide qué hace hoy la capa de reglas (classifyText + detectTopics + socialOf) y calcula dos cosas que importan para la nueva arquitectura:
//   · exactitud de la categoría frente a la etiqueta de un lector humano;
//   · «enunciados perdidos»: el enrutador actual asigna UNA categoría por mensaje; si el mensaje trae varios enunciados de tipos distintos, los demás no tienen camino propio.
import { socialOf } from "../../src/attention-filter.js";
import { detectTopics } from "../../src/knowledge-answers.js";
import { extractStudyRequests } from "../../src/quote-session.js";
import { classifyText, type TextCategory } from "../../src/text-handler.js";
import { SCENARIOS } from "../../tests/support/g7-scenarios.js";
import * as catalogFixtures from "../../tests/support/study-catalog.js";

// Catálogo sintético de las pruebas (nombres reales de estudios, precios inventados).
const CATALOG = Object.values(catalogFixtures).filter((value): value is ReturnType<typeof catalogFixtures.study> => typeof value === "object" && value !== null && "normalizedName" in value);

// Réplica de la PRECEDENCIA real del productor de texto (quote-session-turns.sessionTextProducer): los mensajes médicos, de persona, de información y saludos van al manejador; si no, se intentan identificar
// estudios contra el catálogo (capa de sesión); y solo después vale la categoría general de classifyText.
function effectiveRoute(text: string): TextCategory {
  const category = classifyText(text);
  if (category === "MEDICAL" || category === "HUMAN_REQUEST" || category === "INFO_REQUEST" || category === "GREETING") return category;
  return extractStudyRequests(text, CATALOG) ? "RECIPE_OR_QUOTE" : category;
}

interface Row { scenario: string; ref: string; expected: string; actual: string; ok: boolean; utterances: number; distinctKinds: number; topicsDetected: number; lostUtterances: number }
const rows: Row[] = [];

for (const scenario of SCENARIOS) {
  for (const turn of scenario.turns) {
    for (const message of turn.batch) {
      if (message.actor !== "PATIENT" || !message.expectedCategory) continue;
      const actual = effectiveRoute(message.text);
      const utterances = message.utterances ?? [];
      const kinds = new Set(utterances.filter((item) => item.kind !== "SOCIAL").map((item) => item.kind));
      const topics = detectTopics(message.text, true).length;
      // Con una sola categoría por mensaje, cada enunciado sustantivo más allá del primero solo se atiende si el detector de temas lo reconoce (máx. 3 temas).
      const substantive = utterances.filter((item) => item.kind !== "SOCIAL").length;
      const lost = substantive <= 1 ? 0 : Math.max(0, substantive - Math.max(1, kinds.size > 1 ? 1 : topics));
      rows.push({ scenario: scenario.id, ref: message.ref, expected: message.expectedCategory, actual, ok: actual === message.expectedCategory || (socialOf(message.text) !== undefined && message.expectedCategory === "OTHER"), utterances: utterances.length, distinctKinds: kinds.size, topicsDetected: topics, lostUtterances: lost });
    }
  }
}

const total = rows.length;
const correct = rows.filter((row) => row.ok).length;
const multi = rows.filter((row) => row.utterances >= 2);
const summary = {
  patientMessagesLabeled: total,
  categoryAccuracy: Number((correct / total).toFixed(3)),
  confusions: rows.filter((row) => !row.ok).map((row) => `${row.scenario}/${row.ref}: esperada ${row.expected}, reglas ${row.actual}`),
  multiUtteranceMessages: multi.length,
  multiUtteranceWithPotentialLoss: multi.filter((row) => row.lostUtterances > 0).length,
  mixedKindMessages: multi.filter((row) => row.distinctKinds > 1).map((row) => `${row.scenario}/${row.ref}: ${row.distinctKinds} tipos de enunciado, una sola categoría (${row.actual})`)
};
if (process.argv.includes("--json")) console.log(JSON.stringify({ summary, rows }, null, 2));
else {
  console.log(`Mensajes etiquetados: ${summary.patientMessagesLabeled} · exactitud de categoría de las reglas: ${(summary.categoryAccuracy * 100).toFixed(1)} %`);
  console.log("\nConfusiones:"); for (const line of summary.confusions) console.log(`  - ${line}`);
  console.log(`\nMensajes con 2+ enunciados: ${summary.multiUtteranceMessages} (con pérdida potencial de enunciados: ${summary.multiUtteranceWithPotentialLoss})`);
  console.log("Mensajes con tipos mezclados (una sola categoría posible):"); for (const line of summary.mixedKindMessages) console.log(`  - ${line}`);
}
