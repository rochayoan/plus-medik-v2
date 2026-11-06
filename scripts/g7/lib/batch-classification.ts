// G7 · Fase 0 — Clasificación de cada lote del paciente en: atención humana correcta · silencio correcto · respondido · respuesta insuficiente · error técnico · falta real de respuesta.
// Principio: un silencio del agente NO es un fallo por sí mismo. Solo cuenta como falta real si nadie atendió al paciente y no hay una razón legítima (pausa atendida, social, fusión, sin contenido accionable).
// Determinista y local. Cruza el corpus seudonimizado con telemetría de producción SIN identificadores (solo horas y códigos). No lee ni imprime el contenido de los mensajes.

import { socialOf } from "../../../src/attention-filter.js";
import { classifyText } from "../../../src/text-handler.js";
import { z } from "zod";
import { replyKind } from "./analysis.js";
import type { FixtureConversation, FixtureMessage } from "./schema.js";

export const TelemetryKind = z.enum(["PHOTO_FAILED", "LLM_429", "INTERPRETER_ERROR", "GUARD_REJECTED", "WITHHELD_LIMITED", "WITHHELD_BLOCKED", "WITHHELD_AUDIT_CLAIM_REJECTED", "WITHHELD_SUPERSEDED", "AUDIT_EVIDENCE_REJECTED", "SEND_UNCERTAIN", "ANALYSIS"]);
export const Telemetry = z.object({ events: z.array(z.object({ t: z.string(), kind: TelemetryKind, detail: z.string().optional() })) });
export type Telemetry = z.infer<typeof Telemetry>;

export type Family = "ATENCION_HUMANA_CORRECTA" | "SILENCIO_CORRECTO" | "RESPONDIDO" | "RESPUESTA_INSUFICIENTE" | "ERROR_TECNICO" | "FALTA_REAL_DE_RESPUESTA";
export type Owner = "AGENTE" | "RECEPCION_PROCESO" | "PROVEEDOR_IA" | "BASE_AUDITORIA" | "DISENO_PROTECCION" | "NINGUNO";
export interface BatchLabel { conversation: string; batch: string; family: Family; detail: string; owner: Owner; evidence: "TELEMETRIA" | "CORPUS" | "INFERIDA"; tags: string[] }

const sec = (iso: string) => Date.parse(iso) / 1000;
const UNSUPPORTED = new Set(["document", "location", "contacts", "unsupported"]);
const NO_ACTION = new Set(["reaction", "sticker"]);
const LATE_HUMAN_SECONDS = 30 * 60;
const WINDOW_SECONDS = 7200;

interface Facts { conversation: FixtureConversation; index: number; start: number; end: number; types: string[]; texts: string[]; socialOnly: boolean; noAction: boolean; unsupportedOnly: boolean; opener: string; paused: boolean; agentBefore24h: number; agentReply?: FixtureMessage; humanReply?: FixtureMessage; humanLater?: FixtureMessage; humanMuchLater?: FixtureMessage; mergedSoon: boolean; concrete: boolean; hasImage: boolean; hasAudio: boolean }

