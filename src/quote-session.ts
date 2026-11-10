import { ExactAliasCatalogResolver } from "./catalog.js";
import { normalizeStudyKey } from "./consensus.js";
import { formatQuoteMessage, QUOTE_FOOTER } from "./whatsapp-quote.js";
import { buildPublicQuote } from "./partial-auto.js";
import { synonymsOf } from "./study-synonyms.js";
import { asksForPrice, classifyText } from "./text-handler.js";
import { plain } from "./text-normalize.js";
import type { CatalogStudy, StudyObservation } from "./types.js";

// Sesiones de cotización conversacional (G4.0). Una SESIÓN agrupa lo que un contacto va enviando (varias fotos y estudios escritos) y solo se cotiza cuando el paciente dice
// «listo». Este módulo es la parte PURA (sin red ni base de datos): interpretar el texto, evaluar una sesión contra el catálogo vigente y redactar los mensajes.
//
// Principios (iguales a los del motor de recetas):
//   · Solo existen los estudios de lab_tests y solo con los precios vigentes al momento de cotizar (el catálogo se recarga al cerrar). Nunca se infiere un estudio, una
//     equivalencia ni un precio: el texto del paciente se resuelve con el MISMO resolvedor exacto del motor (nombre o alias aprobado), sin aproximaciones.
//   · Ante cualquier duda (ambiguo, sin resolver, resultado parcial del motor) NO se da precio: el caso queda en la cola de revisión para el futuro flujo humano.
//   · Nada del texto del paciente se guarda: solo ids de estudios del catálogo y códigos.

export type ItemReason = "AMBIGUOUS_STUDY" | "UNRESOLVED_TEXT" | "ENGINE_PARTIAL" | "UNREADABLE_IMAGE" | "UNSUPPORTED_IMAGE";
export type ItemStatus = "RESOLVED" | "AMBIGUOUS" | "UNRESOLVED" | "UNCERTAIN" | "UNREADABLE";
export type ReviewReason = "AMBIGUOUS_STUDY" | "UNRESOLVED_TEXT" | "ENGINE_PARTIAL" | "UNREADABLE_IMAGE" | "STUDY_UNAVAILABLE" | "PRICE_INVALID";

// Lo que se registra de un mensaje de la sesión.
export interface ItemResult {
  status: ItemStatus;
  studyIds: string[];
  ambiguous: string[][];
  unresolved: number;
  reasons: ItemReason[];
}

export interface SessionItem extends Omit<ItemResult, "status"> {
  id: string;
  seq: number;
  kind: "IMAGE" | "TEXT";
  status: ItemStatus | "DUPLICATE";
}

export interface QuoteLine {
  studyId: string;
  name: string;
  priceBs: number;
}

export interface QuoteSessionsConfig {
  // Cuánto vive una sesión sin actividad (vence sin cotizar nada).
  ttlSeconds: number;
  // Tope de mensajes (fotos y textos) por sesión.
  maxItems: number;
  // Al cerrar: cuántas veces se espera (y cuánto) a que terminen los mensajes anteriores aún en proceso.
  waitRetries: number;
  waitDelayMs: number;
  sleep?(ms: number): Promise<void>;
  // Catálogo para identificar estudios ESCRITOS (puede ser un caché corto). Al cerrar se usa siempre deps.loadCatalog (recarga fresca).
  catalogForText?(): Promise<CatalogStudy[]>;
  // Protección contra bucles (G3.2): mensajes automáticos o ecos no entran a la sesión.
  loopProtection?: boolean;
  ownTexts?: readonly string[];
  // G4.1: ¿el mensaje pregunta por información (horarios, plazo de entrega, muestra, preparación...)? Si sí, lo atiende el manejador de siempre y NO se toma como lista de estudios (si no, «¿cuánto
  // demora el hemograma?» se anotaría como un estudio sin resolver). Lo entrega el cableado solo si las respuestas con conocimiento están activas.
  isInfoQuestion?(text: string): boolean;
  // G6.0 (apagado si falta): atención selectiva. Varios mensajes seguidos del mismo contacto: la confirmación de «anotado» espera un instante y, si llegó un mensaje más nuevo, calla (el estudio ya está en
  // la solicitud; el más nuevo confirma todo junto). Un saludo, una cortesía o un agradecimiento («gracias», «ok gracias», 👍) NUNCA cierran ni tocan una solicitud abierta (G6.1), y «listo» sin nada abierto tras una cotización reciente no se responde.
  attention?: { gate: { enter(from: string, seq?: number): number; retire(from: string, ticket: number): void; isLatest(from: string, ticket: number): boolean }; settleMs: number };
  // Intérprete de estudios escritos (apagado si falta; ver src/study-interpreter.ts): ayuda con errores de ortografía, abreviaturas y pedidos en lenguaje natural cuando el resolvedor exacto no basta. Todo lo que
  // devuelve ya viene validado contra el catálogo; si falla o no opina, el mensaje se procesa como siempre.
  interpreter?: StudyInterpreter;
}

export const DEFAULT_QUOTE_SESSIONS: Omit<QuoteSessionsConfig, "sleep" | "catalogForText" | "loopProtection" | "ownTexts" | "isInfoQuestion" | "attention" | "interpreter"> = { ttlSeconds: 1800, maxItems: 20, waitRetries: 8, waitDelayMs: 1500 };

// ───────────────────────────── repositorio (lo implementa audit.ts con RPC) ─────────────────────────────

export type QuoteBeginResult =
  | { status: "created" | "exists" | "duplicate"; itemId: string; sessionId: string; itemStatus: ItemStatus | "DUPLICATE" | "PROCESSING"; position: number; studyIds: string[]; unresolved: number; ambiguousGroups: number }
  | { status: "full"; sessionId: string; count: number };

