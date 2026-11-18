// Prueba LOCAL (no envía nada por WhatsApp): saludo con menú y respuestas a sus opciones. Uso: npx tsx --env-file=.env scripts/probar-menu.ts
import { resolveAgentSettings } from "../src/agent/openai.js";
import { runAgentTurn } from "../src/agent/pipeline.js";
import { prepareAgentTurn } from "../src/agent/shadow.js";
import { answerFromBusinessData } from "../src/business-answers.js";
import { loadActiveCatalog } from "../src/supabase-catalog.js";

const settings = resolveAgentSettings(process.env, () => {});
if (!settings) { console.error("Agente apagado o mal configurado."); process.exit(1); }
const catalog = await loadActiveCatalog();
const MENU = [
  "¡Hola! 👋 ¿En qué te puedo ayudar?",
  "💰 Cotizar estudios",
  "📍 Ubicación y horarios",
  "👤 Hablar con una persona",
  "Escríbeme la opción que necesitas o cuéntame qué buscas."
].join("\n");
const CASOS: Array<{ text: string; menu: boolean }> = [
  { text: "hola", menu: false },
  { text: "buenas tardes", menu: false },
  { text: "cotizar", menu: true },
  { text: "ubicación y horarios", menu: true },
  { text: "hablar con una persona", menu: true }
];
for (const [i, c] of CASOS.entries()) {
  const prepared = await prepareAgentTurn(
    { loadCatalog: async () => catalog, answer: async (q) => answerFromBusinessData(q), contactKeyFor: () => undefined, capabilities: { handoff: false, quote: true } },
    "59100000000", [{ messageId: `m${i}`, kind: "TEXT", text: c.text } as never]);
  console.log(`── «${c.text}» ${c.menu ? "(tras mostrar el menú)" : "(sin historial)"}`);
  if (prepared.kind !== "ready") { console.log(`   → no pasa por el modelo (${prepared.reason}): lo atiende el modo básico/derivación\n`); continue; }
  const d = await runAgentTurn({ model: settings.model, tools: prepared.tools, cancelled: () => false },
    { utterances: prepared.utterances, recent: c.menu ? [{ from: "ASSISTANT", text: MENU }] : [], capabilities: { handoff: false, quote: true }, now: new Date() });
  console.log(`   estado: ${d.status} | herramientas: ${d.toolRuns.map((r) => r.tool).join(", ") || "ninguna"}`);
  if (d.modelError) console.log("   modelError:", JSON.stringify(d.modelError));
  if (d.violations.length) console.log("   violaciones:", d.violations.map((v) => v.code).join(", "));
  console.log(`   respuesta: ${(d.reply ?? "(sin respuesta)").replace(/\n/g, "\n              ")}\n`);
}
