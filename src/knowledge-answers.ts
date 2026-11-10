import { scheduleStatusAt, type BranchPayload, type KnowledgeResult, type KnowledgeService, type Provenance, type ScheduleService, type UnavailableReason } from "./knowledge/index.js";
import type { FactProvenance, FactResult, SampleView, StudyFactKind, StudyFactsQueries, TurnaroundView } from "./study-facts/index.js";
import { plain, words } from "./text-normalize.js";
import type { CatalogStudy } from "./types.js";

// Respuestas basadas en el conocimiento APROBADO del laboratorio (G3.1A). Determinista: sin modelos. Cada dato que aparece en una respuesta sale de un registro aprobado y vigente
// (la plantilla solo pone los títulos y conectores); si no hay dato, esa parte no se responde y se dice que no hay información disponible. Nunca se completa, se estima ni se
// "supone" nada: ni horarios, ni preparaciones, ni políticas. Del catálogo solo se usa id, nombre, alias aprobados y estado activo (nunca precios).

// Lo único que el manejador necesita del servicio de conocimiento (de solo lectura).
export type KnowledgeQueries = Pick<KnowledgeService, "getBranches" | "getSchedule" | "getPolicy" | "getPaymentMethods" | "findFaqByTag" | "getStudyPreparation">;

// ───────────────────────────── temas ─────────────────────────────
// Temas de política que el agente sabe consultar. El laboratorio debe usar EXACTAMENTE estos códigos en `topic` para que una política pueda responderse.
export const POLICY_TOPICS = ["RESULTS_DELIVERY", "HOME_SAMPLING", "INVOICING", "CONVENIOS", "APPOINTMENTS"] as const;
export type PolicyTopic = (typeof POLICY_TOPICS)[number];

export type Topic =
  | { kind: "HOURS"; service: ScheduleService }
  | { kind: "LOCATION" }
  | { kind: "PAYMENT" }
  | { kind: "POLICY"; topic: PolicyTopic }
  | { kind: "PREPARATION" }
  // G4.1: datos aprobados por estudio. Solo se consultan si se entrega `studyFacts` y se identifica el estudio (mencionado o de la última cotización).
  | { kind: "TURNAROUND" }
  | { kind: "SAMPLE" };

const HOUR_WORDS = /\b(horario\w*|hora\w* de (atencion|apertura|cierre|toma|entrega)|a que hora|hasta que hora|desde que hora|abren|abre|cierran|cierra|atienden|atiende)\b/;
const SAMPLE = /\b(toma\w* de muestra\w*|muestra\w*|sacan sangre|extraccion\w*)\b/;
const RESULTS = /\bresultado\w*\b/;
const HOME = /\bdomicilio\w*\b/;
const LOCATION = /\b(ubicaci\w*|ubicad\w*|direccion\w*|donde (esta|estan|queda|quedan|los encuentro|se encuentran)|sucursal\w*|como llego|como llegar|mapa)\b/;
const PAYMENT = /\b(pago\w*|pagar|pagamos|tarjeta\w*|qr|transferencia\w*|efectivo|metodo\w* de pago)\b/;
const RESULTS_DELIVERY = /\b(entreg\w*|recog\w*|retir\w*|recib\w*|demor\w*|tard\w*|listos?|salen|llegan|cuando|envi\w*|enlace\w*|link\w*|descarg\w*|consult\w*|linea)\b/;
const INVOICING = /\bfactura\w*\b/;
const CONVENIOS = /\b(convenio\w*|seguro\w*)\b/;
const APPOINTMENTS = /\b(cita\w*|agendar|reservar|reserva|turno\w*)\b/;
const PREPARATION = /\b(ayuno\w*|ayunas|preparaci\w*|prepararme|preparar\w*)\b/;
const NOW = /\b(ahora|ya|hoy)\b/;
// G4.1. Plazo de entrega por estudio: «cuánto demora», «en cuánto tiempo», «para cuándo», «tiempo de entrega», «plazo». (La forma general «resultado + entregan/cuándo» ya es la política.)
const TURNAROUND_Q = /\b(cuanto (tiempo )?(demora\w*|tarda\w*|tardan|toma|se tarda|se demora)|en cuanto tiempo|para cuando|tiempo de entrega|plazo\w*|demora\w*|tardan?|tarda|cuando (estan|esta|estaran|estara|entregan|entregaran|sale|salen|llegan|puedo (recoger|retirar|recogerlo|recogerlos)))\b/;
// Tipo de muestra y requisitos especiales de la toma: «qué muestra», «tipo de muestra», «requisitos», «qué debo llevar/traer», «frasco».
const SAMPLE_Q = /\b(tipo\w* de muestra\w*|que (tipo de )?muestra\w*|cual\w* (es )?(la )?muestra|muestra de (sangre|orina|heces|saliva)|requisito\w*|que (debo|tengo que|hay que|se debe|necesito) (llevar|traer)|frasco\w*|recipiente\w*|como (se )?toma\w* (la )?muestra)\b/;