export type QuoteReadResult =
  | { state: "none" }
  | { state: "pending"; pending: number }
  | { state: "ready"; sessionId: string; items: SessionItem[] }
  | { state: "replay"; sessionId: string; outcome: "QUOTED" | "NEEDS_REVIEW" | "NEEDS_RESEND" | "CANCELLED" | "EXPIRED"; reasons: string[]; lines?: QuoteLine[]; totalBs?: number };

export type QuoteCloseInput =
  | { sessionId: string; outcome: "QUOTED"; lines: QuoteLine[]; totalBs: number; catalogFingerprint: string }
  | { sessionId: string; outcome: "NEEDS_REVIEW"; reasons: ReviewReason[] }
  | { sessionId: string; outcome: "NEEDS_RESEND" | "CANCELLED" };

// Lectura de SOLO LECTURA de la solicitud abierta para el modo sombra (migración 20, función STABLE: la base no permite que escriba ni bloquee filas). `recent`: ¿hubo una cotización entregada hace poco? (solo un booleano).
export type ShadowPeekResult =
  | { state: "none" | "replay" | "unavailable" | "lease_lost"; recent: boolean }
  | { state: "pending"; pending: number; recent: boolean }
  | { state: "ready"; items: SessionItem[]; recent: boolean };

export type QuoteCloseResult = { status: "closed" | "replayed"; outcome: string } | { status: "pending" | "not_open" };

// ───────────────────────────── comandos ─────────────────────────────

const FINALIZE_WORDS = new Set(["listo", "lista", "ya", "eso", "es", "todo", "seria", "esta", "nada", "mas", "cotiza", "cotizar", "cotizame", "cotizalo", "cotizalos", "por", "favor", "gracias", "ahora", "puedes", "ok", "dale", "termine", "termino", "finalizar", "final", "fin", "si"]);
const FINALIZE_KEYS = new Set(["listo", "lista", "todo", "cotiza", "cotizar", "cotizame", "cotizalo", "cotizalos", "termine", "termino", "finalizar", "nada mas", "fin"]);
const CANCEL_PHRASES = new Set(["cancelar", "cancela", "cancelalo", "cancelar todo", "cancela todo", "anular", "anula", "borrar todo", "borra todo", "empezar de nuevo", "empezar otra vez", "reiniciar", "nueva solicitud"]);

// Solo un mensaje que ES el comando (corto y sin negaciones) lo activa: «aún no estoy listo» o «listo el resultado de mi examen» no cierran la sesión.
export function parseSessionCommand(text: string): "FINALIZE" | "CANCEL" | undefined {
  const key = normalizeStudyKey(text.slice(0, 120));
  if (key === "") return undefined;
  if (CANCEL_PHRASES.has(key)) return "CANCEL";
  const tokens = key.split(" ");
  if (tokens.length > 5 || !tokens.every((token) => FINALIZE_WORDS.has(token))) return undefined;
  const joined = tokens.join(" ");
  return tokens.some((token) => FINALIZE_KEYS.has(token)) || [...FINALIZE_KEYS].some((phrase) => phrase.includes(" ") && joined.includes(phrase)) ? "FINALIZE" : undefined;
}

// ───────────────────────────── estudios escritos ─────────────────────────────

// Palabras de cortesía y de pedido que pueden rodear al nombre de un estudio. Solo se quitan de los EXTREMOS del fragmento, nunca del interior, y nunca palabras que formen
// parte de un nombre (estudio, examen, análisis, perfil...): ante la duda el fragmento no se resuelve y el caso va a revisión.
const FILLER = new Set(["hola", "oye", "oiga", "buenas", "buenos", "dias", "tardes", "noches", "quiero", "quisiera", "necesito", "deseo", "quería", "queria", "cotizar", "cotizarme", "cotizacion", "cotiza", "cotizame", "cotice", "cotices", "precio", "precios", "cuanto", "cuesta", "cuestan", "sale", "salen", "costo", "me", "te", "se", "mi", "mis", "pueden", "puedes", "podrian", "podrias", "favor", "por", "gracias", "tambien", "ademas", "otro", "otra", "mas", "y", "e", "el", "la", "los", "las", "un", "una", "unos", "unas", "para", "si", "tengo", "que", "hacer", "hacerme", "hacerse", "realizar", "realizarme", "sacar", "sacarme", "saber", "ver", "es", "son", "de", "del", "gustaria", "interesa", "consultar", "averiguar", "solicito", "solicitar", "dame", "darme", "pasame", "enviame", "mandame", "todo", "todos", "eso", "esto", "estos", "esos", "junto", "juntos", "total", "en", "agrega", "agregame", "agregar", "agregale", "agregue", "agregues", "anade", "anadir", "anademe", "anadele", "suma", "sumame", "sumale", "incluye", "incluyeme", "incluir", "pon", "ponme", "ponle", "falta", "faltan", "nomas"]);
// Palabras que nombran «estudios» en general, sin decir cuál: un fragmento hecho solo de relleno y de estas palabras («quiero cotizar unos análisis») no es un estudio sin resolver, no dice nada.
const GENERIC = new Set(["analisis", "estudio", "estudios", "examen", "examenes", "laboratorio", "laboratorios", "receta", "orden", "medica", "medico", "chequeo", "varios", "algunos"]);
const MAX_SEGMENTS = 20;
const MAX_TOTAL_SEGMENTS = 40;
// Frases más largas que un nombre de estudio de buen tamaño no se buscan como un solo nombre.
const MAX_SPAN = 6;
// Viñetas y numeración al comienzo de una línea de la lista («1. hemograma», «- glucosa»).
const LIST_MARKER = /^\s*(?:[-•*·–—]+|\d{1,2}\s*[.)\-:])\s*/;
const MAX_AMBIGUOUS = 8;

const observation = (text: string): StudyObservation => ({ text, evidenceType: "PRINTED_TEXT", certainty: "HIGH", evidenceSummary: "texto del paciente" });