export function classifyBatches(conversations: readonly FixtureConversation[], telemetry: Telemetry): { labels: BatchLabel[]; summary: Summary } {
  const events = telemetry.events.map((event) => ({ ...event, ts: sec(event.t), used: false }));
  const facts: Facts[] = [];

  for (const conversation of conversations) {
    const items = conversation.batches.flatMap((batch) => batch.messages).sort((a, b) => sec(a.at) - sec(b.at));
    const agents = items.filter((item) => item.actor === "AGENT");
    const humans = items.filter((item) => item.actor === "HUMAN");
    const opener = items[0]?.actor ?? "NADIE";
    for (const [index, batch] of conversation.batches.entries()) {
      const first = batch.messages[0]!;
      if (first.actor !== "PATIENT") continue;
      const start = sec(first.at);
      const end = sec(batch.messages[batch.messages.length - 1]!.at);
      const types = batch.messages.map((m) => m.messageType ?? m.kind.toLowerCase());
      const texts = batch.messages.map((m) => m.text).filter((t): t is string => Boolean(t));
      const next = conversation.batches.slice(index + 1);
      const cut = next.findIndex((c) => c.messages[0]!.actor === "PATIENT" && sec(c.messages[0]!.at) > end);
      const window = (cut < 0 ? next : next.slice(0, cut)).filter((c) => sec(c.messages[0]!.at) - end <= WINDOW_SECONDS);
      const agentReply = window.find((c) => c.messages[0]!.actor === "AGENT")?.messages[0];
      const humanReply = window.find((c) => c.messages[0]!.actor === "HUMAN")?.messages[0];
      // Respuesta humana posterior que cubre varios mensajes del paciente (no se corta en el siguiente lote) o llega mucho después.
      const humanLater = humans.find((h) => sec(h.at) > end && sec(h.at) - end <= WINDOW_SECONDS);
      const humanMuchLater = humans.find((h) => sec(h.at) > end && sec(h.at) - end > WINDOW_SECONDS);
      const lastHuman = [...humans].reverse().find((h) => sec(h.at) < start);
      const paused = Boolean(lastHuman) && !agents.some((a) => sec(a.at) > sec(lastHuman!.at) && sec(a.at) < start);
      const nextAgent = agents.find((a) => sec(a.at) > end);
      const mergedSoon = Boolean(nextAgent) && sec(nextAgent!.at) - end <= 90 && !humans.some((h) => sec(h.at) > end && sec(h.at) < sec(nextAgent!.at));
      const joined = texts.join(" ");
      const category = joined ? classifyText(joined) : "SIN_TEXTO";
      facts.push({
        conversation, index, start, end, types, texts,
        socialOnly: texts.length > 0 && texts.every((t) => socialOf(t) !== undefined) && types.every((t) => t === "text"),
        noAction: types.every((t) => NO_ACTION.has(t)),
        unsupportedOnly: types.every((t) => UNSUPPORTED.has(t) || NO_ACTION.has(t)) && types.some((t) => UNSUPPORTED.has(t)),
        opener, paused, agentBefore24h: agents.filter((a) => sec(a.at) < start && start - sec(a.at) <= 86400).length,
        ...(agentReply ? { agentReply } : {}), ...(humanReply ? { humanReply } : {}), ...(humanLater ? { humanLater } : {}), ...(humanMuchLater ? { humanMuchLater } : {}), mergedSoon,
        concrete: joined.includes("?") || ["INFO_REQUEST", "RECIPE_OR_QUOTE", "MEDICAL", "HUMAN_REQUEST"].includes(category) || types.some((t) => t === "image" || t === "audio" || t === "document"),
        hasImage: types.includes("image"), hasAudio: types.includes("audio")
      });
    }
  }

  // Eventos sin respuesta (retenciones): se asignan al lote sin respuesta más cercano que terminó antes del evento (≤ 150 s), uno por evento.
  const WITHHELD = new Set(["WITHHELD_LIMITED", "WITHHELD_BLOCKED", "WITHHELD_AUDIT_CLAIM_REJECTED", "WITHHELD_SUPERSEDED"]);
  const withheldFor = new Map<Facts, string>();
  for (const event of events.filter((e) => WITHHELD.has(e.kind)).sort((a, b) => a.ts - b.ts)) {
    const candidate = facts.filter((f) => !f.agentReply && !withheldFor.has(f) && f.end <= event.ts + 2 && event.ts - f.end <= 150).sort((a, b) => b.end - a.end)[0];
    if (candidate) { withheldFor.set(candidate, event.kind); event.used = true; }
  }
  // Análisis de fotos: el más cercano posterior (≤ 240 s) a un lote con imagen.
  const analysisFor = new Map<Facts, string>();
  for (const f of facts.filter((x) => x.hasImage).sort((a, b) => a.end - b.end)) {
    const event = events.filter((e) => e.kind === "ANALYSIS" && !e.used && e.ts >= f.end - 2 && e.ts - f.end <= 240).sort((a, b) => a.ts - b.ts)[0];
    if (event) { event.used = true; analysisFor.set(f, event.detail ?? "?"); }
  }
  // Un evento de error técnico explica una respuesta del agente si ocurrió justo antes de que la enviara (≤ 12 s).
  const techBefore = (reply: FixtureMessage | undefined, kinds: string[]) => (reply ? events.find((e) => kinds.includes(e.kind) && sec(reply.at) - e.ts >= -2 && sec(reply.at) - e.ts <= 12) : undefined);

  const labels: BatchLabel[] = [];
  const push = (f: Facts, family: Family, detail: string, owner: Owner, evidence: BatchLabel["evidence"], tags: string[] = []) => {
    const first = f.conversation.batches[f.index]!;
    labels.push({ conversation: f.conversation.id, batch: first.id, family, detail, owner, evidence, tags: [...tags, ...[...new Set(f.types)].filter((type) => type !== "text").map((type) => `MEDIO:${type}`)] });
  };

  for (const f of facts) {
    const tags: string[] = [];
    if (f.opener === "HUMAN") tags.push("CONVERSACION_ABIERTA_POR_RECEPCION");
    const reply = f.agentReply;
    const kind = reply ? replyKind(reply.text) : undefined;

    // 1) Ya respondió el agente
    if (reply) {
      const tech = techBefore(reply, ["PHOTO_FAILED", "LLM_429", "INTERPRETER_ERROR", "SEND_UNCERTAIN"]);
      if (tech?.kind === "PHOTO_FAILED") { push(f, "ERROR_TECNICO", "FOTO_NO_PROCESADA_FALLO_IA", "PROVEEDOR_IA", "TELEMETRIA", tags); continue; }
      if (tech && (kind === "GENERIC_FIXED" || kind === "BLOCKED_HANDOFF" || tech.kind === "LLM_429")) { push(f, "ERROR_TECNICO", "RESPUESTA_FIJA_POR_429_O_ERROR_IA", "PROVEEDOR_IA", "TELEMETRIA", tags); continue; }
      const guard = techBefore(reply, ["GUARD_REJECTED"]);
      if (guard) { push(f, "RESPUESTA_INSUFICIENTE", `FILTRO_DESCARTO_RESPUESTA_DEL_MODELO (${guard.detail})`, "DISENO_PROTECCION", "TELEMETRIA", tags); continue; }
      if (kind === "BLOCKED_HANDOFF") { push(f, "RESPUESTA_INSUFICIENTE", "NO_PUEDO_DERIVAR (derivacion al CRM desactivada)", "DISENO_PROTECCION", "CORPUS", tags); continue; }
      if (kind === "GENERIC_FIXED" && f.concrete) { push(f, "RESPUESTA_INSUFICIENTE", "TEXTO_GENERICO_ANTE_MENSAJE_CONCRETO", "AGENTE", "CORPUS", tags); continue; }
      if (kind === "GENERIC_FIXED") { push(f, "RESPONDIDO", "SALUDO_O_GENERICO_A_MENSAJE_NO_CONCRETO", "NINGUNO", "CORPUS", tags); continue; }
      if (kind === "QUOTE") { push(f, "RESPONDIDO", "COTIZACION_CON_PRECIOS", "NINGUNO", "CORPUS", tags); continue; }
      const outcome = analysisFor.get(f);
      if (f.hasImage && outcome && outcome !== "AUTO_COMPLETE") { push(f, "RESPUESTA_INSUFICIENTE", `RECETA_SIN_COTIZACION_COMPLETA (${outcome})`, "AGENTE", "TELEMETRIA", tags); continue; }
      if (f.hasImage && outcome === "AUTO_COMPLETE") { push(f, "RESPUESTA_INSUFICIENTE", "RECETA_COMPLETA_SIN_PRECIO_EN_LA_RESPUESTA", "AGENTE", "TELEMETRIA", tags); continue; }
      push(f, "RESPONDIDO", "TEXTO_LIBRE_CALIDAD_NO_EVALUADA", "NINGUNO", "CORPUS", tags);
      continue;
    }

    // 2) Sin respuesta del agente
    const withheld = withheldFor.get(f);
    if (withheld === "WITHHELD_AUDIT_CLAIM_REJECTED") { push(f, "ERROR_TECNICO", "AUDITORIA_RECHAZO_EL_CLAIM_MENSAJE_SIN_ATENDER", "BASE_AUDITORIA", "TELEMETRIA", tags); continue; }
    if (withheld === "WITHHELD_BLOCKED") { push(f, "ATENCION_HUMANA_CORRECTA", "PAUSA_HUMANA_APLICADA_AL_ENVIAR", "NINGUNO", "TELEMETRIA", tags); continue; }
    if (withheld === "WITHHELD_SUPERSEDED") { push(f, "SILENCIO_CORRECTO", "RESPUESTA_REEMPLAZADA_POR_UNA_MAS_NUEVA", "NINGUNO", "TELEMETRIA", tags); continue; }
    if (withheld === "WITHHELD_LIMITED") { push(f, "FALTA_REAL_DE_RESPUESTA", "TOPE_O_GUARDA_RETUVO_LA_RESPUESTA", "DISENO_PROTECCION", "TELEMETRIA", tags); continue; }

    if (f.socialOnly) { push(f, "SILENCIO_CORRECTO", "SOCIAL_SIN_ACCION", "NINGUNO", "CORPUS", tags); continue; }
    if (f.noAction) { push(f, "SILENCIO_CORRECTO", "REACCION_O_STICKER", "NINGUNO", "CORPUS", tags); continue; }
    if (f.paused || f.opener === "HUMAN") {
      if (f.humanReply) {
        if (sec(f.humanReply.at) - f.end > LATE_HUMAN_SECONDS) tags.push("HUMANO_TARDE_MAS_DE_30_MIN");
        push(f, "ATENCION_HUMANA_CORRECTA", f.paused ? "PAUSA_HUMANA_ATENDIDA_POR_PERSONA" : "CONVERSACION_DE_RECEPCION_ATENDIDA", "NINGUNO", "CORPUS", tags);
      } else if (f.humanLater) {
        push(f, "ATENCION_HUMANA_CORRECTA", "ATENDIDO_JUNTO_CON_UN_MENSAJE_POSTERIOR", "NINGUNO", "CORPUS", tags);
      } else if (f.humanMuchLater) {
        push(f, "FALTA_REAL_DE_RESPUESTA", "ATENDIDO_MAS_DE_2H_DESPUES", "RECEPCION_PROCESO", "CORPUS", [...tags, "HUMANO_TARDE_MAS_DE_30_MIN"]);
      } else push(f, "FALTA_REAL_DE_RESPUESTA", f.paused ? "PAUSA_HUMANA_SIN_ATENCION_DE_NADIE" : "CONVERSACION_DE_RECEPCION_SIN_ATENCION", "RECEPCION_PROCESO", "CORPUS", tags);
      continue;
    }
    if (f.mergedSoon) { push(f, "SILENCIO_CORRECTO", "FUSIONADO_CON_LA_RESPUESTA_SIGUIENTE", "NINGUNO", "CORPUS", tags); continue; }
    if (f.humanReply) { if (sec(f.humanReply.at) - f.end > LATE_HUMAN_SECONDS) tags.push("HUMANO_TARDE_MAS_DE_30_MIN"); push(f, "ATENCION_HUMANA_CORRECTA", "AGENTE_NO_RESPONDIO_Y_ATENDIO_UNA_PERSONA", "NINGUNO", "CORPUS", [...tags, "AGENTE_SILENCIOSO_SIN_CAUSA_CONOCIDA"]); continue; }
    if (f.agentBefore24h >= 5) { push(f, "FALTA_REAL_DE_RESPUESTA", "PROBABLE_TOPE_5_EN_24H (inferido)", "DISENO_PROTECCION", "INFERIDA", tags); continue; }
    if (f.unsupportedOnly) { push(f, "FALTA_REAL_DE_RESPUESTA", "TIPO_DE_MENSAJE_SIN_MANEJADOR (documento/ubicacion)", "AGENTE", "CORPUS", tags); continue; }
    if (f.hasAudio) { push(f, "FALTA_REAL_DE_RESPUESTA", "AUDIO_SIN_RESPUESTA", "AGENTE", "CORPUS", tags); continue; }
    if (f.hasImage) { push(f, "FALTA_REAL_DE_RESPUESTA", "FOTO_SIN_RESPUESTA_SIN_CAUSA_CONOCIDA", "AGENTE", "CORPUS", tags); continue; }
    push(f, "FALTA_REAL_DE_RESPUESTA", "SIN_RESPUESTA_SIN_CAUSA_IDENTIFICADA", "AGENTE", "INFERIDA", tags);
  }

  return { labels, summary: summarize(labels) };
}

