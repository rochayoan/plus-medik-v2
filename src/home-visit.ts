import { patientDataIn } from "./results-silence.js";
import { plain } from "./text-normalize.js";

// CAMINO 4 del menú «Estudios a domicilio» (también internados: hospital, clínica, caja). Decisiones del dueño (19 y 21-nov), con 33 conversaciones reales de la Dra:
//   1. Texto fijo: el servicio existe, se ve si hay personal, el transporte va aparte y la toma se paga antes (aviso breve); pide ubicación, estudios y datos del paciente.
//   2. Lo que el paciente manda después: si son estudios o la receta, se cotizan (flujo normal); con los datos del paciente, se agradece UNA vez.
//   3. Después del agradecimiento, silencio en todo lo del domicilio: la Dra confirma personal, transporte, pago y hora.
// Vive aquí (no en el núcleo conversacional) para que los turnos reconozcan el paso por el texto que se envió.

export function homeVisitMessage(registered: boolean): string {
  return [
    "¡Sí ofrecemos ese servicio! 🏠 Enseguida veremos si hay personal disponible para ir; el transporte tiene un costo aparte y la toma de muestra se paga antes de ir. Ve pasándome, por favor:",
    "📍 La ubicación (puedes enviarla por WhatsApp)",
    "🧪 Qué estudios necesitas (o la foto de la receta)",
    "👤 Nombre completo y edad del paciente (si está internado: servicio, piso y cama)",
    ...(registered ? ["", "Una persona del laboratorio te confirmará por este chat."] : [])
  ].join("\n");
}

export const HOME_VISIT_THANKS = "Gracias 🙏 ya tengo tus datos. Una persona del laboratorio te confirma por aquí la hora de la toma de muestra.";
export const HOME_VISIT_SIGNATURE = "HOME_VISIT_THANKS";

export type HomeVisitStage = "ASKED" | "THANKED";

// En qué paso está el contacto, según los mensajes recientes del asistente (el más reciente de los textos de este camino manda). Si la Dra escribió después, ella ya lo atiende: silencio.
const ASKED_MARKER = plain("Enseguida veremos si hay personal disponible para ir");
const THANKED_MARKER = plain("te confirma por aquí la hora de la toma de muestra");
export function homeVisitStageOf(recent: ReadonlyArray<{ readonly from: string; readonly text: string }>): HomeVisitStage | undefined {
  let staffSpoke = false;
  for (let index = recent.length - 1; index >= 0; index--) {
    const entry = recent[index]!;
    if (entry.from === "STAFF") staffSpoke = true;
    if (entry.from !== "ASSISTANT") continue;
    const text = plain(entry.text);
    if (text.includes(THANKED_MARKER)) return "THANKED";
    if (text.includes(ASKED_MARKER)) return staffSpoke ? "THANKED" : "ASKED";
  }
  return undefined;
}

// Datos del paciente para la visita: un nombre, la edad, o dónde está (servicio, piso, cama, sala, hospital, dirección).
const PLACE = /\b(cama|piso|sala|servicio|habitacion|hab|pieza|bloque|uti|uci|terapia|pediatria|ginecologia|emergencia\w*|observacion|medicina interna|hospital|clinica|caja|cns|cps|internad[oa]|calle|avenida|av|barrio|zona|condominio|casa|\d{1,3} ?(anos|meses))\b/;
// Pedidos propios (estudios, precios, preguntas): siguen el flujo normal (se cotizan o se responden).
const OWN_REQUEST = /\b(cotiz\w*|precio\w*|cuanto|cuesta|hemograma|glucosa|orina|cultivo|perfil|prueba|examen\w*|analisis|estudio\w*)\b/;
export function looksLikeHomeVisitData(text: string): boolean {
  const message = plain(text.slice(0, 600));
  if (!message || text.includes("?") || text.includes("¿") || OWN_REQUEST.test(message)) return false;
  return PLACE.test(message) || patientDataIn([text], false) !== "NONE";
}
