// Prueba LOCAL (no envía nada por WhatsApp): el menú del saludo y los caminos de cada opción, con mensajes como los de pacientes reales (anonimizados, del historial del 4 al 12 de noviembre).
// Recorre los mismos pasos que producción: número del menú → frase de la opción, consultas de resultados → recepción, saludo solo → menú fijo, y el resto → agente (OpenAI + catálogo real).
//   npx tsx --env-file=.env scripts/probar-menu.ts            (todos los casos)
//   CASOS="hola|2" npx tsx --env-file=.env scripts/probar-menu.ts   (solo los que contengan esos textos)
//   HANDOFF=off ...   (simula producción SIN la cola al CRM; por defecto se simula CON derivación, como quedará en producción)
import type { RecentEntry } from "../src/agent/contracts.js";
import { greetingMenu, menuChoiceOf } from "../src/greeting-menu.js";
import { resolveAgentSettings } from "../src/agent/openai.js";
import { createAgentPilot } from "../src/agent/pilot.js";
import { answerFromBusinessData } from "../src/business-answers.js";
import { resultsCheckMessage, routeResultsMessage } from "../src/results-silence.js";
import { loadActiveCatalog } from "../src/supabase-catalog.js";

const settings = resolveAgentSettings(process.env, () => {});
if (!settings) { console.error("Agente apagado o mal configurado (PLUSMEDIK_LLM_CONVERSATION, OPENAI_CONVERSATION_MODEL, OPENAI_API_KEY)."); process.exit(1); }
const handoff = (process.env.HANDOFF ?? "on").trim().toLowerCase() !== "off";
const catalog = await loadActiveCatalog();
const MENU = greetingMenu(new Date());
const AFTER_MENU: RecentEntry[] = [{ from: "PATIENT", text: "hola" }, { from: "ASSISTANT", text: MENU }];
const AFTER_LIST: RecentEntry[] = [{ from: "PATIENT", text: "quiero cotizar glucosa" }, { from: "ASSISTANT", text: "Tengo estas opciones:\n1. Glucosa en ayunas — Bs 30\n2. Glucosa postprandial — Bs 35\n¿Cuál necesitas?" }];
const AFTER_POSSIBLE: RecentEntry[] = [{ from: "PATIENT", text: "glucosa y fosforo" }, { from: "ASSISTANT", text: [
  "Te cotizo la glucosa; también encontré opciones para el fósforo.", "", "🩺 *PlusMedik* · Cotización de tu receta", "", "🍬 GLUCOSA — Bs 30", "", "💰 *Total de los estudios cotizados: Bs 30*", "",
  "🔎 *Posiblemente también pediste alguno de estos* (no están sumados en el total):", "", "1. 🧪 FOSFORO (P) — Bs 50", "2. 💧 FOSFATURIA DE 24 HORAS (FOSFORO EN ORINA) — Bs 90", "",
  "¿Quieres que agregue alguno a tu cotización? Responde con el número o el nombre. 😊"
].join("\n") }];
const CHATTING: RecentEntry[] = [{ from: "PATIENT", text: "cuánto cuesta el hemograma" }, { from: "ASSISTANT", text: "Te dejo abajo la cotización del hemograma completo." }];

type Caso = { name: string; texts: string[]; recent?: RecentEntry[] };
const CASOS: Caso[] = [
  // saludos (el menú solo si es un saludo puro y sin conversación)
  { name: "saludo solo", texts: ["hola"] },
  { name: "saludo con doctora", texts: ["buenos días doctora"] },
  { name: "saludo + petición en el mismo lote", texts: ["buen día", "para cotizar unos análisis por favor"] },
  { name: "saludo + hora", texts: ["buenos días", "desde qué hora atienden disculpe"] },
  { name: "saludo retomando conversación", texts: ["hola"], recent: CHATTING },
  // elección del menú por número y por palabras
  { name: "menú → 1", texts: ["1"], recent: AFTER_MENU },
  { name: "menú → 2 (resultados)", texts: ["2"], recent: AFTER_MENU },
  { name: "menú → 3", texts: ["3"], recent: AFTER_MENU },
  { name: "menú → 4 (domicilio)", texts: ["4"], recent: AFTER_MENU },
  { name: "menú → 5 (persona)", texts: ["5"], recent: AFTER_MENU },
  { name: "menú → «la 3»", texts: ["la 3"], recent: AFTER_MENU },
  { name: "menú → 7 (fuera de rango)", texts: ["7"], recent: AFTER_MENU },
  { name: "menú → palabras: cotización", texts: ["cotización"], recent: AFTER_MENU },
  { name: "menú → palabras: dónde quedan", texts: ["dónde quedan"], recent: AFTER_MENU },
  { name: "menú → palabras: con una persona", texts: ["con una persona por favor"], recent: AFTER_MENU },
  { name: "menú → escribe directo el estudio", texts: ["hemograma y glucosa"], recent: AFTER_MENU },
  // número tras una lista de estudios: es de la lista
  { name: "lista de estudios → 1", texts: ["1"], recent: AFTER_LIST },
  // cotizar (como escriben de verdad)
  { name: "realizan X", texts: ["buenas tardes, realizan dosaje de ácido valproico?"] },
  { name: "hacen X con erratas", texts: ["buen dia realizan acidos biliares?"] },
  { name: "lista escrita uno por mensaje", texts: ["fosforo", "calcio", "magnesio"] },
  { name: "pide con errata", texts: ["qiero cotisar un hemograma conpleto"] },
  { name: "vih", texts: ["cuánto cuesta la prueba de vih"] },
  { name: "perfil lipídico", texts: ["necesito perfil lipidico y glucosa"] },
  { name: "elige un posible para agregar", texts: ["el 1 también"], recent: AFTER_POSSIBLE },
  // resultados
  { name: "ya están mis resultados", texts: ["buenas tardes ya está mi resultado?"] },
  { name: "resultados en digital", texts: ["me podría mandar mis resultados en digital"] },
  { name: "resultado de un paciente", texts: ["disculpe el resultado de vitamina C del paciente, cuándo sale?"] },
  // domicilio y persona
  { name: "domicilio", texts: ["hola buenos días se podría reservar para mañana para que venga un personal a mi domicilio"] },
  { name: "domicilio internado", texts: ["necesito laboratorio", "está internado en terapia intensiva"] },
  { name: "persona", texts: ["quiero hablar con alguien"] },
  // otros
  { name: "ubicación con errata", texts: ["donde se ubican?"] },
  { name: "no se entiende", texts: ["mmm es del otro?"] },
  { name: "agradece", texts: ["muchas gracias"], recent: CHATTING }
];

