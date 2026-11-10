import type { PhotoOutcome } from "./batch-policy.js";
import { previewPlan, previewUnderstanding, probeBatch, runBatchTurn, snapshotSession, type PreviewState } from "./batch-execution.js";
import { buildShadowReport } from "./batch-shadow.js";
import type { BatchFragment } from "./batch-understanding.js";
import { socialOf } from "./attention-filter.js";
import type { Produced, TurnContext } from "./guarded-turn.js";
import { QUOTE_TEXTS, type QuoteSessionsConfig, type QuoteTexts } from "./quote-session.js";
import type { IncomingTurn } from "./turns.js";
import { maskPhone, type QuoteDeps } from "./whatsapp-quote.js";

// PUENTE ENTRE LOS TURNOS Y EL MOTOR DE LOTES (Fase 3).
//
// Es lo ÚNICO del rediseño que `turns.ts` conoce. Tiene dos usos, ambos apagados por defecto (PLUSMEDIK_BATCH_ENGINE):
//   · «shadow»: la ruta de siempre responde y escribe como hoy; el motor nuevo solo DECIDE en paralelo y se registra una línea con códigos (`batch_shadow`) para comparar. No ejecuta nada.
//   · «on»: el motor nuevo atiende el texto del lote (con las fotos ya analizadas por su propio turno) y la ruta de siempre queda de respaldo si falla antes de tocar nada.
// Nunca se registra el contenido de un mensaje, un estudio concreto, un precio ni un teléfono sin enmascarar.

export type BatchEngineMode = "shadow" | "on";

export type BatchEngineResolution = { mode: BatchEngineMode } | { mode: undefined; error?: "INVALID_VALUE" };

// PLUSMEDIK_BATCH_ENGINE: ausente, vacío u «off» = apagado; «shadow» = modo sombra; «on» = motor nuevo. Cualquier otro valor deja el motor apagado (y lo avisa con un código): una errata nunca lo enciende.
export function resolveBatchEngine(env: Record<string, string | undefined>): BatchEngineResolution {
  const raw = env.PLUSMEDIK_BATCH_ENGINE?.trim().toLowerCase();
  if (!raw || raw === "off") return { mode: undefined };
  if (raw === "shadow" || raw === "on") return { mode: raw };
  return { mode: undefined, error: "INVALID_VALUE" };
}

// ───────────────────────────── fragmentos y fotos ─────────────────────────────

// Los textos del lote como los entiende el motor: en orden, y marcando dónde hubo algo que no es texto (una foto) en medio, para no reconstruir nombres de estudios a través de eso.
export function fragmentsOf(contactTurns: readonly IncomingTurn[]): BatchFragment[] {
  const out: BatchFragment[] = [];
  let sawOther = false;
  for (const turn of contactTurns) {
    if (turn.kind !== "TEXT" || typeof turn.text !== "string") {
      sawOther = true;
      continue;
    }
    out.push({ id: turn.messageId, text: turn.text, ...(sawOther && out.length > 0 ? { breakBefore: true } : {}) });
    sawOther = false;
  }
  return out;
}

// Lo que dejó una foto, leído de lo que su turno produjo (el análisis y el registro en la sesión ya los hizo ese turno). Una foto bien leída ya figura en la sesión, así que no se repite aquí.
export function photoOutcomeOf(produced: Produced, texts: Pick<QuoteTexts, "unreadable_image" | "duplicate_image" | "full"> = QUOTE_TEXTS): PhotoOutcome {
  if (produced.kind === "none") return { status: "UNREADABLE", studyIds: [] };
  // El productor de las fotos informa qué aportó cada una (estado e ids): es la fuente más fiable.
  if (produced.photo) return { status: produced.photo.status, studyIds: [...produced.photo.studyIds] };
  if (produced.result === "technical_issue") return { status: "FAILED", studyIds: [] };
  if (produced.body === texts.unreadable_image) return { status: "UNREADABLE", studyIds: [] };
  if (produced.body === texts.duplicate_image) return { status: "DUPLICATE", studyIds: [] };
  if (produced.body === texts.full) return { status: "FULL", studyIds: [] };
  return { status: "RESOLVED", studyIds: [] };
}

