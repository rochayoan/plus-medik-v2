import { plain } from "./text-normalize.js";

// Camino 3 del menú (dueño, 21-nov): alguien escribe que ya está en el laboratorio y encuentra la puerta cerrada. Atendemos las 24 horas, así que hay una persona esperando AHORA: sale un texto fijo
// (el del dueño, sin modelo) y, si la cola al CRM existe, el caso va con la etiqueta AT_DOOR para avisar al personal. Determinista y conservador: tiene que decir que está ahí Y que está cerrado (o que
// no le abren); «¿a qué hora cierran?» o «la otra vez estaba cerrado» no cuentan.
export const AT_DOOR_MESSAGE = "Espéranos un momento, por favor 🙏 Acabo de informar al personal, en un momento llega.";

const PRESENCE = /\b(estoy|estamos|ya estoy|ya estamos|llegue|llegamos|me encuentro|nos encontramos)\b[^.?!\n]{0,40}\b(afuera|fuera|puerta|entrada|aqui abajo|al frente|(en|al) (el )?(laboratorio|lab))\b|\b(esperando|espero|esperamos)\b[^.?!\n]{0,25}\b(afuera|fuera|puerta|entrada)\b/;
// «Cerrado» tiene que ser la puerta o el laboratorio («la puerta está cerrada», «está cerrado»), no otra cosa («el tubo va cerrado»).
const CLOSED = /\b(puerta|porton|reja|laboratorio|lab|local)\b[^.?!\n]{0,20}\bcerrad[oa]s?\b|\b(esta|estan|sigue|siguen) cerrad[oa]s?\b|\bcon llave\b|\bno (me |nos )?abren\b|\bnadie (abre|sale|atiende|responde)\b|\b(toco|toque|tocamos|estoy tocando) (el timbre|la puerta)\b/;
// Sin decir dónde está, estas frases ya son inequívocas.
const STRONG = /\bno (me |nos )?abren (la puerta|el laboratorio)\b|\bnadie (me |nos )?abre (la puerta)?\b|\b(toco|toque|tocamos|estoy tocando) (el timbre|la puerta)\b[^.?!\n]{0,30}\b(nadie|no (me |nos )?abren|no sale nadie)\b/;
const PAST = /\b(estaba|estaban|estuvo|estuvieron|la otra vez|ayer|anoche|el otro dia)\b/;

export function isAtClosedDoor(text: string): boolean {
  const message = plain(text.slice(0, 600));
  if (!message) return false;
  if (STRONG.test(message)) return true;
  return PRESENCE.test(message) && CLOSED.test(message) && !PAST.test(message);
}