// Candidatos de un fragmento: la frase completa y las que resultan de quitar palabras de relleno de los extremos (de la más larga a la más corta).
function variants(segment: string): string[] {
  const tokens = normalizeStudyKey(segment).split(" ").filter(Boolean);
  const out: string[] = [];
  for (let start = 0; start <= tokens.length; start++) {
    if (start > 0 && !FILLER.has(tokens[start - 1]!)) break;
    for (let end = tokens.length; end > start; end--) {
      if (end < tokens.length && !FILLER.has(tokens[end]!)) break;
      out.push(tokens.slice(start, end).join(" "));
    }
  }
  return [...new Set(out)];
}

// ¿El mensaje PIDE los estudios («quiero colesterol», «necesito un hemograma», «cotiza…») y no solo los va nombrando? Un pedido claro se cotiza directamente; nombrar estudios sueltos o decir que se agregan
// («y también TSH», «agrega glucosa») sigue acumulando y preguntando «¿Eso es todo?».
const ASKS_FOR = /\b(quiero|quisiera|necesito|requiero|deseo|ocupo|me gustaria|hacerme|hacerse|sacarme|sacarse|realizarme|realizarse)\b/;
const ADDING = /\b(agrega\w*|anade\w*|suma\w*|incluy\w*|tambien|ademas|falta\w*|otro|otra|mas)\b/;
export function wantsQuoteNow(text: string): boolean {
  if (asksForPrice(text)) return true;
  const key = plain(text.slice(0, 300));
  return ASKS_FOR.test(key) && !ADDING.test(key);
}

export interface TextExtraction {
  result: ItemResult;
  // Estudios identificados con certeza en este mensaje (sin repetidos) y cuántos se repitieron dentro del propio mensaje.
  matched: CatalogStudy[];
  repeatedInMessage: number;
  // true si al menos un fragmento era (o parecía) un estudio: nombre exacto, ambiguo o sin resolver en un mensaje de cotización.
  isRequest: boolean;
  // true si el mensaje pide cotizar o pregunta un precio (cotiza, precio, cuánto cuesta...).
  wantsQuote: boolean;
}

type Segment = { kind: "MATCHED"; study: CatalogStudy } | { kind: "AMBIGUOUS"; candidates: CatalogStudy[] } | { kind: "UNMATCHED" } | { kind: "EMPTY" };