export const MAX_TOPICS = 3;

// Temas pedidos en un mensaje (en orden estable, sin repetir, hasta MAX_TOPICS). Vacío = nada que consultar.
// includeStudyFacts (G4.1; apagado por defecto): además reconoce el plazo de entrega y el tipo de muestra/requisitos por estudio. Sin él el resultado es el de G3.1A.
export function detectTopics(text: string, includeStudyFacts = false): Topic[] {
  const t = plain(text.slice(0, 4000));
  const out: Topic[] = [];
  const hours = HOUR_WORDS.test(t);
  if (hours) {
    const services: ScheduleService[] = [];
    if (SAMPLE.test(t)) services.push("SAMPLE_COLLECTION");
    if (RESULTS.test(t)) services.push("RESULTS_PICKUP");
    if (HOME.test(t)) services.push("HOME_SAMPLING");
    for (const service of services.length > 0 ? services : (["OFFICE"] as const)) out.push({ kind: "HOURS", service });
  }
  if (LOCATION.test(t)) out.push({ kind: "LOCATION" });
  if (PAYMENT.test(t)) out.push({ kind: "PAYMENT" });
  if (!hours && RESULTS.test(t) && RESULTS_DELIVERY.test(t)) out.push({ kind: "POLICY", topic: "RESULTS_DELIVERY" });
  if (!hours && HOME.test(t)) out.push({ kind: "POLICY", topic: "HOME_SAMPLING" });
  if (INVOICING.test(t)) out.push({ kind: "POLICY", topic: "INVOICING" });
  if (CONVENIOS.test(t)) out.push({ kind: "POLICY", topic: "CONVENIOS" });
  if (APPOINTMENTS.test(t)) out.push({ kind: "POLICY", topic: "APPOINTMENTS" });
  if (PREPARATION.test(t)) out.push({ kind: "PREPARATION" });
  if (includeStudyFacts && !hours && (TURNAROUND_Q.test(t) || (RESULTS.test(t) && RESULTS_DELIVERY.test(t)))) out.push({ kind: "TURNAROUND" });
  if (includeStudyFacts && !hours && SAMPLE_Q.test(t)) out.push({ kind: "SAMPLE" });
  return out.slice(0, MAX_TOPICS);
}

// ───────────────────────────── estudios mencionados ─────────────────────────────
// El estudio por el que se pregunta se identifica SOLO si el texto contiene, como palabras completas, el nombre normalizado o un alias aprobado de un estudio ACTIVO del
// catálogo. Sin coincidencia exacta no se adivina: se pregunta cuál es. Si el mismo texto pertenece a más de un estudio, es ambiguo y no se responde.
export const MAX_STUDIES = 5;

export interface StudyMentions {
  studies: CatalogStudy[];
  // Frases que coinciden con más de un estudio (ambiguas): no se responde por ellas.
  ambiguous: string[];
}

export function findStudyMentions(text: string, catalog: readonly CatalogStudy[]): StudyMentions {
  const haystack = ` ${plain(text.slice(0, 4000))} `;
  const byPhrase = new Map<string, Set<string>>();
  const studyById = new Map<string, CatalogStudy>();
  for (const study of catalog) {
    if (!study.active) continue;
    for (const phrase of new Set([study.normalizedName, ...study.normalizedAliases])) {
      if (phrase.length < 3 || !haystack.includes(` ${phrase} `)) continue;
      byPhrase.set(phrase, (byPhrase.get(phrase) ?? new Set()).add(study.id));
      studyById.set(study.id, study);
    }
  }
  // Una frase contenida en otra frase que también coincidió ("glucosa" dentro de "glucosa postprandial") es menos específica: se descarta.
  const phrases = [...byPhrase.keys()];
  const specific = phrases.filter((phrase) => !phrases.some((other) => other !== phrase && other.length > phrase.length && ` ${other} `.includes(` ${phrase} `)));
  const ids = new Set<string>();
  const ambiguous: string[] = [];
  for (const phrase of specific) {
    const owners = byPhrase.get(phrase)!;
    if (owners.size > 1) ambiguous.push(phrase);
    else ids.add([...owners][0]!);
  }
  return { studies: [...ids].map((id) => studyById.get(id)!), ambiguous };
}

