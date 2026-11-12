import { mentionsKnownStudy } from "./catalog-search.js";
import { normalizeStudyKey } from "./consensus.js";
import {
  cleanMention, extractStudyRequests, extractWithNotes, isGeneralQuestion, mergeInterpretation, optionsOf, parseSessionCommand, parseSessionReply, wantsQuoteNow,
  type InterpretationNotes, type InterpretedStudyRequest, type ItemResult, type StudyInterpreter, type TextExtraction
} from "./quote-session.js";
import { asksForPrice, classifyText } from "./text-handler.js";
import type { CatalogStudy } from "./types.js";

// COMPRENSIÓN GLOBAL DE UN LOTE DE KAPSO (Fase 1 del rediseño; función pura, aún sin conectar al webhook).
//
// Entrada: los mensajes de texto de UN contacto en un lote (en orden), el catálogo vigente y, opcionalmente, el estado de la sesión abierta y un intérprete de lenguaje (OpenAI) de apoyo.
// Salida: UNA comprensión del lote entero —estudios reconocidos, dudas, intención, comandos y señales de seguridad— lista para que `batch-policy.ts` decida qué responder.
//
// Principios:
//  · La unidad de interpretación es el LOTE, no el mensaje. El mismo pedido repartido en 1, 2 o 6 mensajes da la misma comprensión (invariancia ante la fragmentación).
//  · Los nombres partidos entre mensajes se reconstruyen por COBERTURA del catálogo, no por listas de frases: de todas las formas de agrupar mensajes contiguos se elige la que el catálogo explica
//    mejor (más estudios reconocidos y más palabras cubiertas, menos sin resolver); a igualdad, la más fina.
//  · La seguridad va primero y es determinista: lo médico, pedir a una persona o preguntar información se separa ANTES de cualquier interpretación; ese texto nunca llega al modelo ni se pierde.
//  · El modelo solo APOYA: se consulta una vez por lote y solo si hace falta (algo sin resolver, o una intención que el texto no deja clara). Su salida es no confiable: un estudio solo cuenta si
//    existe y está activo en el catálogo; nunca aporta precios; y si falla, el resultado determinista sigue valiendo.
//  · Los precios NO existen aquí: todo se expresa en ids de lab_tests. Los precios oficiales los calcula quien cotiza, con el catálogo recargado.

// ───────────────────────────── tipos ─────────────────────────────

export interface BatchFragment {
  id: string;
  // Solo en memoria: el contenido de un mensaje NUNCA se registra.
  text: string;
  // true si entre este mensaje y el anterior hubo algo que no es un texto (una foto, un audio...): los nombres de estudios no se reconstruyen a través de eso.
  breakBefore?: boolean;
}

// Lo que ya hay en la solicitud abierta del contacto (de summarizeSession). Solo ids y cantidades: nunca textos.
export interface SessionContext {
  open: boolean;
  studyIds: readonly string[];
  pendingGroups: ReadonlyArray<readonly string[]>;
  unresolved: number;
  uncertain: boolean;
  unreadable: number;
}

export const EMPTY_SESSION: SessionContext = { open: false, studyIds: [], pendingGroups: [], unresolved: 0, uncertain: false, unreadable: 0 };

export type BatchCommand =
  | { fragmentId: string; kind: "FINALIZE" | "CANCEL" | "YES" | "NO" }
  | { fragmentId: string; kind: "CHOICE"; index: number; indexes?: number[] };

// QUOTE: pide cotizar o el precio. CONFIRM: confirma («listo», «sí»). CANCEL: cancela. MORE: dice que falta algo («no»). DECLINE: pide NO cotizar («no quiero cotizar»). NONE: no hay intención de cotizar.
export type BatchIntent = "QUOTE" | "CONFIRM" | "CANCEL" | "MORE" | "DECLINE" | "NONE";
export type IntentSource = "COMMAND" | "MODEL" | "LEXICON" | "NONE";
export type ModelUse = "OFF" | "NOT_NEEDED" | "USED" | "FAILED" | "INVALID" | "TOO_LONG";

export interface AmbiguousGroup {
  // Lo que escribió el paciente (en memoria; no se registra) y los estudios del catálogo que podrían ser (ids de lab_tests).
  mention: string;
  candidateIds: string[];
}

export interface BatchUnderstanding {
  // Qué fragmentos formaron cada mención de estudio tras reconstruir los nombres partidos (para diagnóstico y pruebas; sin textos).
  groups: Array<{ fragmentIds: string[]; kind: "STUDIES" | "AMBIGUOUS" | "UNRESOLVED" | "TALK" }>;
  commands: BatchCommand[];
  // Fragmentos que NO son estudios y siguen su propio camino. Lo médico y pedir a una persona nunca se descartan; `split*` indica que la señal solo aparece al leer el lote completo.
  safety: { medical: string[]; humanRequest: string[]; medicalSplit: boolean; humanRequestSplit: boolean; splitFragmentIds: string[] };
  delegated: { questions: string[]; greetings: string[]; social: string[]; ignored: string[]; talk: string[] };
  // Solo los estudios de ESTE lote de texto (ya aclarados por «2», «la primera»...). Ids de lab_tests.
  // `interpreted`: estudios que el modelo identificó con otro nombre del que escribió el paciente (para decirle qué se entendió).
  studies: { matchedIds: string[]; ambiguous: AmbiguousGroup[]; unclear: string[]; notFound: string[]; interpreted: Array<{ mention: string; studyName: string }>; repeated: number; invalidChoices: number };
  // La solicitud completa: sesión abierta + este lote. Las dudas de la sesión que este lote aclara ya no figuran.
  request: { studyIds: string[]; pendingGroups: string[][]; unresolved: number; uncertain: boolean; unreadable: number };
  // Lo que se anotaría en la sesión por este lote de texto (un solo ítem), o undefined si el lote no trae estudios.
  item: ItemResult | undefined;
  intent: BatchIntent;
  intentSource: IntentSource;
  // Cómo se confirmó, si se confirmó: «listo» cierra aunque haya dudas (va a revisión); «sí» o una intención clara piden aclarar antes.
  confirmedBy?: "FINALIZE" | "YES";
  // Mensajes en los que alguna parte se anuló por negación («no quiero el hemograma»): lo anulado no cuenta como estudio ni como intención.
  negatedFragmentIds: string[];
  // Dudas sobre el alcance de una negación (ver «negación»): ante cualquiera, la política no cotiza directo y resume lo anotado para confirmar.
  negationDoubts: NegationDoubt[];
  // Con el modelo de lenguaje habría ayudado a entender este lote, lo haya o no consultado. `studies`: algún texto quedó sin identificar o se tomó por conversación (la ruta de siempre sí consulta al modelo en esos
  // casos). `intent`: hay estudios pero el texto no deja clara la intención (solo el motor nuevo consulta por eso). Sirve para no tomar como fiable una comparación hecha sin modelo.
  modelWouldHelp: { studies: boolean; intent: boolean };
  // Hubo una cancelación en el lote: la solicitud anterior se descarta y solo cuenta lo que vino después.
  cancelled: boolean;
  // La sesión estaba abierta ANTES de este lote (para saber si una cancelación tenía algo que cancelar).
  sessionWasOpen: boolean;
  // El comando de confirmar no iba al final (llegaron estudios después): no se aplica, para no cotizar lo que el paciente aún estaba agregando.
  confirmSuperseded: boolean;
  model: ModelUse;
}

