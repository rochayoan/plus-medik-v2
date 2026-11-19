// Prueba LOCAL del agente conversacional: NO envía nada por WhatsApp (no usa Kapso).
// Solo LEE el catálogo de Supabase y llama a OpenAI. Uso: npx tsx --env-file=.env scripts/probar-agente.ts   (opcional: CASOS="hola|donde se ubican")
import { resolveAgentSettings } from "../src/agent/openai.js";
import { runAgentTurn } from "../src/agent/pipeline.js";
import { prepareAgentTurn } from "../src/agent/shadow.js";
import { answerFromBusinessData } from "../src/business-answers.js";
import { loadActiveCatalog } from "../src/supabase-catalog.js";

const CASOS: string[] = (process.env.CASOS ? process.env.CASOS.split("|") : [
  "hola",
  "cuanto cuesta un hemograma",
  "necesito glucosa, creatinina y colesterol",
  "donde se ubican",
  "a que hora abren el sabado",
  "necesito unos analisis",
  "quiero hacerme un chequeo",
  "tengo dolor de cabeza y fiebre, que me recomiendan tomar",
  "quiero hablar con una persona",
  "cuanto sale un perfil tiroideo",
  "hacen examenes a domicilio?",
  "gracias, hasta luego"
]);

const log = (): void => {};
const settings = resolveAgentSettings(process.env, (event, data) => console.log("CONFIG", event, data));
if (!settings) { console.error("Agente apagado o mal configurado (revisa .env)."); process.exit(1); }

const catalog = await loadActiveCatalog();
console.log(`Catálogo cargado: ${catalog.length} estudios. Modelo: ${settings.modelName}\n`);
const loadCatalog = async () => catalog;

for (const [i, text] of CASOS.entries()) {
  const started = Date.now();
  const prepared = await prepareAgentTurn(
    { loadCatalog, answer: async (q) => answerFromBusinessData(q), contactKeyFor: () => undefined, capabilities: { handoff: false, quote: true } },
    "59100000000",
    [{ messageId: `t${i}`, kind: "TEXT", text } as never]
  );
  console.log(`── ${i + 1}. «${text}»`);
  if (prepared.kind !== "ready") { console.log(`   → NO pasa por el modelo (${prepared.reason}): lo atiende el modo básico/derivación.\n`); continue; }
  const decision = await runAgentTurn(
    { model: settings.model, tools: prepared.tools, cancelled: () => false },
    { utterances: prepared.utterances, recent: prepared.recent, capabilities: { handoff: false, quote: true }, now: new Date() }
  );
  console.log(`   estado: ${decision.status} | herramientas: ${decision.toolRuns.map((r) => `${r.tool}${r.ok ? "" : "✗"}`).join(", ") || "ninguna"} | ${Date.now() - started} ms`);
  if (decision.modelError) console.log("   modelError:", JSON.stringify(decision.modelError));
  console.log(`   respuesta: ${decision.reply ? decision.reply.replace(/\n/g, "\n              ") : "(sin respuesta)"}`);
  if (decision.violations.length) console.log(`   violaciones: ${decision.violations.map((v) => v.code).join(", ")}`);
  console.log("");
}
void log;