// ───────────────────────────── textos fijos (BORRADORES pendientes de aprobación del laboratorio) ─────────────────────────────
// Solo títulos y conectores: ningún dato. El constructor del manejador rechaza cifras, moneda o promesas en estos textos (ver assertSafeAnswerTexts).
export interface AnswerTexts {
  hoursTitle: string; // {service}
  noOtherHours: string;
  noOtherBranches: string;
  noOtherMethods: string;
  paymentTitle: string;
  accepted: string;
  notAccepted: string;
  unavailableTopics: string; // {topics}
  askStudy: string;
  noPreparation: string;
  prepMissing: string; // {study}
  prepNotCombined: string;
  prepAmbiguous: string;
  noScheduleOtherDays: string;
  nowOpen: string;
  nowClosed: string;
  todayClosed: string;
  today: string;
  // G4.1 (datos aprobados por estudio)
  studyAmbiguous: string;
  askStudyInfo: string;
  turnaroundLabel: string;
  turnaroundMissing: string; // {study}
  upTo: string; // {max} {unit}
  between: string; // {min} {max} {unit}
  hoursUnit: string;
  daysUnit: string;
  businessDays: string;
  calendarDays: string;
  fromCollection: string;
  fromReceipt: string;
  sampleLabel: string;
  requirementsLabel: string;
  noSpecialRequirements: string;
  sampleMissing: string; // {study}
  contextIntro: string;
  hourUnit: string;
  dayUnit: string;
  businessDayOne: string;
}
export const ANSWER_TEXTS: AnswerTexts = {
  hoursTitle: "{service}",
  noOtherHours: "De otras sucursales no tengo ese horario disponible por ahora.",
  noOtherBranches: "De otras sucursales no tengo datos disponibles por ahora.",
  noOtherMethods: "Puede haber otros métodos de pago de los que no tengo información disponible por ahora.",
  paymentTitle: "Métodos de pago",
  accepted: "Aceptamos",
  notAccepted: "No aceptamos",
  unavailableTopics: "Sobre {topics} no tengo información disponible por ahora.",
  askStudy: "Para indicarte la preparación necesito el nombre del estudio. ¿Cuál es? También puedes enviarme una foto de tu receta.",
  noPreparation: "el laboratorio indica que no requiere preparación.",
  prepMissing: "No tengo la preparación de {study} disponible por ahora.",
  prepNotCombined: "Estas indicaciones son por cada estudio; no puedo indicarte cómo combinarlas.",
  prepAmbiguous: "No pude identificar con certeza uno de los estudios que mencionas, por lo que no te indico su preparación.",
  noScheduleOtherDays: "No hay horario registrado para los demás días.",
  nowOpen: "En este momento: abierto.",
  nowClosed: "En este momento: cerrado.",
  todayClosed: "Hoy ({date}): cerrado",
  today: "Hoy ({date}): {hours}",
  studyAmbiguous: "No pude identificar con certeza uno de los estudios que mencionas, por lo que no te indico sus datos.",
  askStudyInfo: "Para indicártelo necesito el nombre del estudio. ¿Cuál es? También puedes pedírmelo después de cotizar tu receta.",
  turnaroundLabel: "Tiempo de entrega",
  turnaroundMissing: "No tengo el tiempo de entrega de {study} disponible por ahora.",
  upTo: "hasta {max} {unit}",
  between: "entre {min} y {max} {unit}",
  hoursUnit: "horas",
  daysUnit: "días",
  businessDays: "hábiles",
  calendarDays: "calendario",
  fromCollection: "contado desde la toma de la muestra",
  fromReceipt: "contado desde la recepción de la muestra en el laboratorio",
  sampleLabel: "Tipo de muestra",
  requirementsLabel: "Requisitos",
  noSpecialRequirements: "el laboratorio indica que no tiene requisitos especiales.",
  sampleMissing: "No tengo el tipo de muestra ni los requisitos de {study} disponibles por ahora.",
  contextIntro: "Sobre los estudios de tu última cotización:",
  hourUnit: "hora",
  dayUnit: "día",
  businessDayOne: "hábil"
};

// Estas plantillas no pueden llevar cifras ni promesas (los datos vienen de los registros aprobados).
const ANSWER_FORBIDDEN = /\d|\$|\b(bs|bob|usd|gratis|gratuito|descuento|promocion|inmediato)\b/i;
export class UnsafeAnswerTextError extends Error {
  constructor(readonly key: string) {
    super(`texto de respuesta no permitido: ${key}`);
    this.name = "UnsafeAnswerTextError";
  }
}
export function assertSafeAnswerTexts(texts: AnswerTexts): void {
  for (const key of Object.keys(ANSWER_TEXTS) as Array<keyof AnswerTexts>) {
    // las plantillas con marcadores {date}/{hours}/{study}/{topics}/{service} se validan sin ellos; ningún marcador desconocido
    const stripped = (texts[key] ?? "").replace(/\{(date|hours|study|topics|service|min|max|unit)\}/g, "");
    if (typeof texts[key] !== "string" || texts[key].trim() === "" || texts[key].length > 400 || ANSWER_FORBIDDEN.test(stripped) || /[{}]/.test(stripped)) throw new UnsafeAnswerTextError(key);
  }
}