export interface UnderstandInput {
  fragments: readonly BatchFragment[];
  catalog: readonly CatalogStudy[];
  session?: SessionContext;
  // Apoyo de lenguaje (OpenAI). Ausente = solo el resolvedor del catálogo. Recibe el mismo contrato que el intérprete de estudios de siempre.
  interpret?: StudyInterpreter;
  // «when-needed» (por defecto): se consulta si queda algo sin resolver o la intención no está clara. «always»: también para confirmar una intención de cotizar que el texto sí deja clara. «never»: nunca.
  modelUse?: "never" | "when-needed" | "always";
  // Preguntas de información del laboratorio (horarios, sucursales, conocimiento aprobado...) que el servicio quiera reconocer además de las generales.
  isInfoQuestion?: (text: string) => boolean;
  // Mensajes automáticos o ecos de nuestras propias respuestas: se ignoran por completo.
  isIgnorable?: (text: string) => boolean;
  // Cortesías y ruido sin ninguna solicitud («gracias», «ok», un emoji): quien conecte la atención selectiva (G6.0) aporta su detector; sin él son texto cualquiera y no bloquean nada.
  isSocial?: (text: string) => boolean;
  // Tope de caracteres que salen hacia el modelo (por defecto, el del intérprete de estudios).
  maxModelChars?: number;
}

export const DEFAULT_MAX_MODEL_CHARS = 600;
const MAX_FRAGMENTS = 24;
const MAX_GROUP_FRAGMENTS = 4;
const MAX_AMBIGUOUS_OPTIONS = 6;
// Parecido mínimo con el catálogo para que un texto suelto «parezca un estudio» (el mismo umbral con el que el intérprete decide que el catálogo no tiene nada parecido).
const STUDY_LIKE_SCORE = 0.6;

// ───────────────────────────── clasificación determinista de cada mensaje ─────────────────────────────

type Kind = "COMMAND" | "MEDICAL" | "HUMAN" | "QUESTION" | "GREETING" | "SOCIAL" | "IGNORED" | "CANDIDATE";
interface Classified {
  fragment: BatchFragment;
  order: number;
  kind: Kind;
  command?: BatchCommand;
  // El texto que se interpreta: el del mensaje sin lo que anula una negación.
  text: string;
}

function classify(fragment: BatchFragment, order: number, input: UnderstandInput): Classified {
  const text = fragment.text;
  const base = { fragment, order, text };
  if (input.isIgnorable?.(text)) return { ...base, kind: "IGNORED" };
  const finalize = parseSessionCommand(text);
  // El comando de cerrar también acepta verbos de cotizar («cotizar», «cotízame»). Si el mensaje además pide el precio, es una PETICIÓN de cotizar (parte del pedido), no solo confirmar que la lista está
  // completa: así «quiero» + «cotizar» y «quiero cotizar» se entienden igual. La cancelación sí sigue siendo siempre un comando.
  if (finalize && !(finalize === "FINALIZE" && wantsQuoteNow(text))) return { ...base, kind: "COMMAND", command: { fragmentId: fragment.id, kind: finalize } };
  const category = classifyText(text);
  // La seguridad se decide ANTES que cualquier respuesta corta: «no» o «2» dentro de un mensaje médico siguen siendo médicos.
  if (category === "MEDICAL") return { ...base, kind: "MEDICAL" };
  if (category === "HUMAN_REQUEST") return { ...base, kind: "HUMAN" };
  const reply = parseSessionReply(text);
  if (reply) return { ...base, kind: "COMMAND", command: reply.kind === "CHOICE" ? { fragmentId: fragment.id, kind: "CHOICE", index: reply.index, ...(reply.indexes ? { indexes: reply.indexes } : {}) } : { fragmentId: fragment.id, kind: reply.kind } };
  if (category === "INFO_REQUEST" || input.isInfoQuestion?.(text) || isGeneralQuestion(text)) return { ...base, kind: "QUESTION" };
  if (category === "GREETING") return { ...base, kind: "GREETING" };
  if (input.isSocial?.(text)) return { ...base, kind: "SOCIAL" };
  return { ...base, kind: "CANDIDATE" };
}

// ───────────────────────────── reconstrucción de nombres por cobertura del catálogo ─────────────────────────────

const tokensOf = (text: string): string[] => normalizeStudyKey(text).split(" ").filter(Boolean);
const tokensOfStudy = (study: CatalogStudy): Set<string> => new Set([study.normalizedName, ...study.normalizedAliases].flatMap(tokensOf));

// Puntaje de un grupo de mensajes unidos: cuánto de lo escrito explica el catálogo. Reconocer un estudio pesa más que cubrir palabras; lo ambiguo vale poco; lo sin resolver resta.
const W_MATCHED = 10;
const W_COVERED = 2;
const W_AMBIGUOUS = 3;
const W_UNRESOLVED = 6;

