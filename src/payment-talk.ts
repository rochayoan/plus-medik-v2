import { plain } from "./text-normalize.js";

// Métodos de pago IGNORADOS (decisión del dueño): hasta que se implementen, el laboratorio no dice nada de cómo pagar (ni «sí se puede pagar con QR» ni montos), pero tampoco bloquea nada: lo que toca a los pagos
// simplemente se ignora y el resto del mensaje se atiende como siempre («hola», «quiero cotizar hemograma» y «voy a pagar por QR» → se cotiza el hemograma y del QR no se dice nada).
// Funciones puras, sin red ni base.

const PAYMENT_WORDS = /\b(pag(o|os|ar|are|aras|ara|amos|an|ando|able|ables)|pagu\w*|tarjeta\w*|qr|transferencia\w*|efectivo|metodos? de pago|formas? de pago)\b/;
// Palabras de precio: una cláusula que pregunta cuánto cuesta («¿cuánto pago por un hemograma?») NO es de métodos de pago: es una pregunta de precio y se conserva.
const PRICE = /\b(precio\w*|cuesta\w*|costo\w*|cuanto|cotiz\w*|cotic\w*|presupuesto\w*|tarifa\w*|total)\b/;

const CLAUSES = /([.!?¡¿\n;,]+|\s+(?:y|e|pero|ademas|además|tambien|también|luego|despues|después)\s+)/i;
const SENTENCES = /([.!?¡¿\n;]+)/;

export interface PaymentTalkOptions {
  // Frases cuyo sentido NO se puede ignorar aunque nombren un pago (salud, pedir a una persona): se conservan.
  keep?: (clause: string) => boolean;
  // «clause» (por defecto): cada frase corta o conector; «sentence»: solo oraciones completas (para el texto que escribe el modelo, que no se parte a medias).
  split?: "clause" | "sentence";
}

export const mentionsPayment = (text: string): boolean => PAYMENT_WORDS.test(plain(text));

// El texto SIN las frases que hablan de métodos de pago. Lo demás queda tal cual (con su puntuación).
export function stripPaymentTalk(text: string, options: PaymentTalkOptions = {}): string {
  if (!mentionsPayment(text)) return text;
  const parts = text.split(options.split === "sentence" ? SENTENCES : CLAUSES);
  let out = "";
  let pending = "";
  for (let i = 0; i < parts.length; i += 2) {
    const clause = parts[i]!;
    const separator = parts[i + 1] ?? "";
    const key = plain(clause);
    const drop = PAYMENT_WORDS.test(key) && !PRICE.test(key) && !options.keep?.(clause);
    if (drop) continue;
    // Un fragmento vacío (lo que queda tras un «?» final) no arrastra el separador anterior.
    if (clause.trim() === "") { pending = pending + separator; continue; }
    out += pending + clause;
    pending = separator;
  }
  // El último separador solo se conserva si es puntuación de cierre; un conector («y», «pero») colgando se descarta.
  return (out + (/^\s*[.!?]+\s*$/.test(pending) ? pending.trim() : "")).trim();
}

// ¿Todo el mensaje trata de métodos de pago (nada más que ignorar al quitarlo)?
export function isPaymentOnly(text: string, options: PaymentTalkOptions = {}): boolean {
  return mentionsPayment(text) && stripPaymentTalk(text, options).replace(/[\s¿?¡!.,;]/g, "") === "";
}