const SERVICE_LABEL: Record<ScheduleService, string> = {
  OFFICE: "Horario de atención", SAMPLE_COLLECTION: "Horario de toma de muestras", RESULTS_PICKUP: "Horario de entrega de resultados", HOME_SAMPLING: "Horario de toma a domicilio", HUMAN_SUPPORT: "Horario de atención humana"
};
const DAY_NAME = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const TOPIC_LABEL: Record<Topic["kind"], string> = { HOURS: "los horarios", LOCATION: "la ubicación", PAYMENT: "los métodos de pago", POLICY: "ese tema", PREPARATION: "la preparación de estudios", TURNAROUND: "el tiempo de entrega", SAMPLE: "el tipo de muestra y los requisitos" };
const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_match, name: string) => values[name] ?? "");

// ───────────────────────────── respuesta ─────────────────────────────
export interface KnowledgeRef {
  // Conocimiento de G3 o dato por estudio de G4.1 (en ese caso `key` es el id del estudio en lab_tests).
  kind: Provenance["kind"] | StudyFactKind;
  key: string;
  version: number;
  contentHash: string;
}
export interface KnowledgeAnswer {
  body: string;
  // Registros aprobados que respaldan la respuesta (se guardan ANTES de enviar). Vacío si la respuesta es solo una aclaración sin datos.
  refs: KnowledgeRef[];
  status: "ANSWERED" | "PARTIAL" | "CLARIFY";
  topics: Array<Topic["kind"]>;
  // Temas consultados que no tenían datos (razones codificadas).
  unavailable: Array<{ topic: Topic["kind"]; reason: UnavailableReason }>;
}

export interface AnswerOptions {
  service: KnowledgeQueries;
  // Catálogo activo (solo para identificar estudios por nombre/alias). Solo se llama si el mensaje pregunta por preparación.
  loadCatalog?: () => Promise<CatalogStudy[]>;
  now?: () => Date;
  texts?: AnswerTexts;
  // G4.1 (apagado si falta): datos aprobados por estudio (plazo de entrega, tipo de muestra y requisitos). Sin esto el comportamiento es exactamente el de G3.1A.
  studyFacts?: StudyFactsQueries;
  // G4.1: ids de los estudios de la última cotización entregada a este contacto (si la hay y es reciente). Solo se pide cuando el mensaje pregunta por un estudio sin nombrarlo.
  contextStudyIds?: () => Promise<readonly string[]>;
  // Métodos de pago en silencio (ausente = se responden como siempre): la respuesta no incluye nada sobre cómo pagar, ni siquiera «no hay información». Un mensaje solo de pagos se queda sin tema (sin respuesta).
  skipPayment?: boolean;
}

interface Section {
  topic: Topic["kind"];
  lines: string[];
  provenance: Provenance[];
  // Datos por estudio de G4.1 que respaldan la sección.
  factProvenance?: FactProvenance[];
  // false = no hay datos: la sección no aporta respuesta
  answered: boolean;
  // true = es solo una pregunta de aclaración (sin datos)
  clarify?: boolean;
  reason?: UnavailableReason;
}

const unavailableSection = (topic: Topic["kind"], reason: UnavailableReason): Section => ({ topic, lines: [], provenance: [], answered: false, reason });
const refOf = (p: Provenance): KnowledgeRef => ({ kind: p.kind, key: p.key, version: p.version, contentHash: p.contentHash });
const failed = <T>(result: KnowledgeResult<T>): result is Extract<KnowledgeResult<T>, { status: "UNAVAILABLE" }> => result.status === "UNAVAILABLE";

function weeklyLines(weekly: Array<{ day: number; opens: string; closes: string }>): string[] {
  const byDay = new Map<number, Array<{ opens: string; closes: string }>>();
  for (const entry of weekly) byDay.set(entry.day, [...(byDay.get(entry.day) ?? []), { opens: entry.opens, closes: entry.closes }]);
  // Lunes a domingo
  return [1, 2, 3, 4, 5, 6, 0].filter((day) => byDay.has(day)).map((day) => `${DAY_NAME[day]}: ${byDay.get(day)!.sort((a, b) => a.opens.localeCompare(b.opens)).map((i) => `${i.opens} a ${i.closes}`).join(" y ")}`);
}