const filter = process.env.CASOS?.split("|").map((part) => part.trim().toLowerCase()).filter(Boolean);
const selected = filter ? CASOS.filter((caso) => filter.some((part) => caso.name.toLowerCase().includes(part) || caso.texts.join(" ").toLowerCase().includes(part))) : CASOS;
console.log(`Modelo: ${settings.modelName} | derivación al CRM simulada: ${handoff ? "SÍ" : "NO"} | casos: ${selected.length}\n`);

for (const [i, caso] of selected.entries()) {
  const recent = caso.recent ?? [];
  // 1. número del menú → frase de la opción (como en src/turns.ts)
  const texts = caso.texts.map((text) => menuChoiceOf(text, recent)?.canonical ?? text);
  console.log(`── ${caso.name}: «${caso.texts.join("» + «")}»${recent.length ? ` (antes: ${recent === AFTER_MENU ? "menú" : recent === AFTER_LIST ? "lista de estudios" : "conversación"})` : ""}`);
  if (texts.join() !== caso.texts.join()) console.log(`   número del menú → «${texts.join(" ")}»`);
  // 2. resultados → recepción (texto fijo + caso al CRM)
  const routing = routeResultsMessage(texts.join("\n"));
  if (routing === "READY_CHECK") { console.log(`   → RECEPCIÓN (resultados${handoff ? "" : "; sin CRM se calla"}): ${resultsCheckMessage(new Date())}\n`); continue; }
  if (routing === "SILENT") { console.log("   → se calla (interpretación de resultados: la atiende la Dra)\n"); continue; }
  // 3. el piloto real (menú fijo del saludo, número inválido, persona, agente, enlace del mapa)
  const logs: Array<Record<string, unknown>> = [];
  const pilot = createAgentPilot({
    model: settings.model, modelName: settings.modelName, phones: new Set(["59100000000"]), switch: { enabled: async () => true }, handoffEnabled: handoff,
    context: { loadCatalog: async () => catalog, answer: async (q) => answerFromBusinessData(q), contactKeyFor: () => "abcdef0123456789", recent: async () => recent, capabilities: { handoff, quote: true } },
    log: (event, data) => { if (event === "agent_pilot") logs.push(data); if (event === "agent_menu") logs.push({ status: `MENU_${String(data.event)}` }); }
  });
  const started = Date.now();
  const reply = await pilot.produce({ from: "59100000000", turns: texts.map((text, n) => ({ messageId: `m${i}-${n}`, kind: "TEXT" as const, text })), ...(handoff ? { handoff: async () => true } : {}) });
  const describe = (l: Record<string, unknown>): string => {
    const tools = Array.isArray(l.tools) ? (l.tools as Array<{ tool: string; ok: boolean; error?: string }>).map((t) => t.tool + (t.ok ? "" : `(${t.error})`)).join(", ") : "";
    const violations = Array.isArray(l.violations) && l.violations.length > 0 ? ` · violaciones ${l.violations.join(",")}` : "";
    return `${String(l.status)}${l.reason ? `/${String(l.reason)}` : ""}${tools ? ` · ${tools}` : ""}${l.handoff ? " · DERIVADO" : ""}${violations}${l.repairs ? " · reescrita" : ""}`;
  };
  console.log(`   [${logs.map(describe).join(" | ")}] ${((Date.now() - started) / 1000).toFixed(1)} s`);
  const body = reply ? (reply.silent ? "(se calla)" : reply.body) : "(ninguna → modo esencial de siempre)";
  console.log(`   respuesta: ${body.split("\n").join("\n              ")}\n`);
}
