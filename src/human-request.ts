import { plain } from "./text-normalize.js";

// CAMINO 5 del menú «Hablar con una persona» (dueño, 21-nov). Quien pide una persona suele venir de un intento fallido con el agente: sale un texto fijo (sin modelo) que promete a una persona y le pide
// que adelante lo que necesita; desde ahí, el agente CALLA con ese contacto durante la ventana de mensajes recientes (24 h) o hasta que responda la Dra (ella lo atiende). Con la cola al CRM configurada, el
// caso va como HUMAN_REQUEST (alerta «Quiere hablar con alguien» cuando se conecte el CRM).
export const HUMAN_REQUEST_MESSAGE = "¡Claro! 🙋 En un momento te atiende una persona del laboratorio por este chat. Mientras, cuéntame qué necesitas para que ya lo tenga listo.";
export const HUMAN_REQUEST_SIGNATURE = "HUMAN_REQUEST_ACK";

const ASKS_PERSON = /\b(hablar|comunicar\w*|conversar|contactar\w*) con (una persona|alguien|la doctora|la dra|el doctor|el dr|un asesor|una asesora|recepcion|un humano|una humana|el encargado|la encargada|el personal|una persona real)\b|\bme (comunica|comunican|pasa|pasan|pasas) con (una persona|alguien|un asesor|una asesora|la doctora|recepcion)\b|\b(quiero|necesito|prefiero) (una persona|un asesor|una asesora|atencion humana|que me atienda una persona)\b|\bpersona real\b|\batencion humana\b|\b(llamenme|llamame|me (pueden|puede|podrian|podria) llamar)\b/;
export const isHumanRequest = (text: string): boolean => ASKS_PERSON.test(plain(text.slice(0, 600)));

// ¿Se le envió el texto fijo en los mensajes recientes (24 h)? Entonces se espera a la persona: silencio.
const MARKER = plain("En un momento te atiende una persona del laboratorio por este chat");
export function waitingForPerson(recent: ReadonlyArray<{ readonly from: string; readonly text: string }>): boolean {
  return recent.some((entry) => entry.from === "ASSISTANT" && plain(entry.text).includes(MARKER));
}