export async function answerFromKnowledge(text: string, options: AnswerOptions): Promise<KnowledgeAnswer | undefined> {
  const texts = options.texts ?? ANSWER_TEXTS;
  const now = options.now ?? (() => new Date());
  const topics = detectTopics(text, Boolean(options.studyFacts)).filter((topic) => !(options.skipPayment && topic.kind === "PAYMENT"));
  const asksNow = NOW.test(plain(text.slice(0, 4000)));
  const sections: Section[] = [];
  // El estudio por el que se pregunta se resuelve una sola vez (y solo si algún tema lo necesita).
  let scopePromise: Promise<Scope> | undefined;
  const scope = () => (scopePromise ??= resolveScope(text, options));
  // Si la pregunta es por un estudio concreto, la política GENERAL de entrega no se mezcla: se responde el dato de ese estudio (o que no está disponible).
  let activeTopics = topics;
  if (topics.some((topic) => topic.kind === "TURNAROUND")) {
    const resolved = await scope();
    if (resolved.status === "STUDIES" || resolved.status === "AMBIGUOUS") activeTopics = topics.filter((topic) => !(topic.kind === "POLICY" && topic.topic === "RESULTS_DELIVERY"));
  }

  for (const topic of activeTopics) {
    switch (topic.kind) {
      case "HOURS": {
        const branches = await options.service.getBranches();
        if (failed(branches)) { sections.push(unavailableSection("HOURS", branches.reason)); break; }
        const lines: string[] = [];
        const provenance: Provenance[] = [];
        let missing = branches.omitted.length > 0;
        for (const branch of branches.data) {
          const schedule = await options.service.getSchedule({ branchKey: branch.key, service: topic.service });
          if (failed(schedule)) { missing = true; continue; }
          provenance.push(...schedule.provenance);
          if (lines.length > 0) lines.push("");
          lines.push(`*${branch.name}* — ${fill(texts.hoursTitle, { service: SERVICE_LABEL[topic.service] })}`, ...weeklyLines(schedule.data.weekly), texts.noScheduleOtherDays);
          const status = scheduleStatusAt(schedule.data, now());
          if (status) {
            if (status.source === "EXCEPTION") lines.push(status.intervals.length === 0 ? fill(texts.todayClosed, { date: status.localDate }) + (status.exceptionNote ? ` — ${status.exceptionNote}` : "") : fill(texts.today, { date: status.localDate, hours: status.intervals.map((i) => `${i.opens} a ${i.closes}`).join(" y ") }));
            if (asksNow) lines.push(status.open ? texts.nowOpen : texts.nowClosed);
          }
        }
        if (provenance.length === 0) { sections.push(unavailableSection("HOURS", "NO_APPROVED_VERSION")); break; }
        if (missing) lines.push("", texts.noOtherHours);
        sections.push({ topic: "HOURS", lines, provenance: dedupe(provenance), answered: true });
        break;
      }
      case "LOCATION": {
        const branches = await options.service.getBranches();
        if (failed(branches)) { sections.push(unavailableSection("LOCATION", branches.reason)); break; }
        const lines: string[] = [];
        for (const branch of branches.data) {
          if (lines.length > 0) lines.push("");
          lines.push(`*${branch.name}*`, branch.address, ...optional(branch, "mapsUrl"), ...(branch.phone ? [`Teléfono: ${branch.phone}`] : []), ...(branch.notes ? [branch.notes] : []));
        }
        if (branches.omitted.length > 0) lines.push("", texts.noOtherBranches);
        sections.push({ topic: "LOCATION", lines, provenance: branches.provenance, answered: true });
        break;
      }
      case "PAYMENT": {
        const methods = await options.service.getPaymentMethods();
        if (failed(methods)) { sections.push(unavailableSection("PAYMENT", methods.reason)); break; }
        const accepted = methods.data.filter((m) => m.accepted).map((m) => m.label);
        const refused = methods.data.filter((m) => !m.accepted).map((m) => m.label);
        const lines = [`*${texts.paymentTitle}*`, ...(accepted.length > 0 ? [`${texts.accepted}: ${accepted.join(", ")}`] : []), ...(refused.length > 0 ? [`${texts.notAccepted}: ${refused.join(", ")}`] : [])];
        if (methods.omitted.length > 0) lines.push(texts.noOtherMethods);
        sections.push({ topic: "PAYMENT", lines, provenance: methods.provenance, answered: true });
        break;
      }
      case "POLICY": {
        const policy = await options.service.getPolicy(topic.topic);
        if (failed(policy)) { sections.push(unavailableSection("POLICY", policy.reason)); break; }
        sections.push({ topic: "POLICY", lines: [`*${policy.data.title}*`, policy.data.body], provenance: policy.provenance, answered: true });
        break;
      }
      case "PREPARATION": {
        sections.push(await preparationSection(text, options, texts));
        break;
      }
      case "TURNAROUND":
      case "SAMPLE": {
        sections.push(...(await factSections(topic.kind, await scope(), topics, options, texts)));
        break;
      }
    }
  }

  // Sin tema reconocido: se intenta una pregunta frecuente por etiqueta EXACTA (una palabra del mensaje que sea etiqueta de una FAQ aprobada).
  if (topics.length === 0) {
    const tokens = [...new Set(words(plain(text.slice(0, 2000))).filter((token) => token.length >= 4))].slice(0, 20);
    const found = new Map<string, { question: string; answer: string; provenance: Provenance[] }>();
    for (const token of tokens) {
      const result = await options.service.findFaqByTag(token);
      if (failed(result)) continue;
      result.data.forEach((faq, index) => found.set(faq.key, { question: faq.question, answer: faq.answer, provenance: [result.provenance[index]!] }));
    }
    if (found.size !== 1) return undefined; // ninguna, o más de una (ambiguo): no se responde por conocimiento
    const faq = [...found.values()][0]!;
    return { body: `*${faq.question}*\n${faq.answer}`, refs: faq.provenance.map(refOf), status: "ANSWERED", topics: [], unavailable: [] };
  }

  const answered = sections.filter((section) => section.answered);
  const clarifications = sections.filter((section) => section.clarify);
  const unavailable = sections.filter((section) => !section.answered && !section.clarify).map((section) => ({ topic: section.topic, reason: section.reason ?? ("NO_APPROVED_VERSION" as UnavailableReason) }));
  if (answered.length === 0 && clarifications.length === 0) return undefined;

  const blocks = sections.filter((section) => section.answered || section.clarify).map((section) => section.lines.join("\n"));
  if (unavailable.length > 0) blocks.push(fill(texts.unavailableTopics, { topics: [...new Set(unavailable.map((item) => TOPIC_LABEL[item.topic]))].join(" ni sobre ") }));
  const body = blocks.join("\n\n");
  if (body.length > 3800) return undefined; // demasiado largo para un mensaje: no se trunca ni se envía a medias
  const refs: KnowledgeRef[] = [
    ...dedupe(answered.flatMap((section) => section.provenance)).map(refOf),
    ...dedupeFacts(answered.flatMap((section) => section.factProvenance ?? [])).map((fact) => ({ kind: fact.kind, key: fact.labTestId, version: fact.version, contentHash: fact.contentHash }))
  ];
  return { body, refs, status: unavailable.length > 0 || sections.some((s) => s.answered && s.lines.some((line) => line === texts.prepAmbiguous)) ? "PARTIAL" : refs.length === 0 ? "CLARIFY" : "ANSWERED", topics: topics.map((topic) => topic.kind), unavailable };
}