interface GroupScore {
  text: string;
  score: number;
  extraction: TextExtraction | undefined;
  // Lo que el catálogo no tiene y lo que se interpretó por parecido en este grupo.
  notes: InterpretationNotes;
  // Palabras del grupo que explican los estudios reconocidos (nombre o alias).
  explained: ReadonlySet<string>;
}

function makeScorer(catalog: readonly CatalogStudy[]) {
  const byId = new Map(catalog.map((study) => [study.id, study]));
  const tokenCache = new Map<string, Set<string>>();
  const studyTokens = (study: CatalogStudy): Set<string> => {
    let tokens = tokenCache.get(study.id);
    if (!tokens) {
      tokens = new Set([study.normalizedName, ...study.normalizedAliases].flatMap(tokensOf));
      tokenCache.set(study.id, tokens);
    }
    return tokens;
  };
  const cache = new Map<string, GroupScore>();
  return (text: string): GroupScore => {
    const cached = cache.get(text);
    if (cached) return cached;
    // Búsqueda por parecido con opciones: lo dudoso se pregunta, lo inexistente se dice, y nada bloquea la cotización del resto.
    const { extraction, notes } = extractWithNotes(text, catalog, { fuzzy: true });
    let score = 0;
    const explained = new Set<string>();
    if (extraction) {
      for (const study of extraction.matched) for (const token of studyTokens(study)) explained.add(token);
      for (const group of extraction.result.ambiguous) for (const id of group) {
        const study = byId.get(id);
        if (study) for (const token of studyTokens(study)) explained.add(token);
      }
      const covered = new Set(tokensOf(text).filter((token) => explained.has(token))).size;
      score = W_MATCHED * extraction.matched.length + W_AMBIGUOUS * extraction.result.ambiguous.length + W_COVERED * covered - W_UNRESOLVED * extraction.result.unresolved;
    }
    const scored: GroupScore = { text, score, extraction, notes, explained };
    cache.set(text, scored);
    return scored;
  };
}

// La mejor forma de agrupar una tanda de mensajes contiguos: programación dinámica sobre las particiones en tramos de hasta MAX_GROUP_FRAGMENTS mensajes. Maximiza el puntaje total y, a igualdad,
// prefiere MÁS grupos (no une lo que no gana nada al unirse). Determinista.
function bestGrouping(run: readonly Classified[], score: (text: string) => GroupScore): Array<{ members: Classified[]; scored: GroupScore }> {
  const n = run.length;
  const best: Array<{ score: number; groups: number; from: number } | undefined> = new Array(n + 1);
  best[0] = { score: 0, groups: 0, from: -1 };
  for (let end = 1; end <= n; end++) {
    for (let start = Math.max(0, end - MAX_GROUP_FRAGMENTS); start < end; start++) {
      const previous = best[start];
      if (!previous) continue;
      const text = run.slice(start, end).map((item) => item.text).join(" ");
      const total = previous.score + score(text).score;
      const groups = previous.groups + 1;
      const current = best[end];
      if (!current || total > current.score || (total === current.score && groups > current.groups)) best[end] = { score: total, groups, from: start };
    }
  }
  const out: Array<{ members: Classified[]; scored: GroupScore }> = [];
  for (let end = n; end > 0;) {
    const step = best[end]!;
    const members = run.slice(step.from, end);
    out.unshift({ members: [...members], scored: score(members.map((item) => item.text).join(" ")) });
    end = step.from;
  }
  return out;
}

// ───────────────────────────── negación ─────────────────────────────
//
// «no quiero cotizar», «no necesito el hemograma», «glucosa no», «no, mejor TSH»: lo que el paciente NIEGA no es lo que pide. Reglas generales de gramática y de orden, sin frases:
//  1. Una palabra de negación (no, nunca, jamás, tampoco, ni) anula desde ella hasta el final de SU cláusula. Una cláusula termina en un signo de puntuación, en «pero», «sino», «aunque» o AL FINAL DE
//     CADA MENSAJE: un mensaje es una enunciación completa, y lo que se escribe en el siguiente es una petición posterior, no parte de la negación.
//  2. Una negación al FINAL de la cláusula («glucosa no») anula lo que la precede hasta el último conector (y, e, o, u) o el inicio de la cláusula.
//  3. Una negación sin nada que negar («no quiero» y fin del mensaje) deja el objeto para el mensaje siguiente: eso es una DUDA (DANGLING). Ante una duda de negación NUNCA se cotiza directo: se resume
//     lo anotado y se pregunta. Tampoco se descarta nada en silencio.
//  4. Un «no» suelto al inicio de una cláusula («no, mejor glucosa») es una rectificación: no anula lo que viene después, pero si antes ya había una petición en el lote es una DUDA (RECTIFICATION).
//  5. Gana lo ÚLTIMO que el paciente dijo, en orden: un estudio que se pide y luego se niega queda fuera; uno que se niega y luego se pide queda dentro; y la intención de cotizar es la de la última
//     petición o negativa. Negar un estudio que ya estaba anotado en la solicitud abierta no se puede deshacer por aquí: es una DUDA (RETRACTS_SESSION).
// Excepción dictada por el catálogo (no por una lista de frases): si la negación es parte del nombre de un estudio que el catálogo reconoce en esa cláusula (p. ej. «pruebas no treponémicas»), no es una negación.
// Un «no» que es el mensaje entero es la respuesta «falta algo», no una negación: eso lo resuelven los comandos.
const NEGATORS = new Set(["no", "nunca", "jamas", "tampoco", "ni"]);
const CLAUSE_WORDS = new Set(["pero", "sino", "aunque"]);
const CONJUNCTIONS = new Set(["y", "e", "o", "u"]);

export type NegationDoubt = "DANGLING" | "RECTIFICATION" | "RETRACTS_SESSION";

// Lo dicho, en orden, por cláusula: lo que se pide (negated false) y lo que se anula (negated true). `key` ordena (mensaje, cláusula).
interface NegationSegment {
  order: number;
  key: number;
  negated: boolean;
  text: string;
}