export function extractStudyRequests(text: string, catalog: readonly CatalogStudy[]): TextExtraction | undefined {
  const resolver = new ExactAliasCatalogResolver([...catalog]);
  const direct = (key: string): Segment => {
    const resolution = resolver.resolve(observation(key));
    return resolution.status === "MATCHED" ? { kind: "MATCHED", study: resolution.study } : resolution.status === "AMBIGUOUS" ? { kind: "AMBIGUOUS", candidates: resolution.candidates } : { kind: "UNMATCHED" };
  };
  // Nombres habituales y abreviaturas (G5.9): se buscan las demás frases del grupo con el MISMO resolvedor exacto. Si todas llegan al mismo estudio del catálogo, es ese; si llegan a varios, es ambiguo.
  const viaSynonyms = (key: string): Segment => {
    const found = new Map<string, CatalogStudy>();
    for (const other of synonymsOf(key)) {
      const resolution = resolver.resolve(observation(other));
      if (resolution.status === "MATCHED") found.set(resolution.study.id, resolution.study);
      else if (resolution.status === "AMBIGUOUS") for (const candidate of resolution.candidates) found.set(candidate.id, candidate);
    }
    // orden estable por id: la misma duda produce siempre las mismas opciones en el mismo orden
    const candidates = [...found.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    return candidates.length === 1 ? { kind: "MATCHED", study: candidates[0]! } : candidates.length > 1 ? { kind: "AMBIGUOUS", candidates } : { kind: "UNMATCHED" };
  };
  const resolvePhrase = (key: string): Segment => {
    const first = direct(key);
    return first.kind !== "UNMATCHED" ? first : viaSynonyms(key);
  };

  const resolveSegment = (segment: string): Segment => {
    const options = variants(segment);
    const tokens = normalizeStudyKey(segment).split(" ").filter(Boolean);
    // un fragmento que es solo cortesía o pedido («quiero cotizar», «precio», «unos análisis») no es un estudio sin resolver: no dice nada
    if (options.length === 0 || tokens.every((token) => FILLER.has(token) || GENERIC.has(token))) return { kind: "EMPTY" };
    let ambiguous: CatalogStudy[] | undefined;
    for (const option of options) {
      if (option === "") continue;
      const resolution = direct(option);
      if (resolution.kind === "MATCHED") return resolution;
      if (resolution.kind === "AMBIGUOUS") ambiguous ??= resolution.candidates;
    }
    if (ambiguous) return { kind: "AMBIGUOUS", candidates: ambiguous };
    // El catálogo no tiene esa frase tal cual: ¿es una abreviatura o un sinónimo de algo que sí tiene?
    let viaSynonym: Segment = { kind: "UNMATCHED" };
    for (const option of options) {
      if (option === "") continue;
      const resolution = viaSynonyms(option);
      if (resolution.kind === "MATCHED") return resolution;
      if (resolution.kind === "AMBIGUOUS" && viaSynonym.kind === "UNMATCHED") viaSynonym = resolution;
    }
    // Ningún candidato único: ¿había al menos una frase del fragmento que no sea solo relleno? Entonces es un estudio que no se resolvió.
    return viaSynonym;
  };

  // Una línea sin separadores («hemograma glucosa urea») se divide en los nombres que el catálogo reconoce, de izquierda a derecha y el más largo primero. Solo vale si TODA la línea queda cubierta
  // por nombres del catálogo (con relleno entre ellos): si sobra una palabra que no es relleno, no se adivina nada y la línea sigue sin resolver.
  const tile = (piece: string): Segment[] | undefined => {
    const tokens = normalizeStudyKey(piece).split(" ").filter(Boolean);
    if (tokens.length < 2 || tokens.length > 24) return undefined;
    const out: Segment[] = [];
    let at = 0;
    while (at < tokens.length) {
      if (FILLER.has(tokens[at]!)) {
        at++;
        continue;
      }
      let hit: { segment: Segment; end: number } | undefined;
      for (let end = Math.min(tokens.length, at + MAX_SPAN); end > at && !hit; end--) {
        const found = resolvePhrase(tokens.slice(at, end).join(" "));
        if (found.kind !== "UNMATCHED") hit = { segment: found, end };
      }
      if (!hit) return undefined;
      out.push(hit.segment);
      at = hit.end;
    }
    return out.length >= 2 ? out : undefined;
  };
  const resolveOrTile = (piece: string): Segment[] => {
    const one = resolveSegment(piece);
    return one.kind === "UNMATCHED" ? (tile(piece) ?? [one]) : [one];
  };

  const coarse = text.slice(0, 2000).split(/[,;\n+/]|\s&\s/).map((part) => part.replace(LIST_MARKER, "").trim()).filter(Boolean).slice(0, MAX_SEGMENTS);
  const segments: Segment[] = [];
  for (const part of coarse) {
    const whole = resolveSegment(part);
    if (whole.kind !== "UNMATCHED") {
      segments.push(whole);
      continue;
    }
    // Un nombre puede contener «y»: primero se intenta el fragmento entero y solo si no resuelve se separa en « y ».
    const pieces = part.split(/\s+(?:y|e|tambien|ademas)\s+/i).map((piece) => piece.trim()).filter(Boolean);
    if (pieces.length > 1) for (const piece of pieces.slice(0, MAX_SEGMENTS)) segments.push(...resolveOrTile(piece));
    else segments.push(...(tile(part) ?? [whole]));
    if (segments.length >= MAX_TOTAL_SEGMENTS) break;
  }

  const matchedById = new Map<string, CatalogStudy>();
  let repeated = 0;
  const ambiguous: string[][] = [];
  let unresolved = 0;
  for (const segment of segments) {
    if (segment.kind === "MATCHED") {
      if (matchedById.has(segment.study.id)) repeated++;
      else matchedById.set(segment.study.id, segment.study);
    } else if (segment.kind === "AMBIGUOUS") {
      if (segment.candidates.length > MAX_AMBIGUOUS) unresolved++;
      else ambiguous.push(segment.candidates.map((candidate) => candidate.id));
    } else if (segment.kind === "UNMATCHED") unresolved++;
  }
  const recognised = matchedById.size + ambiguous.length;
  // Un mensaje sin ningún estudio reconocible solo cuenta como solicitud si habla de cotizar/estudios (RECIPE_OR_QUOTE): «gracias» o «hola» no abren un caso sin resolver.
  const isRequest = recognised > 0 || (unresolved > 0 && classifyText(text) === "RECIPE_OR_QUOTE");
  if (!isRequest) return undefined;

  const reasons: ItemReason[] = [];
  if (ambiguous.length > 0) reasons.push("AMBIGUOUS_STUDY");
  if (unresolved > 0) reasons.push("UNRESOLVED_TEXT");
  const status: ItemStatus = unresolved > 0 ? "UNRESOLVED" : ambiguous.length > 0 ? "AMBIGUOUS" : "RESOLVED";
  return {
    result: { status, studyIds: [...matchedById.keys()], ambiguous: ambiguous.slice(0, 20), unresolved: Math.min(unresolved, 50), reasons },
    matched: [...matchedById.values()],
    repeatedInMessage: repeated,
    isRequest,
    wantsQuote: wantsQuoteNow(text)
  };
}

// ───────────────────────────── interpretación de estudios escritos ─────────────────────────────

// Lo que entendió el intérprete de un mensaje, YA VALIDADO por el backend contra el catálogo: cada estudio es un objeto del catálogo activo (con id de lab_tests) y nunca trae precio ni inventa nada. Los precios los
// calcula siempre evaluateSession al cerrar, con el catálogo recargado.
export interface InterpretedStudyRequest {
  // ¿El mensaje pide estudios o una cotización? Falso para charla, preguntas u otros temas.
  isQuoteRequest: boolean;
  wantsQuote: boolean;
  // Identificados con certeza. `exact`: el texto es literalmente el nombre o un alias del catálogo; si no, fue una interpretación (errata, abreviatura, nombre común).
  matched: Array<{ study: CatalogStudy; mention: string; exact: boolean }>;
  // Varios estudios del catálogo podrían ser el pedido (2 a 6): se le pregunta al paciente con opciones del catálogo.
  ambiguous: Array<{ mention: string; candidates: CatalogStudy[] }>;
  // Algo que parece un estudio pero no se pudo identificar con certeza: se le pide el nombre exacto.
  unclear: string[];
  // El catálogo NO tiene ese estudio (el backend lo comprobó): se informa cuál falta y se cotiza el resto.
  notFound: string[];
}

export type StudyInterpreter = (text: string, catalog: readonly CatalogStudy[], hint: { hasDoubt: boolean }) => Promise<InterpretedStudyRequest | undefined>;

export interface InterpretationNotes {
  notFound: string[];
  interpreted: Array<{ mention: string; studyName: string }>;
}

// Lo que el paciente escribió se repite al decirle qué se entendió o qué falta: solo letras, números y signos simples, corto y sin enlaces ni contactos. Nunca se guarda.
export function cleanMention(value: string): string {
  const clean = value.normalize("NFC").replace(/[^\p{L}\p{N} .,()+/-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim();
  return /https?|www|@/i.test(value) || clean.length < 2 ? "" : clean;
}

export const INTERPRETER_TEXTS = {
  interpreted: "Interpreté",
  interpreted_as: "como",
  not_found: "No encontré en nuestro catálogo:",
  not_found_outro: "Si quieres, escribe el nombre exacto de otro estudio o envíame una foto de tu receta."
} as const;

// Misma regla que los demás textos fijos: sin cifras, moneda ni promesas.
export function assertSafeInterpreterTexts(texts: Record<string, string> = INTERPRETER_TEXTS): void {
  for (const [key, value] of Object.entries(texts)) if (!value.trim() || /\d|\$|\b(bs|bob|usd|gratis|descuento|promocion|inmediat[a-z]*|persona|equipo|llamaremos)\b/.test(normalizeStudyKey(value))) throw new UnsafeQuoteTextError(`interpreter.${key}`);
}

// La nota que acompaña a la respuesta: qué se interpretó (solo lo que NO era un nombre del catálogo, para que el paciente pueda corregir) y qué estudios no existen en el catálogo.
export function formatInterpretationNote(notes: InterpretationNotes | undefined, texts: typeof INTERPRETER_TEXTS = INTERPRETER_TEXTS): string | undefined {
  if (!notes) return undefined;
  const lines: string[] = [];
  for (const item of notes.interpreted.slice(0, 5)) {
    const mention = cleanMention(item.mention);
    if (mention) lines.push(`${texts.interpreted} «${mention}» ${texts.interpreted_as} ${list([item.studyName])}.`);
  }
  const missing = [...new Set(notes.notFound.map(cleanMention).filter(Boolean))].slice(0, 8);
  if (missing.length > 0) lines.push(`${texts.not_found} ${missing.map((name) => `«${name}»`).join(", ")}.`, texts.not_found_outro);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

// Une lo que entendió el resolvedor exacto con lo que entendió el intérprete. El resolvedor exacto sigue mandando en lo que identificó; el intérprete aporta lo demás. Devuelve la extracción que ya usa
// la sesión (los estudios que no existen NO cuentan como «sin resolver»: no bloquean la cotización del resto) y las notas para el paciente.
export function mergeInterpretation(text: string, exact: TextExtraction | undefined, interpreted: InterpretedStudyRequest): { extraction: TextExtraction | undefined; notes: InterpretationNotes } {
  const matchedById = new Map<string, CatalogStudy>();
  for (const study of exact?.matched ?? []) matchedById.set(study.id, study);
  const repeated = exact?.repeatedInMessage ?? 0;
  const interpretedNotes: InterpretationNotes["interpreted"] = [];
  for (const item of interpreted.matched) {
    // Ya identificado por el resolvedor exacto: es el mismo estudio visto por dos caminos, no una repetición del paciente.
    if (matchedById.has(item.study.id)) continue;
    matchedById.set(item.study.id, item.study);
    if (!item.exact) interpretedNotes.push({ mention: item.mention, studyName: item.study.name });
  }
  // Una duda ya resuelta por otro camino no se pregunta de nuevo.
  const groups: string[][] = [...(exact?.result.ambiguous ?? []), ...interpreted.ambiguous.map((group) => group.candidates.map((candidate) => candidate.id))].filter((group) => !group.some((id) => matchedById.has(id)));
  const unique = new Map(groups.map((group) => [[...group].sort().join("|"), group]));
  const ambiguous = [...unique.values()].slice(0, 20);
  const unresolved = Math.min(interpreted.unclear.length, 50);
  const notes: InterpretationNotes = { notFound: interpreted.notFound, interpreted: interpretedNotes };

  const recognised = matchedById.size + ambiguous.length + unresolved;
  const isRequest = recognised > 0 && (interpreted.isQuoteRequest || exact !== undefined);
  if (!isRequest) return { extraction: undefined, notes };
  const reasons: ItemReason[] = [];
  if (ambiguous.length > 0) reasons.push("AMBIGUOUS_STUDY");
  if (unresolved > 0) reasons.push("UNRESOLVED_TEXT");
  const status: ItemStatus = unresolved > 0 ? "UNRESOLVED" : ambiguous.length > 0 ? "AMBIGUOUS" : "RESOLVED";
  return {
    extraction: {
      result: { status, studyIds: [...matchedById.keys()], ambiguous, unresolved, reasons },
      matched: [...matchedById.values()],
      repeatedInMessage: repeated,
      isRequest: true,
      wantsQuote: interpreted.wantsQuote || (exact?.wantsQuote ?? false) || wantsQuoteNow(text)
    },
    notes
  };
}

// Inserta una nota en una cotización ANTES del pie común (así los apéndices de preparación que se agregan después siguen quedando antes del pie).
export function withNote(body: string, note: string | undefined): string {
  if (!note) return body;
  const footer = `\n\n${QUOTE_FOOTER}`;
  return body.endsWith(footer) ? `${body.slice(0, -footer.length)}\n\n${note}${footer}` : `${body}\n\n${note}`;
}

// ───────────────────────────── evaluación al cerrar ─────────────────────────────

export type SessionEvaluation =
  | { kind: "EMPTY" }
  | { kind: "RESEND"; unreadable: number }
  | { kind: "REVIEW"; reasons: ReviewReason[] }
  | { kind: "QUOTE"; lines: QuoteLine[]; totalBs: number; duplicates: number };

const toCents = (price: number): number | undefined => (Number.isFinite(price) && Math.round(price * 100) >= 1 && Math.abs(price * 100 - Math.round(price * 100)) < 1e-6 ? Math.round(price * 100) : undefined);

// Decide qué hacer con la sesión usando el catálogo RECARGADO ahora. Orden de prioridad: ilegible (pedir reenviar) > dudoso (revisión) > cotizar. Cotiza solo si TODO lo recibido
// quedó identificado con certeza, cada estudio sigue activo en el catálogo y su precio es un importe válido.
export function evaluateSession(items: readonly SessionItem[], catalog: readonly CatalogStudy[]): SessionEvaluation {
  const counted = items.filter((item) => item.status !== "DUPLICATE");
  if (counted.length === 0) return { kind: "EMPTY" };
  const unreadable = counted.filter((item) => item.status === "UNREADABLE").length;
  if (unreadable > 0) return { kind: "RESEND", unreadable };

  const reasons = new Set<ReviewReason>();
  for (const item of counted) {
    // una ambigüedad que el paciente ya aclaró con un mensaje posterior no es una duda
    if (item.status === "AMBIGUOUS") {
      if (item.ambiguous.length === 0 || pendingGroupsOf(item, counted).length > 0) reasons.add("AMBIGUOUS_STUDY");
    } else if (item.status === "UNRESOLVED") reasons.add("UNRESOLVED_TEXT");
    else if (item.status === "UNCERTAIN") for (const reason of item.reasons) reasons.add(reason === "AMBIGUOUS_STUDY" || reason === "UNRESOLVED_TEXT" ? reason : "ENGINE_PARTIAL");
    // un mensaje que mezcla estudios seguros con dudosos también arrastra la duda
    if (item.status === "RESOLVED" && (item.ambiguous.length > 0 || item.unresolved > 0)) reasons.add("UNRESOLVED_TEXT");
  }
  if (reasons.size > 0) return { kind: "REVIEW", reasons: [...reasons] };

  const ids: string[] = [];
  let total = 0;
  for (const item of counted) for (const id of item.studyIds) ids.push(id);
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { kind: "EMPTY" };
  const byId = new Map(catalog.filter((study) => study.active).map((study) => [study.id, study]));
  const lines: QuoteLine[] = [];
  for (const id of unique) {
    const study = byId.get(id);
    if (!study) return { kind: "REVIEW", reasons: ["STUDY_UNAVAILABLE"] };
    const cents = toCents(study.priceBs);
    if (cents === undefined) return { kind: "REVIEW", reasons: ["PRICE_INVALID"] };
    lines.push({ studyId: study.id, name: study.name, priceBs: cents / 100 });
    total += cents;
  }
  return { kind: "QUOTE", lines, totalBs: total / 100, duplicates: ids.length - unique.length };
}

// ───────────────────────────── aclaraciones y estado de la sesión (G5.9) ─────────────────────────────

// Los grupos ambiguos de un mensaje que el paciente todavía NO aclaró. Un grupo («creatinina»: sérica o en orina) queda aclarado cuando un mensaje de TEXTO POSTERIOR, ya identificado con
// certeza, trae al menos una de sus opciones. Es la misma regla que aplica la base al cerrar (migración 14): la base nunca acepta cotizar con un grupo sin aclarar.
export function pendingGroupsOf(item: SessionItem, items: readonly SessionItem[]): string[][] {
  if (item.status !== "AMBIGUOUS") return [];
  const later = new Set<string>();
  for (const other of items) if (other.kind === "TEXT" && other.status === "RESOLVED" && other.seq > item.seq) for (const id of other.studyIds) later.add(id);
  return item.ambiguous.filter((group) => !group.some((id) => later.has(id)));
}

export interface SessionSummary {
  // Estudios anotados en la sesión (de cualquier mensaje), sin repetidos y en orden de llegada.
  studyIds: string[];
  // Grupos ambiguos sin aclarar, en orden de llegada.
  pendingGroups: string[][];
  // Mensajes con fragmentos que no se pudieron identificar, fotos con resultado parcial y fotos ilegibles.
  unresolved: number;
  uncertain: boolean;
  unreadable: number;
}

export function summarizeSession(items: readonly SessionItem[]): SessionSummary {
  const counted = items.filter((item) => item.status !== "DUPLICATE").sort((a, b) => a.seq - b.seq);
  const studyIds: string[] = [];
  const pendingGroups: string[][] = [];
  let unresolved = 0;
  let uncertain = false;
  let unreadable = 0;
  for (const item of counted) {
    for (const id of item.studyIds) if (!studyIds.includes(id)) studyIds.push(id);
    pendingGroups.push(...pendingGroupsOf(item, counted));
    if (item.status === "UNRESOLVED" || item.unresolved > 0) unresolved++;
    if (item.status === "UNCERTAIN") uncertain = true;
    if (item.status === "UNREADABLE") unreadable++;
  }
  return { studyIds, pendingGroups, unresolved, uncertain, unreadable };
}

// Las opciones que se le muestran al paciente para un grupo ambiguo: estudios ACTIVOS del catálogo, con su nombre. El número que responda indica la posición en esta lista.
export function optionsOf(group: readonly string[], catalog: readonly CatalogStudy[]): Array<{ id: string; name: string }> {
  const byId = new Map(catalog.filter((study) => study.active).map((study) => [study.id, study]));
  return group.flatMap((id) => {
    const study = byId.get(id);
    return study ? [{ id: study.id, name: study.name }] : [];
  });
}

// Respuestas cortas a lo que el agente preguntó: «sí» (eso es todo), «no» (falta algo) o el número/ordinal de una opción. Solo significan algo con una sesión abierta; sin ella son mensajes cualquiera.
export type SessionReply = { kind: "YES" } | { kind: "NO" } | { kind: "CHOICE"; index: number };
const YES_CORE = new Set(["si", "sii", "siii", "sip", "claro", "correcto", "exacto", "afirmativo", "adelante", "procede", "acuerdo", "seguro"]);
// G6.1: ni «gracias» ni «ok»/«dale»/«vale» confirman nada: solo una confirmación EXPLÍCITA cierra («sí», «sí, esos estudios», «eso es todo», «listo»). Un agradecimiento o un acuse no son una orden.
const YES_EXTRA = new Set(["que", "por", "favor", "eso", "es", "todo", "nada", "mas", "de", "esta", "bien", "asi", "cotiza", "cotizar", "cotizame", "cotizalo", "cotizalos", "ya", "listo", "esos", "estos", "esas", "estas", "estudio", "estudios", "son", "los", "las", "mismos", "correctos"]);
const NO_CORE = new Set(["no", "falta", "faltan", "espera", "esperame", "momento", "momentito", "todavia", "aun"]);
const NO_EXTRA = new Set(["un", "uno", "una", "otro", "otra", "mas", "tengo", "hay", "estudio", "estudios", "foto", "fotos", "por", "favor", "ahora", "ya", "que", "agregar"]);
const ORDINALS: Record<string, number> = { "1": 1, primero: 1, primera: 1, uno: 1, "2": 2, segundo: 2, segunda: 2, dos: 2, "3": 3, tercero: 3, tercera: 3, tres: 3, "4": 4, cuarto: 4, cuarta: 4, cuatro: 4, "5": 5, quinto: 5, quinta: 5, cinco: 5, "6": 6, sexto: 6, sexta: 6, seis: 6, "7": 7, septimo: 7, septima: 7, siete: 7, "8": 8, octavo: 8, octava: 8, ocho: 8 };
const CHOICE_LEAD = new Set(["el", "la", "opcion", "numero", "quiero", "elijo", "prefiero", "es", "sera", "seria"]);
const CHOICE_TRAIL = new Set(["opcion", "por", "favor", "gracias"]);

// «eso nomás», «solo eso»: dicen que no falta nada (G6.0). Frases completas: «solo» o «nomás» sueltos no significan nada.
const YES_PHRASES = /^(?:(?:si|claro|pues|bueno) )?(?:(?:solo|solamente|nomas|unicamente) (?:eso|esto)(?: nomas)?|(?:eso|esto) (?:nomas|solo|solamente|unicamente)|eso es lo unico)$/;

export function parseSessionReply(text: string): SessionReply | undefined {
  const tokens = normalizeStudyKey(text.slice(0, 60)).split(" ").filter(Boolean);
  if (tokens.length === 0 || tokens.length > 5) return undefined;
  if (YES_PHRASES.test(tokens.join(" "))) return { kind: "YES" };
  if (tokens.every((token) => YES_CORE.has(token) || YES_EXTRA.has(token)) && tokens.some((token) => YES_CORE.has(token))) return { kind: "YES" };
  if (tokens.every((token) => NO_CORE.has(token) || NO_EXTRA.has(token)) && tokens.some((token) => NO_CORE.has(token))) return { kind: "NO" };
  let start = 0;
  while (start < tokens.length && CHOICE_LEAD.has(tokens[start]!)) start++;
  const index = ORDINALS[tokens[start] ?? ""];
  if (index !== undefined && tokens.slice(start + 1).every((token) => CHOICE_TRAIL.has(token))) return { kind: "CHOICE", index };
  return undefined;
}

// Una pregunta general («¿qué es el hemograma?», «¿para qué sirve la glucosa?») no es una lista de estudios aunque nombre uno: la atiende el manejador de siempre (y el prompt de conversación). Si
// pide un precio o cotizar, sí es un pedido de cotización.
const INTERROGATIVE = /\b(que|cual|cuales|como|donde|cuando|por que|porque|para que|quien|sirve|sirven|significa|significan|consiste|incluye|incluyen|necesito saber|quisiera saber|me gustaria saber|puedo|se puede|se pueden|es necesario|hay que|debo)\b/;
export function isGeneralQuestion(text: string): boolean {
  if (asksForPrice(text)) return false;
  const clipped = text.slice(0, 300);
  return /[?¿]/.test(clipped) && INTERROGATIVE.test(plain(clipped));
}

// ───────────────────────────── mensajes ─────────────────────────────

export interface QuoteTexts {
  added_image: string;
  added_text: string;
  more_hint: string;
  uncertain_note: string;
  duplicate_image: string;
  full: string;
  empty: string;
  resend: string;
  review: string;
  // Solo se usa cuando el CRM YA registró el caso (G5.0): es el único texto de sesiones que menciona a una persona.
  review_confirmed: string;
  cancelled: string;
  nothing_to_cancel: string;
  waiting: string;
  repeated_note: string;
  unreadable_image: string;
  // G5.9: cotización por texto.
  identified_so_far: string;
  confirm_done: string;
  ask_option_intro: string;
  ask_option_outro: string;
  ask_unresolved: string;
  choose_invalid: string;
  not_done: string;
}

// BORRADORES pendientes de aprobación del laboratorio. Sin cifras ni importes: los números de los mensajes (conteos, precios) salen de la sesión y del catálogo. No prometen que
// una persona atenderá el caso (la revisión humana todavía no existe).
export const QUOTE_TEXTS: QuoteTexts = {
  added_image: "Recibí tu foto.",
  added_text: "Anoté lo que escribiste.",
  more_hint: "Puedes enviar otra foto o escribir más estudios. Cuando termines, escribe LISTO y te paso la cotización.",
  uncertain_note: "Hay algo que no pude identificar con certeza; te lo indicaré al cotizar.",
  duplicate_image: "Esa foto ya la tenía, no la conté dos veces. Cuando termines, escribe LISTO.",
  full: "Ya tengo muchos mensajes en esta solicitud. Escribe LISTO para cotizar lo que tengo.",
  empty: "Todavía no tengo estudios anotados. Envíame la foto de tu receta o escribe los nombres de los estudios y después escribe LISTO.",
  resend: "No pude leer algunas de tus fotos. Envíalas de nuevo (más claras y completas) o escribe los estudios, y después escribe LISTO.",
  review: "No pude identificar con certeza algunos estudios de tu solicitud, así que no te doy un precio para no equivocarme. Puedes enviar una foto más clara o escribir el nombre exacto del estudio.",
  review_confirmed: "No pude identificar con certeza algunos estudios de tu solicitud, así que no te doy un precio para no equivocarme. Una persona del equipo la revisará y te escribirá por este chat.",
  cancelled: "Listo, borré tu solicitud. Cuando quieras, envíame una nueva foto o escribe los estudios.",
  nothing_to_cancel: "No tenías ninguna solicitud abierta.",
  waiting: "Sigo procesando tus mensajes anteriores. Escribe LISTO de nuevo en un momento.",
  repeated_note: "Si repetiste algún estudio, lo conté una sola vez.",
  unreadable_image: "No pude leer esa imagen. Envíala de nuevo como foto, clara y completa.",
  identified_so_far: "Estudios anotados:",
  confirm_done: "¿Eso es todo? Responde SÍ y te paso la cotización, o envíame los estudios que falten.",
  ask_option_intro: "Para uno de los estudios tengo varias opciones:",
  ask_option_outro: "Responde con el número o escribe el nombre exacto del estudio.",
  ask_unresolved: "No pude identificar con certeza algunos estudios. Escribe el nombre exacto de cada uno o envía una foto de tu receta. Si no los encuentras, escribe LISTO y dejaré tu solicitud en revisión.",
  choose_invalid: "No encontré esa opción. Responde con el número de la lista o escribe el nombre exacto del estudio.",
  not_done: "De acuerdo, sigo esperando. Envíame los estudios que faltan y después responde SÍ o escribe LISTO."
};

export class UnsafeQuoteTextError extends Error {
  constructor(readonly key: string) {
    super(`texto de cotización no permitido: ${key}`);
    this.name = "UnsafeQuoteTextError";
  }
}
// Ningún texto fijo lleva cifras, moneda ni promesas de gratuidad, descuento o de una persona.
const FORBIDDEN_COMMON = /\d|\$|\b(bs|bob|usd|gratis|gratuito|descuento|promocion|inmediat[a-z]*|llamaremos)\b/;
const FORBIDDEN = /\d|\$|\b(bs|bob|usd|gratis|gratuito|descuento|promocion|inmediat[a-z]*|persona|equipo|asesor|llamaremos|escribira)\b/;
export function assertSafeQuoteTexts(texts: QuoteTexts): void {
  for (const key of Object.keys(QUOTE_TEXTS) as Array<keyof QuoteTexts>) {
    const value = texts[key];
    // Todos los textos evitan cifras y promesas; solo `review_confirmed` puede nombrar a una persona (y se envía únicamente con el caso ya registrado en el CRM).
    const forbidden = key === "review_confirmed" ? FORBIDDEN_COMMON : FORBIDDEN;
    if (typeof value !== "string" || value.trim() === "" || value.length > 400 || forbidden.test(normalizeStudyKey(value))) throw new UnsafeQuoteTextError(key);
  }
}

const list = (names: readonly string[]): string => names.map((name) => name.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()).join(", ");

// Confirmación al agregar un mensaje: qué estudios (nombres del catálogo, nunca el texto del paciente) quedaron anotados y cuántas cosas hay en la solicitud.
export function formatAck(input: { texts: QuoteTexts; kind: "IMAGE" | "TEXT"; names: readonly string[]; position: number; hasDoubt: boolean; repeated: number }): string {
  const lines = [input.kind === "IMAGE" ? input.texts.added_image : input.texts.added_text];
  if (input.names.length > 0) lines.push(`Estudios identificados: ${list(input.names)}.`);
  if (input.hasDoubt) lines.push(input.texts.uncertain_note);
  if (input.repeated > 0) lines.push(input.texts.repeated_note);
  lines.push(`Llevas ${input.position} ${input.position === 1 ? "mensaje" : "mensajes"} en tu solicitud.`, input.texts.more_hint);
  return lines.join("\n");
}

export type TextDoubt = "NONE" | "OPTIONS" | "UNRESOLVED" | "RESEND";

// Respuesta a un estudio escrito (G5.9): qué quedó anotado en la sesión y qué falta. Con dudas pregunta (las opciones salen del catálogo, numeradas; el texto del paciente nunca se repite); sin dudas
// pregunta si terminó. La cotización NUNCA sale de aquí.
export function formatTextReply(input: { texts: QuoteTexts; head?: string; names: readonly string[]; options: readonly string[]; doubt: TextDoubt; repeated: number; note?: string }): string {
  const { texts } = input;
  const lines: string[] = [];
  if (input.head) lines.push(input.head);
  if (input.names.length > 0) lines.push(`${texts.identified_so_far} ${list(input.names)}.`);
  if (input.repeated > 0) lines.push(texts.repeated_note);
  if (input.note) lines.push(input.note);
  if (input.doubt === "OPTIONS") lines.push(texts.ask_option_intro, ...input.options.map((name, index) => `${index + 1}. ${list([name])}`), texts.ask_option_outro);
  else if (input.doubt === "UNRESOLVED") lines.push(texts.ask_unresolved);
  else if (input.doubt === "RESEND") lines.push(texts.resend);
  else lines.push(texts.confirm_done);
  return lines.join("\n");
}

// Cotización más corta para WhatsApp (solo cotizaciones por texto): sin líneas en blanco entre el encabezado, los estudios y el total, y una sola línea en blanco entre bloques (notas, preparación, requisitos, pie).
// No quita ni cambia ninguna línea con contenido (salvo «de tu receta» del encabezado): precios, total e indicaciones aprobadas quedan idénticos.
export function compactQuote(body: string): string {
  const lines = body.replaceAll("\r\n", "\n").split("\n");
  const isNote = (line: string) => line.startsWith(INTERPRETER_TEXTS.interpreted + " «") || line.startsWith(INTERPRETER_TEXTS.not_found);
  const out: string[] = [];
  let previous = "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    const startsBlock = line.startsWith("🧪 *") || line.startsWith("📋 *") || line === QUOTE_FOOTER || (isNote(line) && !isNote(previous));
    if (out.length > 0 && startsBlock) out.push("");
    out.push(line);
    previous = line;
  }
  if (out[0]) out[0] = out[0].replace("Cotización de tu receta", "Cotización");
  return out.join("\n");
}

export function formatSessionQuote(lines: readonly QuoteLine[], duplicates: number, texts: QuoteTexts): string {
  const quote = formatQuoteMessage(buildPublicQuote(lines.map((line) => ({ name: line.name, priceBs: line.priceBs }))));
  return duplicates > 0 ? `${quote}\n\n${texts.repeated_note}` : quote;
}