const optional = (branch: BranchPayload, key: "mapsUrl"): string[] => (branch[key] ? [branch[key]!] : []);
function dedupe(items: Provenance[]): Provenance[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(`${item.kind}|${item.key}|${item.version}`) ? false : (seen.add(`${item.kind}|${item.key}|${item.version}`), true)));
}

async function preparationSection(text: string, options: AnswerOptions, texts: AnswerTexts): Promise<Section> {
  if (!options.loadCatalog) return unavailableSection("PREPARATION", "CATALOG_UNAVAILABLE");
  let catalog: CatalogStudy[];
  try {
    catalog = await options.loadCatalog();
  } catch {
    return unavailableSection("PREPARATION", "CATALOG_UNAVAILABLE");
  }
  if (catalog.length === 0) return unavailableSection("PREPARATION", "CATALOG_UNAVAILABLE");
  const mentions = await studiesFor(text, options, catalog);
  // Sin un estudio identificado con certeza (no mencionado, desconocido, inactivo o ambiguo) no se adivina: se pregunta cuál es.
  if (mentions.studies.length === 0) return { topic: "PREPARATION", lines: [texts.askStudy], provenance: [], answered: false, clarify: true };
  if (mentions.studies.length > MAX_STUDIES) return unavailableSection("PREPARATION", "AMBIGUOUS");

  const result = await options.service.getStudyPreparation(mentions.studies.map((study) => study.id), catalog);
  const lines: string[] = [];
  const provenance: Provenance[] = [];
  for (const item of result.items) {
    if (lines.length > 0) lines.push("");
    const name = item.studyName ?? mentions.studies.find((study) => study.id === item.studyId)?.name ?? "";
    if (failed(item.result)) { lines.push(fill(texts.prepMissing, { study: name })); continue; }
    provenance.push(...item.result.provenance);
    const prep = item.result.data;
    if (prep.prepState === "NO_PREPARATION_REQUIRED") { lines.push(`*${prep.studyName}*: ${texts.noPreparation}`); continue; }
    lines.push(`*${prep.studyName}*`);
    if (prep.fastingHours !== undefined) lines.push(`Ayuno: ${prep.fastingHours} ${prep.fastingHours === 1 ? "hora" : "horas"}`);
    if (prep.collectionWindow) lines.push(`Ventana de toma: ${prep.collectionWindow}`);
    if (prep.instructions) lines.push(`Indicaciones: ${prep.instructions}`);
  }
  if (provenance.length === 0) return unavailableSection("PREPARATION", result.items[0] && failed(result.items[0].result) ? result.items[0].result.reason : "NO_APPROVED_VERSION");
  if (result.items.length > 1) lines.push("", texts.prepNotCombined);
  if (mentions.ambiguous.length > 0) lines.push("", texts.prepAmbiguous);
  return { topic: "PREPARATION", lines, provenance: dedupe(provenance), answered: true };
}