interface Negation {
  // Texto efectivo de cada mensaje candidato (id -> texto sin lo anulado; "" si no quedó nada).
  masked: Map<string, string>;
  // Lo anulado, para reconocer que se negó el cotizar (no se registra).
  negatedText: string;
  negatedFragmentIds: string[];
  segments: NegationSegment[];
  doubts: Set<NegationDoubt>;
}

const segmentKey = (order: number, clause: number) => order * 1000 + Math.min(clause, 999);

function maskNegations(candidates: readonly Classified[], catalog: readonly CatalogStudy[]): Negation {
  type Piece = { owner: Classified; text: string; word: boolean; norm: string; masked: boolean };
  type Clause = { owner: Classified; index: number; words: Piece[]; last: boolean };
  const pieces: Piece[] = [];
  const clauses: Clause[] = [];
  for (const owner of candidates) {
    let current: Piece[] = [];
    let index = 0;
    const close = () => {
      if (current.length > 0) clauses.push({ owner, index: index++, words: current, last: false });
      current = [];
    };
    for (const raw of owner.fragment.text.match(/[^\s,;.:!?¿¡()]+|[,;.:!?¿¡()\n]/g) ?? []) {
      const norm = normalizeStudyKey(raw);
      if (CLAUSE_WORDS.has(norm)) {
        pieces.push({ owner, text: ",", word: false, norm: "", masked: false });
        close();
        continue;
      }
      const word = !/^[,;.:!?¿¡()\n]$/.test(raw);
      const piece: Piece = { owner, text: raw, word, norm, masked: false };
      pieces.push(piece);
      if (word) current.push(piece);
      else close();
    }
    close();
    // el final del mensaje cierra la cláusula (regla 1)
    const mine = clauses.filter((clause) => clause.owner === owner);
    if (mine.length > 0) mine[mine.length - 1]!.last = true;
  }

  const studyTokens = (study: CatalogStudy) => new Set([study.normalizedName, ...study.normalizedAliases].flatMap(tokensOf));
  const hasObject = (text: string): boolean => {
    const extraction = text.trim() === "" ? undefined : extractStudyRequests(text, catalog);
    return (extraction !== undefined && extraction.matched.length + extraction.result.ambiguous.length > 0) || asksForPrice(text);
  };
  const joined = (list: readonly Piece[]) => list.map((piece) => piece.text).join(" ");
  const segments: NegationSegment[] = [];
  const doubts = new Set<NegationDoubt>();
  const lastCandidateOrder = Math.max(-1, ...candidates.map((item) => item.order));
  const positiveContent = (): boolean => segments.some((segment) => !segment.negated && segment.text.trim() !== "" && (hasObject(segment.text) || wantsQuoteNow(segment.text)));

  for (const clause of clauses) {
    const { words } = clause;
    const order = clause.owner.order;
    const key = segmentKey(order, clause.index);
    const at = words.findIndex((piece) => NEGATORS.has(piece.norm));
    const push = (negated: boolean, list: readonly Piece[]) => {
      if (list.length > 0) segments.push({ order, key: key + (negated ? 0 : 0), negated, text: joined(list) });
    };
    if (at < 0) {
      push(false, words);
      continue;
    }
    const negator = words[at]!.norm;
    const extraction = extractStudyRequests(joined(words), catalog);
    if (extraction?.matched.some((study) => studyTokens(study).has(negator))) {
      push(false, words);
      continue;
    }
    // 4. «no» suelto: rectificación. No anula nada, pero si ya había una petición en el lote, no se sabe qué retira.
    if (at === 0 && words.length === 1) {
      words[0]!.masked = true;
      if (positiveContent()) doubts.add("RECTIFICATION");
      continue;
    }
    // 2. negación al final de la cláusula: anula la última mención (hasta el último conector); 1. si no, desde la negación hasta el final.
    let from = at;
    let to = words.length;
    if (at === words.length - 1 && at > 0) {
      let connector = -1;
      for (let index = at - 1; index >= 0; index--) if (CONJUNCTIONS.has(words[index]!.norm)) { connector = index; break; }
      from = connector + 1;
      to = at + 1;
    }
    const negatedWords = words.slice(from, to);
    for (const piece of negatedWords) piece.masked = true;
    push(false, [...words.slice(0, from), ...words.slice(to)]);
    // el texto anulado se guarda SIN las palabras de negación: es lo que el paciente niega (para reconocer qué estudio o qué petición)
    push(true, negatedWords.filter((piece) => !NEGATORS.has(piece.norm)));
    // 3. negación sin objeto al final del mensaje, con más mensajes después: el objeto quizá viene en el siguiente
    if (from === at && clause.last && order < lastCandidateOrder && !hasObject(joined(words.slice(at + 1)))) doubts.add("DANGLING");
  }

  const masked = new Map<string, string>();
  for (const owner of candidates) {
    let text = "";
    let lastWasWord = false;
    for (const piece of pieces) {
      if (piece.owner !== owner || piece.masked) continue;
      if (piece.word) {
        text += (lastWasWord ? " " : text === "" ? "" : " ") + piece.text;
        lastWasWord = true;
      } else {
        text += piece.text;
        lastWasWord = false;
      }
    }
    masked.set(owner.fragment.id, /[\p{L}\p{N}]/u.test(text) ? text.replace(/^[\s,;.:!?¿¡()]+|[\s,;.:]+$/g, "").trim() : "");
  }
  const negatedPieces = pieces.filter((piece) => piece.masked);
  return {
    masked,
    negatedText: negatedPieces.map((piece) => piece.text).join(" "),
    negatedFragmentIds: [...new Set(negatedPieces.map((piece) => piece.owner.fragment.id))],
    segments,
    doubts
  };
}

