import { plain } from "./text-normalize.js";

// Pedido de CORREGIR un dato del resultado (nombre, apellido, edad, fecha…). Caso real 21-nov: foto del resultado + «Un favor me lo pueden corregir el nombre» / «Es Yuselin» / «Con U xfavor»: nadie
// respondió (la foto fue al motor de recetas, que calla ante lo que no es receta) y no hubo aviso al CRM. El agente no puede corregir nada: responde con calidez UNA vez, con un texto fijo, y avisa a
// la Dra (caso al CRM con la etiqueta de resultados). Funciona aunque el lote traiga la foto del resultado.
export const RESULT_CORRECTION_MESSAGE = "¡Claro! 🙏 Ya le avisé a la doctora para que corrija el dato en tu resultado. Te lo envía corregido por este chat.";
export const RESULT_CORRECTION_SIGNATURE = "RESULT_CORRECTION_ACK";

// El verbo de corregir dirigido al laboratorio («corrigen», «me lo pueden corregir», «corrijan»). «Corrijo» / «me corrijo» es el paciente corrigiéndose a sí mismo: no cuenta.
const FIX_VERB = /\b(?:corregir\w*|correjir\w*|corrijan|corrija|corrigen|corrige|corrijen|corriges)\b/;
// Lo que se corrige en un resultado.
const RESULT_DATA = /\b(?:nombre|nombres|apellido|apellidos|edad|fecha|fecha de nacimiento|sexo|carnet|ci|medico|resultado\w*|informe\w*|dato|datos)\b/;
// «Cambiar» o «modificar» solo cuentan con un dato que SOLO puede ser del resultado («cambiar la fecha de mi cita» no es esto).
const CHANGE_VERB = /\b(?:arreglar\w*|arreglen|cambiar\w*|cambien|modificar\w*|modifiquen)\b/;
const NAME_DATA = /\b(?:nombre|nombres|apellido|apellidos|edad|resultado\w*|informe\w*)\b/;
// Señales de un dato mal escrito sin el verbo: «el nombre está mal», «me pusieron mal el apellido», «con u, no con o».
const WRONG_DATA = /\b(?:nombre|apellido|edad|fecha)\b.*\b(?:esta|salio|sale|pusieron|escribieron)\s+mal\b|\b(?:pusieron|escribieron)\s+mal\s+(?:el|mi|la|su)\s+(?:nombre|apellido|edad|fecha)\b|\bmal\s+escrit[oa]\b/;

export function isResultCorrection(text: string): boolean {
  const message = plain(text.slice(0, 600));
  if (/\b(?:me )?corrijo\b/.test(message)) return false;
  return (FIX_VERB.test(message) && RESULT_DATA.test(message)) || (CHANGE_VERB.test(message) && NAME_DATA.test(message)) || WRONG_DATA.test(message) || /\b(?:lo|la|me lo|me la|se lo|se la)\s+(?:pueden\s+|puede\s+|podrian\s+|podria\s+)?(?:corregir|corrigen|corrija|corrijan|corrige)\b/.test(message);
}

// Después del texto fijo, lo que manda el paciente sobre la corrección («Es Yuselin», «Con U xfavor muchas gracias», otra foto) se deja a la Dra: silencio. Solo mensajes CORTOS sin pregunta; una
// pregunta o un pedido nuevo («¿cuánto cuesta el hemograma?») siguen su camino de siempre.
export const isCorrectionFollowUp = (text: string): boolean => {
  const message = plain(text.slice(0, 600));
  return message !== "" && !/[?¿]/.test(text) && message.split(" ").length <= 12;
};

// ¿Se le envió el texto fijo en los mensajes recientes (24 h)?
const MARKER = plain("Ya le avisé a la doctora para que corrija el dato en tu resultado");
export function correctionAcked(recent: ReadonlyArray<{ readonly from: string; readonly text: string }>): boolean {
  return recent.some((entry) => entry.from === "ASSISTANT" && plain(entry.text).includes(MARKER));
}