// ───────────────────────────── estudio por el que se pregunta (G4.1) ─────────────────────────────
// Un estudio se identifica SOLO por coincidencia exacta con su nombre o un alias aprobado. Si el mensaje no nombra ninguno (ni ambiguo) y se entregó el contexto, se usan los estudios de la
// ÚLTIMA cotización entregada al contacto. Nunca se adivina: sin una u otra, se pide el nombre del estudio.
async function studiesFor(text: string, options: AnswerOptions, catalog: CatalogStudy[]): Promise<StudyMentions & { fromContext: boolean }> {
  const mentions = findStudyMentions(text, catalog);
  if (mentions.studies.length > 0 || mentions.ambiguous.length > 0 || !options.contextStudyIds) return { ...mentions, fromContext: false };
  let ids: readonly string[] = [];
  try {
    ids = await options.contextStudyIds();
  } catch {
    ids = [];
  }
  const byId = new Map(catalog.map((study) => [study.id, study]));
  const studies = [...new Set(ids)].map((id) => byId.get(id)).filter((study): study is CatalogStudy => study !== undefined);
  return { studies, ambiguous: [], fromContext: studies.length > 0 };
}

type Scope =
  | { status: "STUDIES"; studies: CatalogStudy[]; catalog: CatalogStudy[]; ambiguous: string[]; fromContext: boolean }
  | { status: "NONE" }
  | { status: "AMBIGUOUS" }
  | { status: "UNAVAILABLE"; reason: UnavailableReason };

async function resolveScope(text: string, options: AnswerOptions): Promise<Scope> {
  if (!options.loadCatalog) return { status: "UNAVAILABLE", reason: "CATALOG_UNAVAILABLE" };
  let catalog: CatalogStudy[];
  try {
    catalog = await options.loadCatalog();
  } catch {
    return { status: "UNAVAILABLE", reason: "CATALOG_UNAVAILABLE" };
  }
  if (catalog.length === 0) return { status: "UNAVAILABLE", reason: "CATALOG_UNAVAILABLE" };
  const found = await studiesFor(text, options, catalog);
  if (found.studies.length === 0) return found.ambiguous.length > 0 ? { status: "AMBIGUOUS" } : { status: "NONE" };
  return { status: "STUDIES", studies: found.studies, catalog, ambiguous: found.ambiguous, fromContext: found.fromContext };
}

function dedupeFacts(items: FactProvenance[]): FactProvenance[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.kind + "|" + item.labTestId + "|" + item.version) ? false : (seen.add(item.kind + "|" + item.labTestId + "|" + item.version), true)));
}

// Plazo de entrega en la unidad APROBADA para ese estudio (horas o días; hábiles o calendario; desde la toma o la recepción). No se convierte entre unidades ni se supone nada: el máximo
// sin mínimo se dice «hasta N» (literalmente lo aprobado) y un rango, «entre A y B».
export function turnaroundLines(view: TurnaroundView, texts: AnswerTexts): string[] {
  const single = view.max === 1 && view.min === undefined;
  const word = view.unit === "HOURS" ? (single ? texts.hourUnit : texts.hoursUnit) : single ? texts.dayUnit : texts.daysUnit;
  const dayType = view.unit === "DAYS" ? " " + (view.dayType === "BUSINESS" ? (single ? texts.businessDayOne : texts.businessDays) : texts.calendarDays) : "";
  const unit = word + dayType;
  const amount = view.min !== undefined ? fill(texts.between, { min: String(view.min), max: String(view.max), unit }) : fill(texts.upTo, { max: String(view.max), unit });
  return [texts.turnaroundLabel + ": " + amount + " (" + (view.countedFrom === "SAMPLE_COLLECTION" ? texts.fromCollection : texts.fromReceipt) + ")", ...(view.note ? [view.note] : [])];
}

