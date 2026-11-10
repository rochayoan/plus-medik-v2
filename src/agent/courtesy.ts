import { socialOf } from "../attention-filter.js";
import { plain } from "../text-normalize.js";

// Cortesías que NO merecen respuesta: un agradecimiento, una despedida, un acuse de que ya lo atendieron o puro ruido (emoji, risas). Contestarlas gasta un mensaje en vano y confunde («Con gusto te
// oriento…» a un «gracias»). Conservador a propósito: solo vocabulario cerrado (el del filtro de atención) y con una palabra de agradecimiento o despedida; un «ok» o «listo» solos NO cuentan, porque
// pueden ser la respuesta a una pregunta del agente o cerrar una solicitud. Un saludo NO es una cortesía: se responde ofreciendo ayuda.
const THANKS = /\b(gracias|gracia|thanks|agradezco|agradecid[oa]|chao|chau|adios|hasta luego)\b/;
// «Ya me atendieron (gracias)»: el paciente avisa que resolvió su asunto en persona.
const ALREADY_ATTENDED = /^(?:buen\w* \w+ )?ya me (?:atendieron|atendio|atendieron ya|resolvieron|ayudaron)(?: gracias| muchas gracias)?$/;

export function isCourtesyOnly(text: string): boolean {
  const raw = text.trim();
  if (raw === "" || /[?¿]/.test(raw)) return false;
  const social = socialOf(raw);
  if (social?.kind === "NOISE") return true;
  const folded = plain(raw);
  if (social?.kind === "COURTESY") return THANKS.test(folded);
  return ALREADY_ATTENDED.test(folded);
}
