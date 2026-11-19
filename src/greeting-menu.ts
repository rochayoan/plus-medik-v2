import { boliviaGreeting } from "./results-silence.js";
import { fold } from "./text-normalize.js";

// MENÚ DE INTENCIÓN del saludo. Cuando el paciente SOLO saluda y no hay conversación en las últimas 24 h, el sistema (no el modelo) responde con este texto fijo: sale al instante, siempre igual y se puede
// medir qué opción eligen. Si el paciente responde con el NÚMERO de una opción justo después del menú, ese número se traduce a una frase canónica ANTES de cualquier otra regla, para que cada opción siga su
// camino de siempre (resultados → recepción; persona y domicilio → derivación registrada; cotizar y ubicación → agente). Con palabras («cotizar», «dónde quedan») el agente entiende la intención solo.

export interface MenuOption {
  readonly number: 1 | 2 | 3 | 4 | 5;
  readonly label: string;
  readonly code: "QUOTE" | "RESULTS" | "LOCATION" | "HOME_VISIT" | "HUMAN";
  // Lo que «quiso decir» el paciente al elegir el número: frase que las reglas y el agente ya entienden.
  readonly canonical: string;
}

export const MENU_OPTIONS: readonly MenuOption[] = [
  { number: 1, label: "Cotizar estudios", code: "QUOTE", canonical: "Quiero cotizar estudios" },
  { number: 2, label: "Consultar resultados", code: "RESULTS", canonical: "Quiero consultar mis resultados" },
  { number: 3, label: "Ubicación y horarios", code: "LOCATION", canonical: "¿Dónde están ubicados y cuál es su horario de atención?" },
  { number: 4, label: "Estudios a domicilio", code: "HOME_VISIT", canonical: "Quiero un estudio a domicilio" },
  { number: 5, label: "Hablar con una persona", code: "HUMAN", canonical: "Quiero hablar con una persona" }
];

// Formas mínimas (estructurales) de los mensajes: este módulo no depende del núcleo conversacional.
type RecentEntry = { readonly from: "PATIENT" | "ASSISTANT" | "STAFF"; readonly text: string };

const KEYCAP = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"] as const;

export const MENU_LINES = MENU_OPTIONS.map((option) => `${KEYCAP[option.number - 1]} ${option.label}`);
export const MENU_CLOSING = "Responde con el número o cuéntame directamente qué necesitas.";

// El menú completo del saludo, con el saludo según la hora de Bolivia.
export function greetingMenu(now: Date): string {
  return [`¡${boliviaGreeting(now)}! 😊 Soy el asistente virtual de PlusMedik. ¿En qué te puedo ayudar?`, "", ...MENU_LINES, "", MENU_CLOSING].join("\n");
}

// ¿Este mensaje del asistente mostraba el menú? (lo escribiera el sistema o el agente con las mismas opciones). Basta con que estén las líneas numeradas de al menos tres opciones.
export function isMenuMessage(text: string): boolean {
  const lines = text.split("\n").map((line) => line.trim());
  return MENU_LINES.filter((line) => lines.includes(line)).length >= 3;
}

// Una elección por número: «2», «2️⃣», «opción 2», «la 2», «el 2», «2.», «el número 2», con o sin cortesía mínima («2 por favor»). Nada más en el mensaje.
const CHOICE = /^(?:(?:la|el)\s+)?(?:opcion\s+|numero\s+|nro\.?\s*|n°\s*)?([1-9])(?:\s*[.)]|\s*⃣)?(?:\s+(?:por favor|porfa|porfavor|gracias))?[\s.!]*$/;

export function menuNumberOf(text: string): number | undefined {
  const cleaned = fold(text.replace(/️/g, "").trim());
  if (cleaned.length === 0 || cleaned.length > 30) return undefined;
  const match = CHOICE.exec(cleaned);
  return match ? Number(match[1]) : undefined;
}

// Barato y sin red: ¿vale la pena leer el historial para ver si este mensaje responde al menú?
export const mightBeMenuChoice = (text: string): boolean => menuNumberOf(text) !== undefined;

// El último mensaje del asistente (el más reciente) de los mensajes recientes, si es que el asistente habló después del último mensaje de la recepción.
export function lastAssistantMessage(recent: readonly RecentEntry[]): string | undefined {
  for (let index = recent.length - 1; index >= 0; index--) {
    const entry = recent[index]!;
    if (entry.from === "ASSISTANT") return entry.text;
    if (entry.from === "STAFF") return undefined;
  }
  return undefined;
}

// La opción elegida: SOLO si el último mensaje del asistente fue el menú y el número existe. Un número tras una lista de estudios (u otra cosa) no es del menú.
export function menuChoiceOf(text: string, recent: readonly RecentEntry[]): MenuOption | undefined {
  const number = menuNumberOf(text);
  if (number === undefined) return undefined;
  const last = lastAssistantMessage(recent);
  if (!last || !isMenuMessage(last)) return undefined;
  return MENU_OPTIONS.find((option) => option.number === number);
}

// El menú sale ante un saludo puro (lo decide quien llama, con el vocabulario cerrado de saludos) y SIN conversación en las últimas 24 h (si ya venían hablando, un «hola» es retomar y lo
// atiende el agente con el contexto).
export const shouldShowGreetingMenu = (greetingOnly: boolean, recent: readonly RecentEntry[]): boolean => greetingOnly && recent.length === 0;

// Espera antes de enviar el menú, FIJA en el código (sin variable de despliegue; se suma a la agrupación de mensajes de Kapso). Los datos reales (4–12 nov) muestran que tras un «hola» la mayoría escribe lo
// que necesita en menos de 45 s contando la espera de Kapso. Para cambiarla, se edita este número.
export const GREETING_WAIT_MS = 20_000;