// Un texto sin estudios reconocidos puede ser un estudio mal escrito o abreviado, o simple conversación. Sin listas de frases:
//  · se parece a un estudio si el catálogo lo encuentra por aproximación (errata, plural, nombre incompleto);
//  · o si, quitadas las palabras de enlace, queda UNA sola sigla (2 a 5 caracteres casi sin vocales: «bh», «tsh», «pcr», «t4»). Las siglas que el catálogo conoce ya se reconocieron antes; esto solo
//    evita que una sigla desconocida se descarte en silencio y se cotice sin ella.
// Todo lo demás es conversación y no bloquea una cotización.
const FUNCTION_WORDS = new Set(["a", "al", "con", "de", "del", "e", "el", "en", "la", "las", "lo", "los", "o", "para", "por", "u", "un", "una", "y"]);

function looksLikeAcronym(token: string): boolean {
  if (!/^[a-z0-9]{2,5}$/.test(token) || !/[a-z]/.test(token)) return false;
  const vowels = (token.match(/[aeiou]/g) ?? []).length;
  return vowels / token.length <= 0.25;
}

function looksLikeStudyMention(text: string, catalog: readonly CatalogStudy[]): boolean {
  const tokens = tokensOf(text).filter((token) => !FUNCTION_WORDS.has(token));
  if (tokens.length === 0) return false;
  if (tokens.length === 1 && looksLikeAcronym(tokens[0]!)) return true;
  return mentionsKnownStudy(text, catalog, STUDY_LIKE_SCORE);
}

// Lo que el catálogo no explica de un texto. Una sigla desconocida («xhq») es lo más probable que sea un estudio real que el resolvedor exacto no conoce: el modelo debe MENCIONARLA explícitamente para
// que deje de bloquear (si la omite, se pide el nombre). Una frase corriente que solo se parece al catálogo por azar puede descartarla el modelo al no mencionarla, como ya hace el intérprete de estudios.
function residueOf(mention: string, scored: GroupScore): { mention: string; tokens: string[]; requiresMention: boolean } {
  const tokens = tokensOf(scored.text).filter((token) => !scored.explained.has(token));
  return { mention, tokens, requiresMention: tokens.some((token) => !FUNCTION_WORDS.has(token) && looksLikeAcronym(token)) };
}

// ───────────────────────────── validación de lo que devuelve el modelo ─────────────────────────────

// La salida del modelo es DATOS NO CONFIABLES: se reconstruye solo con lo que el catálogo confirma. Cualquier campo extra (precios, ids inventados, estudios inactivos) se descarta.
function validateInterpretation(raw: unknown, catalog: readonly CatalogStudy[]): InterpretedStudyRequest | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const active = new Map(catalog.filter((study) => study.active).map((study) => [study.id, study]));
  const asArray = (field: unknown): unknown[] => (Array.isArray(field) ? field.slice(0, 40) : []);
  const idOf = (item: unknown): string | undefined => {
    const study = (item as { study?: { id?: unknown } } | undefined)?.study;
    return typeof study?.id === "string" ? study.id : undefined;
  };
  const matched = asArray(value.matched).flatMap((item) => {
    const id = idOf(item);
    const study = id ? active.get(id) : undefined;
    const record = item as { mention?: unknown; exact?: unknown };
    return study ? [{ study, mention: cleanMention(String(record.mention ?? "")), exact: record.exact === true }] : [];
  });
  const ambiguous = asArray(value.ambiguous).flatMap((item) => {
    const record = item as { mention?: unknown; candidates?: unknown };
    const seen = new Set<string>();
    const candidates = asArray(record.candidates).flatMap((candidate) => {
      const id = typeof (candidate as { id?: unknown } | undefined)?.id === "string" ? (candidate as { id: string }).id : undefined;
      const study = id ? active.get(id) : undefined;
      if (!study || seen.has(study.id)) return [];
      seen.add(study.id);
      return [study];
    });
    return candidates.length >= 2 && candidates.length <= MAX_AMBIGUOUS_OPTIONS ? [{ mention: cleanMention(String(record.mention ?? "")), candidates }] : [];
  });
  const strings = (field: unknown): string[] => asArray(field).flatMap((item) => (typeof item === "string" && cleanMention(item) ? [cleanMention(item)] : [])).slice(0, 20);
  return { isQuoteRequest: value.isQuoteRequest === true, wantsQuote: value.wantsQuote === true, matched, ambiguous, unclear: strings(value.unclear), notFound: strings(value.notFound) };
}

// ───────────────────────────── comprensión del lote ─────────────────────────────