// Fotos con cotización instantánea (PLUSMEDIK_INSTANT_PHOTO_QUOTES) dentro de un lote atendido por el motor. En ese modo la respuesta propia de CADA foto —la cotización con precios del catálogo o el aviso
// de que no se pudo cotizar— no pasa por la sesión: viaja en el `body` de su `Produced` (`imageProducer`). El motor solo conoce de cada foto un `PhotoOutcome` (sin ids de estudios en este modo), de modo que si
// esa respuesta no se incorpora al mensaje del lote, el paciente recibe solo la respuesta al TEXTO (p. ej. «envíame una foto de tu receta») aunque su foto ya se haya cotizado (defecto D1).
//   · Se incorporan solo `quoted` y `no_quote`. El fallo técnico de una foto ya lo comunica el motor con su aviso (TECHNICAL_ERROR) y no debe duplicarse.
//   · Sin el modo instantáneo no se incorpora nada: con sesiones, las respuestas de las fotos son acuses que el motor sustituye por su resumen de la solicitud.
export function instantPhotoReply(produced: Produced | undefined, instant: boolean): Extract<Produced, { kind: "reply" }> | undefined {
  if (!instant || !produced || produced.kind !== "reply") return undefined;
  return produced.result === "quoted" || produced.result === "no_quote" ? produced : undefined;
}

// ───────────────────────────── motor nuevo («on») ─────────────────────────────

export interface EngineInput {
  // El contexto del turno que responde, con los cierres aplazados (deferClosing).
  ctx: TurnContext;
  deps: QuoteDeps;
  config: QuoteSessionsConfig;
  from: string;
  // Los mensajes de texto del lote (en orden) y todos los del contacto (para saber dónde hubo fotos entre ellos).
  texts: readonly IncomingTurn[];
  contactTurns: readonly IncomingTurn[];
  photos: readonly PhotoOutcome[];
  // Lote mixto cuyo último mensaje no es texto: el turno de texto más reciente lee y anota (ver BatchTurnInput.recordCtx) y `beforeClose` lo libera antes de cerrar.
  recordCtx?: TurnContext;
  beforeClose?(): Promise<void>;
  // El manejador de texto de siempre aplicado a UN texto (seguridad, información, saludos, charla), con su rastro de conocimiento y su derivación al CRM.
  handle(turn: IncomingTurn): Promise<Produced>;
}

// Prueba previa: ¿el motor puede entender y decidir este lote? (lee el catálogo, sin sesión ni modelo, sin escribir). Si no puede, el lote sigue por la ruta de siempre, que todavía no ha tocado nada.
export async function engineCanDecide(input: { deps: QuoteDeps; config: QuoteSessionsConfig; contactTurns: readonly IncomingTurn[] }): Promise<{ ok: true; cancelled: boolean } | { ok: false }> {
  try {
    const { cancelled } = await probeBatch({ deps: input.deps, config: input.config, fragments: fragmentsOf(input.contactTurns), understand: { isSocial: (text) => socialOf(text) !== undefined } });
    return { ok: true, cancelled };
  } catch {
    input.deps.log("batch_engine_fallback", { stage: "PROBE" });
    return { ok: false };
  }
}