export function sampleLines(view: SampleView, texts: AnswerTexts): string[] {
  const lines = [texts.sampleLabel + ": " + view.sampleType];
  if (view.requirementsState === "NO_SPECIAL_REQUIREMENTS") lines.push(texts.requirementsLabel + ": " + texts.noSpecialRequirements);
  else lines.push(texts.requirementsLabel + ":", ...(view.requirements ?? []).map((item) => "- " + item));
  return lines;
}

async function factSections(kind: "TURNAROUND" | "SAMPLE", scope: Scope, topics: Topic[], options: AnswerOptions, texts: AnswerTexts): Promise<Section[]> {
  const clarify = (line: string): Section[] => [{ topic: kind, lines: [line], provenance: [], answered: false, clarify: true }];
  if (!options.studyFacts) return [];
  if (scope.status === "UNAVAILABLE") return [unavailableSection(kind, scope.reason)];
  if (scope.status === "NONE") {
    // La pregunta general («¿cuándo entregan los resultados?») la responde la política de G3; sin ella, se pide el estudio.
    if (kind === "TURNAROUND" && topics.some((topic) => topic.kind === "POLICY" && topic.topic === "RESULTS_DELIVERY")) return [];
    return clarify(texts.askStudyInfo);
  }
  if (scope.status === "AMBIGUOUS") return clarify(texts.studyAmbiguous);
  if (scope.studies.length > MAX_STUDIES) return clarify(texts.askStudyInfo);

  const ids = scope.studies.map((study) => study.id);
  const nameOf = new Map(scope.studies.map((study) => [study.id, study.name]));
  const blocks: string[][] = [];
  const facts: FactProvenance[] = [];
  const handle = <T>(result: FactResult<T>, studyId: string, studyName: string | undefined, missing: string, render: (data: T, name: string) => string[]) => {
    const name = studyName ?? nameOf.get(studyId) ?? "";
    if (result.status === "UNAVAILABLE") { blocks.push([fill(missing, { study: name })]); return; }
    facts.push(result.provenance);
    blocks.push(["*" + name + "*", ...render(result.data, name)]);
  };
  if (kind === "TURNAROUND") {
    for (const item of (await options.studyFacts.getTurnaround(ids, scope.catalog)).items) handle(item.result, item.studyId, item.studyName, texts.turnaroundMissing, (data) => turnaroundLines(data, texts));
  } else {
    for (const item of (await options.studyFacts.getSample(ids, scope.catalog)).items) handle(item.result, item.studyId, item.studyName, texts.sampleMissing, (data) => sampleLines(data, texts));
  }
  const lines = [...(scope.fromContext ? [texts.contextIntro] : []), ...blocks.flatMap((block, index) => (index > 0 ? ["", ...block] : block)), ...(scope.ambiguous.length > 0 ? ["", texts.studyAmbiguous] : [])];
  // Sin ningún dato aprobado solo hay avisos de «no disponible»: no hay nada que respaldar ni rastrear.
  if (facts.length === 0) return [{ topic: kind, lines, provenance: [], answered: false, clarify: true }];
  return [{ topic: kind, lines, provenance: [], factProvenance: dedupeFacts(facts), answered: true }];
}

// ───────────────────────────── utilidades ─────────────────────────────
// Caché con vida corta y una sola carga a la vez (p. ej. el catálogo activo: se pide solo cuando alguien pregunta por preparación).
export function ttlCache<T>(load: () => Promise<T>, ttlMs: number, now: () => number = Date.now): () => Promise<T> {
  let value: { at: number; data: T } | undefined;
  let inflight: Promise<T> | undefined;
  return async () => {
    if (value && now() - value.at < ttlMs) return value.data;
    inflight ??= load().then((data) => { value = { at: now(), data }; return data; }).finally(() => { inflight = undefined; });
    return inflight;
  };
}

// Construye el servicio solo la primera vez que se usa (así importar el módulo no exige configuración si la función está apagada).
export function lazyKnowledge(factory: () => KnowledgeQueries): KnowledgeQueries {
  let instance: KnowledgeQueries | undefined;
  const get = () => (instance ??= factory());
  return {
    getBranches: () => get().getBranches(),
    getSchedule: (query) => get().getSchedule(query),
    getPolicy: (topic) => get().getPolicy(topic),
    getPaymentMethods: () => get().getPaymentMethods(),
    findFaqByTag: (tag) => get().findFaqByTag(tag),
    getStudyPreparation: (ids, catalog) => get().getStudyPreparation(ids, catalog)
  };
}