export async function understandBatch(input: UnderstandInput): Promise<BatchUnderstanding> {
  const catalog = input.catalog;
  const session = input.session ?? EMPTY_SESSION;
  const fragments = input.fragments.slice(0, MAX_FRAGMENTS);
  const classified = fragments.map((fragment, order) => classify(fragment, order, input));
  const ids = (kind: Kind) => classified.filter((item) => item.kind === kind).map((item) => item.fragment.id);

  const commands = classified.flatMap((item) => (item.command ? [item.command] : []));
  const lastCancelOrder = Math.max(-1, ...classified.filter((item) => item.command?.kind === "CANCEL").map((item) => item.order));
  const cancelled = lastCancelOrder >= 0;
  // Tras una cancelación solo cuenta lo que vino después.
  const live = (item: Classified) => item.order > lastCancelOrder;

  const candidates = classified.filter((item) => item.kind === "CANDIDATE" && live(item));
  // Negaciones: lo que el paciente anula no cuenta. Cada mensaje candidato se interpreta SIN lo anulado; si no queda nada, no participa.
  const negation = maskNegations(candidates, catalog);
  for (const item of candidates) item.text = negation.masked.get(item.fragment.id) ?? item.text;
  const active = candidates.filter((item) => item.text !== "");
  const delegated = {
    questions: ids("QUESTION"),
    greetings: ids("GREETING"),
    social: ids("SOCIAL"),
    ignored: ids("IGNORED"),
    talk: [] as string[]
  };

  // Seguridad: por mensaje y, además, sobre el lote leído completo (una señal partida entre mensajes sigue contando). Lo marcado nunca entra al modelo.
  const medical = ids("MEDICAL");
  const humanRequest = ids("HUMAN");
  const joinedCandidates = candidates.map((item) => item.fragment.text).join(" ");
  const medicalSplit = medical.length === 0 && candidates.length > 1 && classifyText(joinedCandidates) === "MEDICAL";
  const humanRequestSplit = humanRequest.length === 0 && candidates.length > 1 && classifyText(joinedCandidates) === "HUMAN_REQUEST";

  // Reconstrucción de nombres partidos: tandas de mensajes candidatos. Lo que no es candidato (seguridad, preguntas, saludos, ruido) es TRANSPARENTE: no corta ni cambia la reconstrucción, así agregar
  // un mensaje médico o de atención humana nunca altera los estudios. Solo cortan una tanda un COMANDO («listo», «2»...) y un mensaje que no es texto (una foto) en medio.
  const score = makeScorer(catalog);
  const runs: Classified[][] = [];
  let open: Classified[] | undefined;
  for (const item of classified) {
    if (!live(item)) continue;
    if (item.fragment.breakBefore === true || item.kind === "COMMAND") open = undefined;
    if (item.kind !== "CANDIDATE" || item.text === "") continue;
    if (!open) {
      open = [];
      runs.push(open);
    }
    open.push(item);
  }
  const groups: BatchUnderstanding["groups"] = [];
  const matched = new Map<string, CatalogStudy>();
  const ambiguous: AmbiguousGroup[] = [];
  // Cuándo (mensaje y cláusula) se pidió por última vez cada estudio o duda: para que gane lo último que dijo el paciente (regla 5 de la negación).
  const byId = new Map(catalog.map((study) => [study.id, study]));
  const matchedKey = new Map<string, number>();
  const ambiguousKey: number[] = [];
  const mentionKey = (tokens: ReadonlySet<string>, members: readonly Classified[]): number => {
    const orders = new Set(members.map((member) => member.order));
    let best = -1;
    for (const segment of negation.segments) if (!segment.negated && orders.has(segment.order) && tokensOf(segment.text).some((token) => tokens.has(token))) best = Math.max(best, segment.key);
    return best >= 0 ? best : segmentKey(Math.max(...orders), 999);
  };
  const unclear: string[] = [];
  // Por cada texto sin identificar, las palabras que el catálogo NO explica (para saber si el modelo se hizo cargo de él).
  const residues: Array<{ mention: string; tokens: string[]; requiresMention: boolean }> = [];
  const talkTexts: string[] = [];
  const textNotFound: string[] = [];
  const textInterpreted: Array<{ mention: string; studyName: string }> = [];
  let repeated = 0;
  let unresolvedCount = 0;
  for (const run of runs) {
    for (const group of bestGrouping(run, score)) {
      const fragmentIds = group.members.map((member) => member.fragment.id);
      const extraction = group.scored.extraction;
      // Solo cuenta como «estudio que el catálogo no tiene» lo que parece un estudio (sigla, parecido con el catálogo) o viene en un mensaje que habla de estudios o de cotizar; una frase corriente no.
      const missing = group.scored.notes.notFound.filter((mention) => looksLikeStudyMention(mention, catalog) || classifyText(group.scored.text) === "RECIPE_OR_QUOTE");
      textNotFound.push(...missing);
      textInterpreted.push(...group.scored.notes.interpreted);
      if (!extraction || extraction.matched.length + extraction.result.ambiguous.length === 0) {
        // Solo estudios que el catálogo no tiene: se le dice cuáles faltan; no es una duda que bloquee ni conversación.
        if (missing.length > 0 && extraction === undefined) {
          groups.push({ fragmentIds, kind: "TALK" });
          continue;
        }
        // El catálogo no reconoce ningún estudio en este texto (el extractor puede incluso marcarlo «sin resolver», p. ej. «no quiero cotizar»): ¿es un posible estudio sin identificar, o conversación?
        if (looksLikeStudyMention(group.scored.text, catalog)) {
          const mention = cleanMention(group.scored.text) || "estudio";
          unclear.push(mention);
          residues.push(residueOf(mention, group.scored));
          unresolvedCount++;
          groups.push({ fragmentIds, kind: "UNRESOLVED" });
        } else {
          delegated.talk.push(...fragmentIds);
          talkTexts.push(group.scored.text);
          groups.push({ fragmentIds, kind: "TALK" });
        }
        continue;
      }
      for (const study of extraction.matched) {
        if (matched.has(study.id)) repeated++;
        else matched.set(study.id, study);
        matchedKey.set(study.id, Math.max(matchedKey.get(study.id) ?? -1, mentionKey(tokensOfStudy(study), group.members)));
      }
      repeated += extraction.repeatedInMessage;
      for (const candidateIds of extraction.result.ambiguous) {
        ambiguous.push({ mention: cleanMention(group.scored.text), candidateIds: [...candidateIds] });
        ambiguousKey.push(mentionKey(new Set(candidateIds.flatMap((id) => [...tokensOfStudy(byId.get(id)!)])), group.members));
      }
      if (extraction.result.unresolved > 0) {
        const mention = cleanMention(group.scored.text) || "estudio";
        unclear.push(mention);
        residues.push(residueOf(mention, group.scored));
        unresolvedCount++;
      }
      groups.push({ fragmentIds, kind: extraction.result.unresolved > 0 ? "UNRESOLVED" : extraction.result.ambiguous.length > 0 ? "AMBIGUOUS" : "STUDIES" });
    }
  }

  // ── gana lo último que dijo el paciente (regla 5 de la negación) ──
  // Un estudio que se niega DESPUÉS de haberlo pedido en este lote queda fuera; uno que se pide después de negarlo queda dentro. Negar uno que ya estaba en la solicitud abierta es una duda.
  const negatedKey = new Map<string, number>();
  const negatedAmbiguous: Array<{ ids: Set<string>; key: number }> = [];
  for (const segment of negation.segments) {
    if (!segment.negated) continue;
    const extraction = extractStudyRequests(segment.text, catalog);
    if (!extraction) continue;
    for (const study of extraction.matched) negatedKey.set(study.id, Math.max(negatedKey.get(study.id) ?? -1, segment.key));
    for (const group of extraction.result.ambiguous) negatedAmbiguous.push({ ids: new Set(group), key: segment.key });
  }
  for (const [id, key] of matchedKey) if ((negatedKey.get(id) ?? -1) >= key) matched.delete(id);
  for (let index = ambiguous.length - 1; index >= 0; index--) {
    if (negatedAmbiguous.some((negated) => negated.key >= ambiguousKey[index]! && ambiguous[index]!.candidateIds.some((id) => negated.ids.has(id)))) {
      ambiguous.splice(index, 1);
      ambiguousKey.splice(index, 1);
    }
  }
  if (!cancelled && session.studyIds.some((id) => negatedKey.has(id))) negation.doubts.add("RETRACTS_SESSION");

  // ── apoyo del modelo ──
  const modelMode = input.modelUse ?? "when-needed";
  let model: ModelUse = input.interpret && modelMode !== "never" ? "NOT_NEEDED" : "OFF";
  let modelWantsQuote: boolean | undefined;
  let notFoundList: string[] = [...new Set(textNotFound)].slice(0, 8);
  let interpretedNotes: Array<{ mention: string; studyName: string }> = [...textInterpreted].slice(0, 8);
  const activeJoined = active.map((item) => item.text).join(" ");
  // La intención de cotizar es la de la ÚLTIMA petición o negativa (regla 5): se pide cotizar (en lo no anulado) o se niega el cotizar o el precio (en lo anulado). Si ninguna cláusula por sí sola pide
  // cotizar pero el texto no anulado unido sí («quiero» + «cotizar»), cuenta como pedido en el último mensaje.
  const quoteKeys = negation.segments.filter((segment) => !segment.negated && wantsQuoteNow(segment.text)).map((segment) => segment.key);
  if (quoteKeys.length === 0 && active.length > 0 && wantsQuoteNow(activeJoined)) quoteKeys.push(segmentKey(Math.max(...active.map((item) => item.order)), 999));
  const declineKeys = negation.segments.filter((segment) => segment.negated && asksForPrice(segment.text)).map((segment) => segment.key);
  const lastQuoteKey = Math.max(-1, ...quoteKeys);
  const lastDeclineKey = Math.max(-1, ...declineKeys);
  const lexiconWantsQuote = lastQuoteKey > lastDeclineKey;
  // Pidió NO cotizar: lo último que dijo sobre cotizar fue negarlo.
  const lexiconDecline = lastDeclineKey >= 0 && lastDeclineKey >= lastQuoteKey;
  const hasDoubt = unresolvedCount > 0 || ambiguous.length > 0;
  const confirmOrderPre = Math.max(-1, ...classified.filter((item) => item.command?.kind === "FINALIZE" || item.command?.kind === "YES").map((item) => item.order));
  const hasConfirmPre = confirmOrderPre > lastCancelOrder && !candidates.some((item) => item.order > confirmOrderPre);
  const needsStudyHelp = unresolvedCount > 0 || textNotFound.length > 0;
  const needsIntentHelp = active.length > 0 && !hasConfirmPre && ((matched.size > 0 && !lexiconWantsQuote) || (modelMode === "always" && lexiconWantsQuote));
  const modelWouldHelp = {
    studies: candidates.length > 0 && (needsStudyHelp || groups.some((group) => group.kind === "TALK")),
    intent: candidates.length > 0 && active.length > 0 && !hasConfirmPre && matched.size > 0 && !lexiconWantsQuote
  };
  if (input.interpret && modelMode !== "never" && candidates.length > 0 && (needsStudyHelp || needsIntentHelp)) {
    // Solo sale lo que NO es seguridad ni comando: el transcript de los mensajes candidatos. Si no cabe, solo lo que quedó sin resolver; si tampoco cabe, no se consulta.
    const limit = input.maxModelChars ?? DEFAULT_MAX_MODEL_CHARS;
    let transcript = active.map((item) => item.text).join("\n");
    if (transcript.length > limit) transcript = [...unclear, ...talkTexts].join("\n");
    if (transcript.trim() === "" || transcript.length > limit) {
      model = "TOO_LONG";
    } else {
      try {
        const raw = await input.interpret(transcript, catalog, { hasDoubt });
        const interpreted = validateInterpretation(raw, catalog);
        if (!interpreted) {
          model = raw === undefined ? "FAILED" : "INVALID";
        } else {
          model = "USED";
          modelWantsQuote = interpreted.isQuoteRequest && interpreted.wantsQuote;
          const exact = candidates.length > 0 && (matched.size > 0 || ambiguous.length > 0)
            ? ({
                result: { status: "RESOLVED", studyIds: [...matched.keys()], ambiguous: ambiguous.map((group) => group.candidateIds), unresolved: unresolvedCount, reasons: [] },
                matched: [...matched.values()], repeatedInMessage: 0, isRequest: true, wantsQuote: lexiconWantsQuote
              } as TextExtraction)
            : undefined;
          const merged = mergeInterpretation(transcript, exact, interpreted);
          if (merged.extraction) {
            const extraction = merged.extraction;
            matched.clear();
            for (const study of extraction.matched) matched.set(study.id, study);
            ambiguous.length = 0;
            for (const candidateIds of extraction.result.ambiguous) ambiguous.push({ mention: "", candidateIds: [...candidateIds] });
          }
          // Con el modelo consultado, un texto sin identificar deja de bloquear si lo trató como estudio (identificado, ambiguo, sin identificar o ausente del catálogo) o si era una frase corriente que
          // no mencionó. Una SIGLA desconocida exige mención explícita: si el modelo la omite sigue bloqueando, para no cotizar sin un estudio que el paciente sí pidió.
          const modelMentions = [...interpreted.matched.map((item) => item.mention), ...interpreted.ambiguous.map((item) => item.mention), ...interpreted.unclear, ...interpreted.notFound].map((mention) => new Set(tokensOf(mention)));
          const stillUnaddressed = residues.filter((residue) => residue.requiresMention && !modelMentions.some((mention) => residue.tokens.some((token) => mention.has(token)))).map((residue) => residue.mention);
          unclear.length = 0;
          unclear.push(...stillUnaddressed, ...interpreted.unclear);
          unresolvedCount = unclear.length;
          // Lo que el catálogo no tiene y el modelo ni mencionó sigue figurando (nunca se descarta en silencio un estudio que el paciente pidió).
          const stillMissing = textNotFound.filter((mention) => !modelMentions.some((set) => tokensOf(mention).some((token) => set.has(token))));
          notFoundList = [...new Set([...stillMissing, ...merged.notes.notFound])].slice(0, 8);
          interpretedNotes = [...interpretedNotes.filter((item) => !merged.notes.interpreted.some((other) => other.studyName === item.studyName)), ...merged.notes.interpreted];
        }
      } catch {
        model = "FAILED";
      }
    }
  }

  // ── comandos de respuesta: «2», «la primera» ──
  // Un grupo ambiguo (de la sesión o de este lote) se aclara si este lote trae una de sus opciones identificada con certeza (misma regla que aplica la base al cerrar) o con un número válido.
  const matchedIds = new Set(matched.keys());
  const pending: string[][] = [...session.pendingGroups.map((group) => [...group]).filter(() => !cancelled), ...ambiguous.map((group) => [...group.candidateIds])];
  const chosenIds: string[] = [];
  let invalidChoices = 0;
  const stillPending = pending.filter((group) => !group.some((id) => matchedIds.has(id)));
  for (const command of commands) {
    if (command.kind !== "CHOICE" || classified[classified.findIndex((item) => item.fragment.id === command.fragmentId)]!.order <= lastCancelOrder) continue;
    const group = stillPending[0];
    if (!group) {
      // Sin ninguna duda por aclarar, un número suelto es un mensaje cualquiera (como en la lógica de siempre): no es una opción inválida.
      delegated.talk.push(command.fragmentId);
      continue;
    }
    const options = optionsOf(group, catalog);
    const wanted = command.indexes ?? [command.index];
    const picks = options.length >= 2 ? wanted.map((index) => options[index - 1]) : [];
    if (picks.length === 0 || picks.some((pick) => !pick)) {
      invalidChoices++;
      continue;
    }
    stillPending.shift();
    for (const chosen of picks as Array<{ id: string; name: string }>) {
      chosenIds.push(chosen.id);
      matchedIds.add(chosen.id);
      for (let index = stillPending.length - 1; index >= 0; index--) if (stillPending[index]!.includes(chosen.id)) stillPending.splice(index, 1);
    }
  }
  const batchMatchedIds = [...new Set([...matched.keys(), ...chosenIds])];
  const clearedAmbiguous = ambiguous.filter((group) => !group.candidateIds.some((id) => matchedIds.has(id)));

  // ── intención ──
  const nonCancelCommands = classified.filter((item) => item.command && live(item));
  const lastConfirm = nonCancelCommands.filter((item) => item.command!.kind === "FINALIZE" || item.command!.kind === "YES").at(-1);
  const studyOrders = classified.filter((item) => (item.kind === "CANDIDATE" || item.command?.kind === "CHOICE") && live(item)).map((item) => item.order);
  const confirmSuperseded = lastConfirm !== undefined && studyOrders.some((order) => order > lastConfirm.order);
  const confirmed = lastConfirm !== undefined && !confirmSuperseded ? (lastConfirm.command!.kind as "FINALIZE" | "YES") : undefined;
  const sawNo = nonCancelCommands.some((item) => item.command!.kind === "NO");
  let intent: BatchIntent = "NONE";
  let intentSource: IntentSource = "NONE";
  if (cancelled && candidates.length === 0 && studyOrders.length === 0 && !confirmed) {
    intent = "CANCEL";
    intentSource = "COMMAND";
  } else if (confirmed) {
    intent = "CONFIRM";
    intentSource = "COMMAND";
  } else if (modelWantsQuote !== undefined) {
    intent = modelWantsQuote ? "QUOTE" : lexiconDecline ? "DECLINE" : "NONE";
    intentSource = "MODEL";
  } else if (lexiconWantsQuote) {
    intent = "QUOTE";
    intentSource = "LEXICON";
  } else if (lexiconDecline) {
    intent = "DECLINE";
    intentSource = "LEXICON";
  }
  if (intent === "NONE" && sawNo) {
    intent = "MORE";
    intentSource = "COMMAND";
  }

  // ── la solicitud completa: sesión (si no se canceló) + este lote ──
  const base = cancelled ? EMPTY_SESSION : session;
  const requestStudyIds = [...new Set([...base.studyIds, ...batchMatchedIds])];
  const requestPending = stillPending;
  const batchUnclearCount = Math.min(unresolvedCount, 50);
  const item: ItemResult | undefined =
    batchMatchedIds.length > 0 || clearedAmbiguous.length > 0 || batchUnclearCount > 0
      ? {
          status: batchUnclearCount > 0 ? "UNRESOLVED" : clearedAmbiguous.length > 0 ? "AMBIGUOUS" : "RESOLVED",
          studyIds: batchMatchedIds,
          ambiguous: clearedAmbiguous.map((group) => group.candidateIds).slice(0, 20),
          unresolved: batchUnclearCount,
          reasons: [...(clearedAmbiguous.length > 0 ? (["AMBIGUOUS_STUDY"] as const) : []), ...(batchUnclearCount > 0 ? (["UNRESOLVED_TEXT"] as const) : [])]
        }
      : undefined;

  return {
    groups,
    commands,
    safety: { medical, humanRequest, medicalSplit, humanRequestSplit, splitFragmentIds: medicalSplit || humanRequestSplit ? candidates.map((item) => item.fragment.id) : [] },
    delegated,
    studies: { matchedIds: batchMatchedIds, ambiguous: clearedAmbiguous, unclear: [...unclear], notFound: notFoundList, interpreted: interpretedNotes, repeated, invalidChoices },
    request: { studyIds: requestStudyIds, pendingGroups: requestPending, unresolved: base.unresolved + batchUnclearCount, uncertain: base.uncertain, unreadable: base.unreadable },
    item,
    intent,
    intentSource,
    ...(confirmed ? { confirmedBy: confirmed } : {}),
    negatedFragmentIds: negation.negatedFragmentIds,
    negationDoubts: [...negation.doubts].sort(),
    modelWouldHelp,
    cancelled,
    sessionWasOpen: session.open,
    confirmSuperseded,
    model
  };
}