export async function engineReply(input: EngineInput): Promise<Produced> {
  const byId = new Map(input.texts.map((turn) => [turn.messageId, turn]));
  const { produced } = await runBatchTurn({
    ctx: input.ctx,
    deps: input.deps,
    config: input.config,
    from: input.from,
    fragments: fragmentsOf(input.contactTurns),
    photos: input.photos,
    ...(input.recordCtx ? { recordCtx: input.recordCtx } : {}),
    ...(input.beforeClose ? { beforeClose: input.beforeClose } : {}),
    async delegate(request) {
      const turns = request.fragmentIds.map((id) => byId.get(id)).filter((turn): turn is IncomingTurn => turn !== undefined);
      const last = turns[turns.length - 1];
      if (!last) return undefined;
      const answered = await input.handle(turns.length === 1 ? last : { ...last, text: turns.map((turn) => turn.text).join("\n") });
      if (answered.kind === "none") return undefined;
      // El manejador falló (ya dejó su fallo registrado): se usa el texto seguro fijo de cada caso, nunca el aviso técnico en lugar de una urgencia.
      if (answered.result === "technical_issue") throw new Error("DELEGATE_FAILED");
      return { body: answered.body, ...(answered.stale ? { stale: answered.stale } : {}) };
    },
    understand: { isSocial: (text) => socialOf(text) !== undefined, ...(input.config.interpreter ? { interpret: input.config.interpreter } : {}) },
    silenceSocial: Boolean(input.config.attention),
    delegatePrompts: true
  });
  return produced;
}

// ───────────────────────────── modo sombra ─────────────────────────────

// El modo sombra nunca puede retrasar ni romper una respuesta: cada paso se acota en el tiempo y cualquier fallo se traga (solo queda un código).
const SHADOW_BUDGET_MS = 1500;

async function bounded<T>(work: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), SHADOW_BUDGET_MS); timer.unref?.(); })]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ANTES de que la ruta de siempre trabaje (la corrida sigue abierta): lee la solicitud abierta tal como estaba (una lectura, sin esperar ni reintentar), el catálogo y, solo ante un «listo» sin estudios,
// si hubo una cotización reciente. Entiende el lote SIN modelo. No escribe nada.
export type ShadowBefore = { state: "ready"; preview: PreviewState } | { state: "skipped"; reason: "PENDING" | "REPLAY" | "UNAVAILABLE" };

export async function shadowBefore(args: { ctx: TurnContext; deps: QuoteDeps; config: QuoteSessionsConfig; contactTurns: readonly IncomingTurn[] }): Promise<ShadowBefore> {
  const { ctx, deps, config } = args;
  const result = await bounded(
    (async (): Promise<ShadowBefore> => {
      const snapshot = await snapshotSession(ctx, deps);
      if (snapshot.state === "skipped") return { state: "skipped", reason: snapshot.reason };
      const preview = await previewUnderstanding({ deps, config, fragments: fragmentsOf(args.contactTurns), session: snapshot.session, recentQuote: snapshot.recentQuote, understand: { isSocial: (text) => socialOf(text) !== undefined } });
      return { state: "ready", preview };
    })()
  );
  return result ?? { state: "skipped", reason: "UNAVAILABLE" };
}

// DESPUÉS: con lo que dejaron las fotos, decide como lo habría hecho el motor nuevo (función pura) y lo compara con lo que la ruta de siempre produjo. Registra UNA línea (`batch_shadow`) con códigos.
export function shadowAfter(args: { before: ShadowBefore; deps: QuoteDeps; config: QuoteSessionsConfig; from: string; messages: number; photos: readonly PhotoOutcome[]; current: Produced }): void {
  const { deps, before } = args;
  const base = { phone: maskPhone(args.from), messages: args.messages, photos: args.photos.length };
  try {
    if (before.state === "skipped") {
      deps.log("batch_shadow", { ...base, skipped: before.reason });
      return;
    }
    const trace = previewPlan(before.preview, args.photos, Boolean(args.config.attention));
    const report = buildShadowReport({ plan: trace.plan, understanding: trace.understanding, current: args.current, texts: QUOTE_TEXTS, messages: args.messages, photos: args.photos.length, modelConfigured: Boolean(args.config.interpreter) });
    deps.log("batch_shadow", { phone: base.phone, ...report });
  } catch {
    deps.log("batch_shadow", { ...base, skipped: "PLAN_FAILED" });
  }
}
