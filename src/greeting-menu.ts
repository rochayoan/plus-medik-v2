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
// `at`: hora del mensaje (ISO), si el historial la trae. Sirve para saber qué estaba viendo el paciente cuando escribió.
type RecentEntry = { readonly from: "PATIENT" | "ASSISTANT" | "STAFF"; readonly text: string; readonly at?: string };

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

// Lo que el paciente tenía en pantalla al escribir: los mensajes anteriores a la hora de su mensaje (`sentAtMs`). Sin hora, todo el historial (como antes).
function seenBefore(recent: readonly RecentEntry[], sentAtMs: number | undefined): readonly RecentEntry[] {
  if (sentAtMs === undefined) return recent;
  return recent.filter((entry) => {
    const at = entry.at ? Date.parse(entry.at) : Number.NaN;
    return !Number.isFinite(at) || at <= sentAtMs;
  });
}

// La opción elegida: SOLO si el último mensaje del asistente QUE EL PACIENTE VEÍA al escribir fue el menú y el número existe. Un número tras una lista de estudios (u otra cosa) no es del menú.
// Con la hora del mensaje se resuelve el cruce: el paciente responde «1» al menú justo cuando sale otra respuesta del asistente (ver menuChoiceDecision).
export function menuChoiceOf(text: string, recent: readonly RecentEntry[], sentAtMs?: number): MenuOption | undefined {
  const number = menuNumberOf(text);
  if (number === undefined) return undefined;
  const last = lastAssistantMessage(seenBefore(recent, sentAtMs));
  if (!last || !isMenuMessage(last)) return undefined;
  return MENU_OPTIONS.find((option) => option.number === number);
}

// Señales de que una respuesta del asistente YA atiende esa opción del menú (los textos fijos de cada camino y lo que redacta el agente para cotizar).
const ALREADY_ANSWERS: Record<MenuOption["code"], RegExp> = {
  QUOTE: /estudios|receta|orden|cotiza/i,
  RESULTS: /resultado/i,
  LOCATION: /horario|direcci[oó]n|ubicad|maps/i,
  HOME_VISIT: /domicilio/i,
  HUMAN: /persona|asesor/i
};

export interface MenuChoiceDecision {
  readonly option: MenuOption;
  // true: el número se CRUZÓ con una respuesta del asistente que ya atiende esa opción (el paciente la recibe justo después de escribir). No se responde otra vez lo mismo.
  readonly alreadyAnswered: boolean;
}

// Caso real (21-nov): «Buen día» → menú; el paciente ya había escrito «necesito cotizar» (Kapso lo retuvo) y, mirando el menú, responde «1» 3 s antes de que salga «¡Claro! Escríbeme los estudios…».
// Ese «1» es la opción 1 (lo escribió viendo el menú) y ya quedó atendida por la respuesta que se cruzó: responderla de nuevo repetía «¿qué estudios quieres cotizar?».
export function menuChoiceDecision(text: string, recent: readonly RecentEntry[], sentAtMs?: number): MenuChoiceDecision | undefined {
  const option = menuChoiceOf(text, recent, sentAtMs);
  if (!option) return undefined;
  if (sentAtMs === undefined) return { option, alreadyAnswered: false };
  const crossed = recent.filter((entry) => entry.from === "ASSISTANT" && entry.at !== undefined && Date.parse(entry.at) > sentAtMs && !isMenuMessage(entry.text));
  return { option, alreadyAnswered: crossed.some((entry) => ALREADY_ANSWERS[option.code].test(entry.text)) };
}

// El menú sale ante un saludo puro (lo decide quien llama, con el vocabulario cerrado de saludos) cuando NO hay conversación en las últimas 24 h. «Conversación» = alguien le respondió al paciente
// (el asistente o una persona). Saludos anteriores que nadie contestó (envío fallido, caída) no cuentan: siguen siendo el primer contacto. Si el paciente ya había pedido algo concreto, aunque
// nadie le respondiera, no se tapa ese pedido con el menú: lo atiende el agente con el contexto. `isGreeting` lo da quien llama (el mismo vocabulario cerrado de saludos).
export const shouldShowGreetingMenu = (greetingOnly: boolean, recent: readonly RecentEntry[], isGreeting: (text: string) => boolean): boolean =>
  greetingOnly && recent.every((entry) => entry.from === "PATIENT" && isGreeting(entry.text));

// Espera antes de enviar el menú, FIJA en el código (sin variable de despliegue; se suma a la agrupación de mensajes de Kapso). Los datos reales (4–12 nov) muestran que tras un «hola» la mayoría escribe lo
// que necesita en menos de 45 s contando la espera de Kapso. Para cambiarla, se edita este número.
export const GREETING_WAIT_MS = 20_000;