export interface Summary { total: number; byFamily: Record<string, number>; byDetail: Record<string, number>; byOwner: Record<string, number>; byEvidence: Record<string, number>; tags: Record<string, number>; byMedium: Record<string, Record<string, number>>; agentSilenceNotAFailure: number; realGaps: number }

const count2 = (list: readonly BatchLabel[]) => { const out: Record<string, number> = {}; for (const l of list) { const key = `${l.family} :: ${l.detail}`; out[key] = (out[key] ?? 0) + 1; } return out; };

export function summarize(labels: readonly BatchLabel[]): Summary {
  const count = (pick: (label: BatchLabel) => string[]) => { const out: Record<string, number> = {}; for (const label of labels) for (const key of pick(label)) out[key] = (out[key] ?? 0) + 1; return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1])); };
  return {
    total: labels.length,
    byFamily: count((l) => [l.family]),
    byDetail: count((l) => [`${l.family} :: ${l.detail}`]),
    byOwner: count((l) => (l.family === "SILENCIO_CORRECTO" || l.family === "ATENCION_HUMANA_CORRECTA" || l.family === "RESPONDIDO" ? [] : [l.owner])),
    byEvidence: count((l) => [l.evidence]),
    tags: count((l) => l.tags),
    byMedium: Object.fromEntries(["image", "audio", "document", "location", "reaction"].map((medium) => [medium, count2(labels.filter((l) => l.tags.includes(`MEDIO:${medium}`)))])),
    agentSilenceNotAFailure: labels.filter((l) => l.family === "SILENCIO_CORRECTO" || l.family === "ATENCION_HUMANA_CORRECTA").length,
    realGaps: labels.filter((l) => l.family === "FALTA_REAL_DE_RESPUESTA" || l.family === "ERROR_TECNICO").length
  };
}
