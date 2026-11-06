import { resolveTextPilotGate } from "../../src/text-pilot-gate.js";
import { WhatsAppClient } from "@kapso/whatsapp-cloud-api";
import { waitUntil } from "@vercel/functions";
import { analyzeImage } from "../../src/analyze.js";
import { resolveAudio } from "../../src/audio/config.js";
import type { MediaFetcher } from "../../src/audio/media.js";
import { resolveBatchEngine } from "../../src/batch-engine.js";
import { resolveAttentionFilter } from "../../src/attention-filter.js";
import { createSupabaseAuditRepository, type AuditRepository } from "../../src/audit.js";
import { loadActiveCatalog } from "../../src/supabase-catalog.js";
import { resolveScopedContactControl } from "../../src/crm-attention.js";
import { contactKeyOf, createAttentionRepository, type AttentionRepository } from "../../src/human-control.js";
import { handleKapsoWebhook } from "../../src/kapso-webhook.js";
import { createSupabaseKnowledgeStore, KnowledgeService } from "../../src/knowledge/index.js";
import { ANSWER_TEXTS, answerFromKnowledge, detectTopics, lazyKnowledge, ttlCache } from "../../src/knowledge-answers.js";
import { resolveConversationModel } from "../../src/conversation-openai.js";
import { resolveConversationMemory } from "../../src/conversation-memory.js";
import { resolveAgentSettings } from "../../src/agent/openai.js";
import { createAgentPilot, createPilotSwitch, createRecentProvider, resolveAgentPilotSettings } from "../../src/agent/pilot.js";
import { resolveAgentMode } from "../../src/agent/pipeline.js";
import { createAgentShadow } from "../../src/agent/shadow.js";
import { createConversationReader, createSupabaseConversationStore, resolveConversationState } from "../../src/conversation-state-store.js";
import { resolveDailyReplyCap } from "../../src/daily-reply-cap.js";
import { resolveMessageHistory } from "../../src/message-history.js";
import { resolveStudyInterpreter } from "../../src/study-interpreter-openai.js";
import { resolveCrmOutbox } from "../../src/crm-outbox/config.js";
import { createCrmHandoffSink } from "../../src/crm-outbox/handoff-sink.js";
import { QUOTE_TEXTS } from "../../src/quote-session.js";
import { appendApprovedQuotePreparations } from "../../src/quote-preparation.js";
import { appendApprovedQuoteStudyDetails } from "../../src/quote-study-details.js";
import { createSupabaseStudyFactsStore, StudyFactsService } from "../../src/study-facts/index.js";
import { resolveQuoteSessionsConfig } from "../../src/quote-session-turns.js";
import { looksAutomated, resolveReplyGuard } from "../../src/reply-guard.js";
import { BLOCKED_HANDOFF, createTextHandler, DRAFT_TEXTS } from "../../src/text-handler.js";
import type { IncomingImage, QuoteDeps } from "../../src/whatsapp-quote.js";

// POST /api/kapso/webhook: recibe imágenes de WhatsApp (Kapso), las procesa con el motor de PlusMedik y responde con la cotización.
// Variables: WEBHOOK_SECRET, KAPSO_API_KEY, KAPSO_PHONE_NUMBER_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY (+ opcional ALLOWED_PHONES).
// Control de atención humana (APAGADO por defecto; ver README): PLUSMEDIK_HUMAN_CONTROL=on lo activa y exige PLUSMEDIK_CONTACT_HMAC_KEY (clave dedicada, >= 32 caracteres).
// Sin la clave, con el control activo, no se responde a nadie (falla cerrado). REQUIRE_AUDIT_GUARD=on exige el claim aunque el control esté apagado.
// Turnos (G2.0, APAGADO por defecto): PLUSMEDIK_TURNS=on activa la coordinación de mensajes consecutivos de un mismo contacto (numeración, un solo envío en vuelo por
// contacto, respuestas obsoletas). Exige las migraciones 01-07 y la misma clave dedicada; sin ella no se responde a nadie. Con PLUSMEDIK_TURNS=on SIN manejador de texto (ver abajo)
// solo las imágenes pasan por la coordinación; el texto y los demás mensajes se siguen ignorando.
const on = (name: string) => process.env[name]?.trim().toLowerCase() === "on";
const humanControlEnabled = on("PLUSMEDIK_HUMAN_CONTROL");
// La puerta opt-in impide activar G2/G4 sobre teléfonos fuera del piloto.
// Si no coincide con la lista de control del CRM, se conserva el flujo de imágenes anterior.
const textPilotGate = resolveTextPilotGate(process.env);
if (textPilotGate.enabled && !textPilotGate.ready) {
  console.log(JSON.stringify({ app: "plusmedik", event: "text_pilot_config_invalid", reason: textPilotGate.reason }));
}
const turnsEnabled = on("PLUSMEDIK_TURNS") && textPilotGate.ready;
// Manejador de texto (G2.1, APAGADO por defecto): PLUSMEDIK_TEXT_HANDLER=on solo tiene efecto con PLUSMEDIK_TURNS=on. Responde con textos fijos BORRADOR (pendientes de
// aprobación del laboratorio) sin cifras, horarios ni datos médicos. La derivación a una persona permanece BLOQUEADA (BLOCKED_HANDOFF) salvo que la cola hacia el CRM (G5.0, abajo)
// esté habilitada Y completamente configurada; mientras tanto nunca se le dice al paciente que una persona lo atenderá.
const textHandlerEnabled = on("PLUSMEDIK_TEXT_HANDLER") && textPilotGate.ready;
// Respuestas con conocimiento aprobado del laboratorio (G3.1A, APAGADO por defecto): PLUSMEDIK_KNOWLEDGE_ANSWERS=on solo tiene efecto con PLUSMEDIK_TURNS=on y PLUSMEDIK_TEXT_HANDLER=on.
// Exige las NUEVE migraciones aplicadas y conocimiento APROBADO cargado; sin datos aprobados y vigentes el bot responde como sin conocimiento (nunca inventa). Las referencias
// de cada respuesta se registran antes de enviarla; si no se pueden registrar, no se envía esa respuesta.
const knowledgeAnswersEnabled = on("PLUSMEDIK_KNOWLEDGE_ANSWERS");
// Protección contra bucles y exceso de respuestas (G3.2, APAGADA por defecto): PLUSMEDIK_REPLY_GUARD=on solo tiene efecto con PLUSMEDIK_TURNS=on y PLUSMEDIK_TEXT_HANDLER=on. Exige la
// DÉCIMA migración aplicada (sin ella las respuestas de texto no se envían: falla cerrado). Umbrales opcionales en PLUSMEDIK_REPLY_GUARD_CONFIG (JSON); una configuración inválida
// deja de responder el texto (las imágenes siguen). Se recomienda encenderla ANTES que el manejador de texto.
const replyGuard = resolveReplyGuard(process.env);
const replyGuardConfig = replyGuard.enabled && !("error" in replyGuard) ? replyGuard.config : undefined;
const replyGuardInvalid = replyGuard.enabled && "error" in replyGuard;
// Sesiones de cotización (G4.0, APAGADAS por defecto): PLUSMEDIK_QUOTE_SESSIONS=on solo tiene efecto con PLUSMEDIK_TURNS=on Y PLUSMEDIK_TEXT_HANDLER=on (sin el manejador de texto
// nadie podría escribir «listo» y las fotos quedarían sin cotización: por eso, sin él, las fotos siguen cotizándose una por una como siempre). Exige la ONCEAVA migración aplicada;
// sin ella las fotos y los textos de cotización responden con el aviso técnico (falla cerrado). Los estudios y precios son SIEMPRE los de lab_tests al momento de cotizar.
const quoteSessionsEnabled = on("PLUSMEDIK_QUOTE_SESSIONS") && turnsEnabled && textHandlerEnabled;
// Piloto opt-in: cada foto entrega SU propia cotización, sin pedir LISTO. No desactiva las cotizaciones por texto ni cambia el ruteo de otros pacientes.
// Sirve igual con la puerta del piloto encendida (solo el piloto) o apagada (todos los contactos usan la misma ruta de turnos).
const instantPhotoQuotesEnabled = on("PLUSMEDIK_INSTANT_PHOTO_QUOTES") && quoteSessionsEnabled && textPilotGate.ready;
// Opt-in: anexar preparaciones clínicas aprobadas a la cotización, sin llamadas al modelo.
// Exige turnos auditables, respuesta de texto y conocimiento (falla cerrado si falta cualquiera).
const quotePreparationsEnabled = on("PLUSMEDIK_QUOTE_PREPARATIONS") && turnsEnabled && textHandlerEnabled && knowledgeAnswersEnabled && replyGuard.enabled && !replyGuardInvalid;
// Datos aprobados por estudio (G4.1, APAGADOS por defecto): PLUSMEDIK_STUDY_INFO=on solo tiene efecto con PLUSMEDIK_TURNS, PLUSMEDIK_TEXT_HANDLER y PLUSMEDIK_KNOWLEDGE_ANSWERS en on.
// Permite consultar el plazo de entrega (en horas o días según el estudio) y el tipo de muestra/requisitos SOLO con datos aprobados y vigentes. Exige la DOCEAVA migración; sin ella
// o sin datos aprobados el bot dice que no tiene el dato (nunca inventa un plazo). Los estudios salen de la última cotización o del nombre que escriba el paciente.
const studyInfoEnabled = on("PLUSMEDIK_STUDY_INFO") && turnsEnabled && textHandlerEnabled && knowledgeAnswersEnabled;
// Opt-in independiente: se añaden muestra, requisitos y tiempos aprobados a la cotización después de anexar la preparación.
const quoteStudyDetailsEnabled = on("PLUSMEDIK_QUOTE_STUDY_DETAILS") && quotePreparationsEnabled && studyInfoEnabled;
// Derivación segura de casos al CRM (G5.0, APAGADA por defecto): PLUSMEDIK_CRM_HANDOFF=on solo tiene efecto con PLUSMEDIK_TURNS=on y PLUSMEDIK_TEXT_HANDLER=on y con TODA la configuración
// (PLUSMEDIK_CRM_REVIEW_URL, PLUSMEDIK_CRM_REVIEW_TOKEN, PLUSMEDIK_OUTBOX_KEY, KAPSO_PHONE_NUMBER_ID). Exige la TRECEAVA migración. Con ella, la derivación a una persona deja de estar
// bloqueada, pero SOLO se le confirma al paciente cuando el CRM ya registró el caso. Con cualquier configuración incompleta la derivación sigue BLOQUEADA (y se registra un código).
let studyFactsService: StudyFactsService | undefined;
const studyFacts = () => (studyFactsService ??= new StudyFactsService({ store: createSupabaseStudyFactsStore({ requestTimeoutMs: 3000, retryDelayMs: 200 }) }));
const logLine = (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ app: "plusmedik", event, ...data }));
const crmOutbox = turnsEnabled && textHandlerEnabled ? resolveCrmOutbox(process.env, logLine) : undefined;
if (replyGuard.enabled && "error" in replyGuard) logLine("reply_guard_config_invalid", { error: replyGuard.error });
// Conversación natural con OpenAI (G5.3, APAGADA por defecto): PLUSMEDIK_LLM_CONVERSATION=on solo tiene efecto con PLUSMEDIK_TURNS=on, PLUSMEDIK_TEXT_HANDLER=on y PLUSMEDIK_REPLY_GUARD=on (válida), con
// OPENAI_API_KEY y OPENAI_CONVERSATION_MODEL (obligatorio; sin valor por defecto). El modelo solo conversa y clasifica: precios, preparación, resultados y datos del laboratorio siguen saliendo SOLO del
// catálogo y del conocimiento aprobado, y lo médico, la derivación a una persona y la información nunca dependen de él. Cualquier configuración incompleta la deja apagada (y se registra un código).
const conversationModel = turnsEnabled && textHandlerEnabled ? resolveConversationModel(process.env, logLine, { responseGuardActive: replyGuard.enabled && !("error" in replyGuard) }) : undefined;
// Memoria conversacional corta (APAGADA por defecto; ver .env.example y src/conversation-memory.ts): para todos los pacientes que atienda el agente, sin listas de teléfonos.
// Tope de respuestas del agente por contacto (APAGADO por defecto; ver .env.example y src/daily-reply-cap.ts): 5 cada 24 horas, aplicado por la base al reservar el envío.
const dailyReplyCap = resolveDailyReplyCap(process.env, logLine, { turnsActive: turnsEnabled });
// Motor global de lotes (APAGADO por defecto; ver docs/g6/03-conexion-del-motor-de-lotes.md): PLUSMEDIK_BATCH_ENGINE=shadow compara en los registros la decisión del motor nuevo con la ruta de siempre SIN cambiar
// ninguna respuesta ni escribir nada propio; =on hace que el motor nuevo atienda el texto de los lotes de Kapso (varios mensajes de un contacto) con la ruta de siempre de respaldo. Solo tiene efecto con las sesiones de
// cotización activas. Cualquier otro valor lo deja apagado (y se registra un código).
const batchEngineResolution = resolveBatchEngine(process.env);
if ("error" in batchEngineResolution && batchEngineResolution.error) logLine("batch_engine_config_invalid", { error: batchEngineResolution.error });
const batchEngineMode = quoteSessionsEnabled && !replyGuardInvalid ? batchEngineResolution.mode : undefined;
if (batchEngineResolution.mode && !batchEngineMode) logLine("batch_engine_inactive", { reason: "QUOTE_SESSIONS_REQUIRED" });
// Alcance real del agente, sin números de teléfono: permite comprobar en los registros de Vercel, tras cada cambio de variables, quién usa la ruta de turnos y si el tope cubre a todos.
const allContactsOnTurns = turnsEnabled && !textPilotGate.enabled;
logLine("agent_scope", { turns: turnsEnabled, textHandler: textHandlerEnabled, pilotGate: textPilotGate.enabled, allContactsOnTurns, allowedPhonesRestricted: Boolean(process.env.ALLOWED_PHONES?.trim()), dailyCap: dailyReplyCap !== undefined, instantPhotoQuotes: instantPhotoQuotesEnabled, humanControl: humanControlEnabled, batchEngine: batchEngineMode ?? "off" });
// Con la puerta del piloto encendida, los demás contactos siguen por la ruta anterior de fotos, que no pasa por los turnos y por tanto NO tiene el tope: el tope no cubre a todos.
if (dailyReplyCap && textPilotGate.enabled) logLine("daily_cap_partial_scope", { reason: "PILOT_GATE_ON" });
const conversationMemory = resolveConversationMemory(process.env, logLine, { conversationActive: conversationModel !== undefined, isAutomated: looksAutomated });
// Intérprete de estudios escritos (APAGADO por defecto; ver .env.example y src/study-interpreter.ts): errores de ortografía, abreviaturas y pedidos en lenguaje natural; el backend valida todo contra el catálogo.
const studyInterpreter = resolveStudyInterpreter(process.env, logLine, { textQuotesActive: quoteSessionsEnabled && !replyGuardInvalid });
// Atención selectiva (G6.0, APAGADA por defecto): PLUSMEDIK_ATTENTION_FILTER=on solo tiene efecto con PLUSMEDIK_TURNS=on y PLUSMEDIK_TEXT_HANDLER=on. NO ignora lo médico, pedir a una persona ni nada que pueda ser una
// solicitud: solo saludos aislados, cortesías, mensajes sin letras y repeticiones literales (sin responder, sin modelo y sin consultas), y agrupa las confirmaciones de varios mensajes seguidos. Con las sesiones de cotización
// y la conversación con modelo, el modelo recibe además el ESTADO de la conversación (cantidades, no textos). Opcionales: PLUSMEDIK_ATTENTION_REPEAT_SECONDS (5-600) y PLUSMEDIK_ATTENTION_SETTLE_MS (0-10000). Un valor inválido
// deja el filtro apagado (se procesa todo como antes) y se registra un código. No requiere migración.
const attentionFilter = turnsEnabled && textHandlerEnabled ? resolveAttentionFilter(process.env) : ({ enabled: false } as const);
const attentionConfig = attentionFilter.enabled && !("error" in attentionFilter) ? attentionFilter.config : undefined;
if (attentionFilter.enabled && "error" in attentionFilter) logLine("attention_filter_config_invalid", { error: attentionFilter.error });
// Control acotado a una lista explícita de contactos (APAGADO por defecto): con PLUSMEDIK_AGENT_CONTROL=on y PLUSMEDIK_AGENT_CONTROL_PHONES (y SIN PLUSMEDIK_HUMAN_CONTROL), solo esos números se reclaman con su clave
// de contacto y respetan la pausa manual del CRM; los demás pacientes siguen el flujo de siempre. No toca la pausa automática por mensajes humanos (eso es PLUSMEDIK_HUMAN_CONTROL) ni ALLOWED_PHONES.
const scopedContactControl = humanControlEnabled ? undefined : resolveScopedContactControl(process.env);
const contactKeyFor = (phone: string) => contactKeyOf({ hmacKey: process.env.PLUSMEDIK_CONTACT_HMAC_KEY, labPhoneNumberId: process.env.KAPSO_PHONE_NUMBER_ID, contactPhone: phone });
// Historial de TODOS los mensajes (ENCENDIDO por defecto, sin variables nuevas; ver docs/g6/05-historial-de-mensajes.md y src/message-history.ts): guarda en Supabase lo que escriben los pacientes, las respuestas del agente
// y los mensajes de la recepción humana, para conservarlos y usarlos desde otros proyectos. Exige las migraciones 21 y 22 aplicadas (sin ellas la escritura falla sin afectar al agente), PLUSMEDIK_CONTACT_HMAC_KEY y
// KAPSO_PHONE_NUMBER_ID. PLUSMEDIK_HISTORY=off lo apaga; PLUSMEDIK_HISTORY_KEY (opcional) lo guarda cifrado. Es independiente de la memoria conversacional y del resto del agente.
const messageHistory = resolveMessageHistory(process.env, logLine, { contactKeyFor });
logLine("history_scope", { enabled: messageHistory !== undefined, encrypted: Boolean(process.env.PLUSMEDIK_HISTORY_KEY?.trim()) });
// Memoria estructurada de la conversación en SOMBRA (APAGADA por defecto; ver docs/g7/10 y src/conversation-state-store.ts): PLUSMEDIK_CONV_STATE=shadow registra peticiones, respuestas, mensajes humanos y recetas por ids para
// calcular lo pendiente, SIN cambiar ninguna respuesta, lease, envío ni la pausa humana. Exige la migración 24 (sin ella las escrituras fallan sin afectar al agente) y PLUSMEDIK_CONTACT_HMAC_KEY + KAPSO_PHONE_NUMBER_ID.
// Apagada no escribe ni una línea nueva en el registro.
const convState = resolveConversationState(process.env, logLine, { contactKeyFor });
if (convState) logLine("conv_state_scope", { mode: convState.mode });

// El sistema de archivos de Vercel es de solo lectura: sin caché local (el registro de uso, si se escribe, va a /tmp).
process.env.AI_CACHE ??= "off";
process.env.AI_CACHE_DIR ??= "/tmp/plusmedik-cache";

function kapsoClient(): WhatsAppClient {
  const kapsoApiKey = process.env.KAPSO_API_KEY;
  if (!kapsoApiKey) throw new Error("Missing KAPSO_API_KEY");
  return new WhatsAppClient({ baseUrl: "https://api.kapso.ai/meta/whatsapp", kapsoApiKey });
}

function phoneNumberId(): string {
  const id = process.env.KAPSO_PHONE_NUMBER_ID;
  if (!id) throw new Error("Missing KAPSO_PHONE_NUMBER_ID");
  return id;
}

// Banderas del motor en producción: una sola fuente para el análisis y para el registro de auditoría (qué configuración produjo cada análisis).
const ENGINE_FLAGS = { semanticPrimary: true, semanticAuto: true, partialAuto: true, handwrittenAuto: "on" } as const;

let auditRepository: AuditRepository | undefined;
function audit(): AuditRepository {
  return auditRepository ??= createSupabaseAuditRepository({ runtime: { flags: ENGINE_FLAGS } });
}

let quotePreparationKnowledge: KnowledgeService | undefined;
const quotePreparationReader = () => (quotePreparationKnowledge ??= new KnowledgeService({
  store: createSupabaseKnowledgeStore({ requestTimeoutMs: 3000, retryDelayMs: 200 }),
  // Preparación clínica en cotizaciones: verificar vigencia en cada lectura.
  // Ante falta de conexión no reutilizar una instantánea potencialmente retirada.
  revisionCheckMs: 0,
  maxStaleMs: 0
}));

const quoteFactsReader = () => new StudyFactsService({
  store: createSupabaseStudyFactsStore({ requestTimeoutMs: 3000, retryDelayMs: 200 }),
  revisionCheckMs: 0,
  maxStaleMs: 5_000 // lector nuevo por cotización; se comparte solo durante esta lectura, nunca entre pacientes
});

// Audios (APAGADOS por defecto; ver docs/g6/04-audios.md): PLUSMEDIK_AUDIO=on solo tiene efecto con PLUSMEDIK_TURNS=on y PLUSMEDIK_TEXT_HANDLER=on, y exige OPENAI_API_KEY y OPENAI_TRANSCRIPTION_MODEL (sin valor
// por defecto). No necesita migraciones. Los audios se bajan SOLO de los enlaces de Kapso (o por el id del medio con el SDK oficial); la credencial de Kapso solo viaja a servidores de Kapso.
const audioFetcher: MediaFetcher = {
  rawFetch: (url, init) => kapsoClient().rawFetch(url, init),
  authedFetch: (url, init) => kapsoClient().fetch(url, init),
  async sdkDownload(mediaId) {
    return (await kapsoClient().media.download({ mediaId, phoneNumberId: phoneNumberId(), as: "arrayBuffer" })) as ArrayBuffer;
  }
};
const audioRequested = on("PLUSMEDIK_AUDIO");
const audioPipeline = audioRequested && turnsEnabled && textHandlerEnabled ? resolveAudio(process.env, logLine, { fetcher: audioFetcher }) : undefined;
if (audioRequested && !(turnsEnabled && textHandlerEnabled)) logLine("audio_inactive", { reason: "TURNS_AND_TEXT_HANDLER_REQUIRED" });
// Con la bandera apagada no se escribe NI UNA línea nueva en el registro (el arranque es idéntico al de antes).
if (audioRequested) logLine("audio_scope", { enabled: audioPipeline !== undefined });
// Los audios solo se activan si están realmente encendidos (turnos, manejador de texto y guarda de respuestas válida).
const audioActive = Boolean(audioPipeline && turnsEnabled && textHandlerEnabled && !replyGuardInvalid);

// Conocimiento aprobado del laboratorio: el servicio se crea al primer uso; el catálogo (solo para identificar el estudio por el que se pregunta) se pide únicamente ante preguntas de preparación y se guarda 5 min.
// Lo usan el manejador de texto de siempre y, en sombra, el núcleo conversacional (herramienta lab_info).
const knowledgeOptions = knowledgeAnswersEnabled
  ? { skipPayment: true, service: lazyKnowledge(() => new KnowledgeService({ store: createSupabaseKnowledgeStore({ requestTimeoutMs: 3000, retryDelayMs: 200 }) })), loadCatalog: ttlCache(() => loadActiveCatalog(), 5 * 60_000), studyFacts: studyInfoEnabled ? { getSample: (...args: Parameters<ReturnType<typeof studyFacts>["getSample"]>) => studyFacts().getSample(...args), getTurnaround: (...args: Parameters<ReturnType<typeof studyFacts>["getTurnaround"]>) => studyFacts().getTurnaround(...args) } : undefined }
  : undefined;

// Núcleo conversacional EN SOMBRA (APAGADO por defecto; ver docs/g7/12 y src/agent/): PLUSMEDIK_AGENT=shadow + OPENAI_AGENT_MODEL (obligatorio) decide en segundo plano qué respondería a cada lote reclamado, SIN
// ENVIAR NADA ni cambiar ninguna respuesta, lease, pausa, tope ni precio. Exige el modo turnos. Usa la memoria de la Fase 1 si PLUSMEDIK_CONV_STATE=shadow. Apagado no escribe ni una línea nueva en el registro.
const agentSettings = resolveAgentSettings(process.env, logLine);
const agentMode = resolveAgentMode(process.env, () => undefined);
if (agentSettings && !turnsEnabled) logLine("agent_config_invalid", { error: "TURNS_REQUIRED" });
const agentShadow = agentSettings && agentMode === "shadow" && turnsEnabled
  ? createAgentShadow({
      model: agentSettings.model,
      modelName: agentSettings.modelName,
      sample: agentSettings.sample,
      loadCatalog: ttlCache(() => loadActiveCatalog(), 60_000),
      ...(knowledgeOptions ? { answer: (question: string) => answerFromKnowledge(question, knowledgeOptions) } : {}),
      ...(convState ? { reader: createConversationReader({ store: createSupabaseConversationStore() }) } : {}),
      contactKeyFor,
      // La derivación humana del agente está DESACTIVADA hasta validar la integración con el CRM: la capacidad es fija y NINGUNA bandera la enciende (ni siquiera la de la cola al CRM). Solo cotizar está disponible.
      capabilities: { handoff: false, quote: true },
      ...(conversationMemory ? { recent: async ({ messageId, contactKey }: { messageId: string; contactKey: string }) => conversationMemory.history({ contactKey, currentMessageId: messageId }) } : {}),
      log: logLine
    })
  : undefined;
if (agentShadow) logLine("agent_scope", { mode: agentShadow.mode, model: agentSettings!.modelName, sample: agentSettings!.sample });

// PILOTO del nuevo agente (APAGADO por defecto; ver docs/g7/14 y src/agent/pilot.ts): PLUSMEDIK_AGENT=pilot + OPENAI_AGENT_MODEL + PLUSMEDIK_AGENT_PILOT_PHONES (1 a 5 números) hace que el núcleo conversacional RESPONDA,
// por la misma máquina de envío de siempre, SOLO a esos números y SOLO mientras el interruptor de la base (migración 25; nace apagado) diga «encendido». Los demás contactos siguen con el agente actual, sin
// llamadas nuevas. Exige el modo turnos; la memoria de la fase 1 (PLUSMEDIK_CONV_STATE=shadow) es opcional. Cualquier configuración incompleta lo deja apagado con un código.
// PLUSMEDIK_AGENT=live: el mismo núcleo para TODOS los contactos elegibles (menos PLUSMEDIK_AGENT_EXCLUDE_PHONES), con el mismo interruptor de la base (apaga a todos al instante), el mismo respaldo al agente
// de siempre y un corta-circuito si el modelo falla seguido. Ver docs/g7/15.
const pilotSettings = agentSettings && (agentMode === "pilot" || agentMode === "live") ? resolveAgentPilotSettings(process.env, logLine, agentMode) : undefined;
// La memoria estructurada (PLUSMEDIK_CONV_STATE, migración 24) es OPCIONAL: sin ella el agente decide con los mensajes recientes del historial (últimas 24 h) y las herramientas.
const agentPilot = agentSettings && pilotSettings && turnsEnabled
  ? createAgentPilot({
      model: agentSettings.model,
      modelName: agentSettings.modelName,
      ...(pilotSettings.phones ? { phones: pilotSettings.phones } : {}),
      ...(pilotSettings.exclude ? { everyone: { exclude: pilotSettings.exclude, contactKeyFor } } : {}),
      switch: createPilotSwitch({ log: logLine }),
      handoffEnabled: pilotSettings.handoffEnabled,
      ...(pilotSettings.dailyMax !== undefined ? { dailyCap: { max: pilotSettings.dailyMax, windowSeconds: 86_400 } } : {}),
      ...(pilotSettings.deadlineMs !== undefined ? { deadlineMs: pilotSettings.deadlineMs } : {}),
      context: {
        loadCatalog: ttlCache(() => loadActiveCatalog(), 60_000),
        ...(knowledgeOptions ? { answer: (question: string) => answerFromKnowledge(question, knowledgeOptions) } : {}),
        ...(convState ? { reader: createConversationReader({ store: createSupabaseConversationStore() }) } : {}),
        contactKeyFor,
        recent: createRecentProvider({}),
        capabilities: { handoff: false, quote: true }
      },
      log: logLine
    })
  : undefined;
if (agentPilot) logLine("agent_scope", { mode: agentPilot.mode, model: agentSettings!.modelName, ...(pilotSettings!.phones ? { phones: pilotSettings!.phones.size } : { everyone: true, excluded: pilotSettings!.exclude!.size }), handoff: pilotSettings!.handoffEnabled, ...(pilotSettings!.dailyMax !== undefined ? { dailyMax: pilotSettings!.dailyMax } : {}) });

const realDeps: QuoteDeps = {
  async downloadImage(image: IncomingImage) {
    const client = kapsoClient();
    if (image.mediaUrl) {
      // Las URLs de medios alojados suelen ser públicas/firmadas; si rechazan, se reintenta con la autenticación de Kapso.
      let response = await client.rawFetch(image.mediaUrl);
      if (response.status === 401 || response.status === 403) response = await client.fetch(image.mediaUrl);
      if (!response.ok) throw new Error(`media download failed: HTTP ${response.status}`);
      return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") ?? undefined };
    }
    const data = (await client.media.download({ mediaId: image.mediaId!, phoneNumberId: phoneNumberId(), as: "arrayBuffer" })) as ArrayBuffer;
    return { bytes: new Uint8Array(data) };
  },
  loadCatalog: () => loadActiveCatalog(),
  // Motor actual de PlusMedik, con las banderas ya validadas pasadas por argumento (no se modifica el AUTO MATCH).
  analyze: ({ imageBase64, mimeType, catalog }) =>
    analyzeImage({ imageBase64, mimeType, catalog, ...ENGINE_FLAGS }),
  quotePreparations: quotePreparationsEnabled
    ? async (quote, studyIds, catalog, ctx) => {
        const prepared = await appendApprovedQuotePreparations({
          quote,
          studyIds,
          catalog,
          knowledge: quotePreparationReader(),
          trace: (refs) => ctx.persist("quote_preparation", async (repo, runId, lease) => {
            if ((await repo.recordKnowledgeRefs?.(runId, refs, lease)) !== "recorded") {
              throw new Error("QUOTE_PREPARATION_TRACE_UNAVAILABLE");
            }
          })
        });
        if (!quoteStudyDetailsEnabled) return prepared;
        return appendApprovedQuoteStudyDetails({
          quote: prepared,
          studyIds,
          catalog,
          facts: quoteFactsReader(),
          trace: (refs) => ctx.persist("quote_study_details", async (repo, runId, lease) => {
            if ((await repo.recordFactRefs?.(runId, refs, lease)) !== "recorded") {
              throw new Error("QUOTE_STUDY_DETAILS_TRACE_UNAVAILABLE");
            }
          })
        });
      }
    : undefined,
  async sendText(to, body) {
    const response = await kapsoClient().messages.sendText({ phoneNumberId: phoneNumberId(), to, body });
    return { providerMessageId: response.messages[0]?.id };
  },
  audit: {
    claim: (...args) => audit().claim(...args),
    renewLease: (...args) => audit().renewLease(...args),
    recordIgnored: (...args) => audit().recordIgnored(...args),
    recordEvidence: (...args) => audit().recordEvidence(...args),
    recordFailure: (...args) => audit().recordFailure(...args),
    reserveSend: (...args) => audit().reserveSend(...args),
    confirmSend: (...args) => audit().confirmSend(...args),
    recordReply: (...args) => audit().recordReply(...args),
    // Operaciones opcionales del repositorio: sin ellas aquí, el modo turnos / conocimiento / sesiones no podría registrar su rastro y fallaría cerrado (una prueba verifica que no falte ninguna).
    releaseTurn: (...args) => audit().releaseTurn?.(...args) ?? Promise.resolve(),
    foldTurn: (...args) => audit().foldTurn!(...args),
    recordKnowledgeRefs: (...args) => audit().recordKnowledgeRefs!(...args),
    recordFactRefs: (...args) => audit().recordFactRefs!(...args),
    quoteLastStudies: (...args) => audit().quoteLastStudies!(...args),
    quoteBegin: (...args) => audit().quoteBegin!(...args),
    quoteFinish: (...args) => audit().quoteFinish!(...args),
    quoteRead: (...args) => audit().quoteRead!(...args),
    quoteClose: (...args) => audit().quoteClose!(...args),
    quoteShadowPeek: (...args) => audit().quoteShadowPeek!(...args)
  },
  log: logLine,
  ...(messageHistory ? { history: messageHistory } : {}),
  requireAuditGuard: humanControlEnabled || turnsEnabled || on("REQUIRE_AUDIT_GUARD"),
  humanControl: humanControlEnabled ? { contactKeyFor } : undefined,
  scopedControl: scopedContactControl ? { contactKeyFor, covers: scopedContactControl.covers } : undefined,
  turns: turnsEnabled ? { contactKeyFor, replyGuard: replyGuardConfig, attention: attentionConfig, instantPhotoQuotes: instantPhotoQuotesEnabled, dailyCap: dailyReplyCap, memory: conversationMemory, ...(convState ? { convState } : {}), ...(agentShadow ? { agentShadow } : {}), ...(agentPilot ? { agentPilot } : {}),
    crmHandoff: crmOutbox,
    // Métodos de pago ignorados hasta que se implementen (decisión del dueño): ni agente de siempre ni agente nuevo dicen nada de pagos; el resto del mensaje se atiende.
    ignorePayment: true,
    ...(batchEngineMode ? { batchEngine: { mode: batchEngineMode } } : {}),
    ...(audioActive ? { audio: audioPipeline } : {}),
    quoteSessions: quoteSessionsEnabled && !replyGuardInvalid
      ? resolveQuoteSessionsConfig({ interpreter: studyInterpreter, catalogForText: ttlCache(() => loadActiveCatalog(), 60_000), loopProtection: replyGuard.enabled, attention: attentionConfig ? { gate: attentionConfig.gate, settleMs: attentionConfig.settleMs } : undefined, ownTexts: [...Object.values(DRAFT_TEXTS), ...Object.values(ANSWER_TEXTS), ...Object.values(QUOTE_TEXTS)], isInfoQuestion: knowledgeAnswersEnabled ? (text) => detectTopics(text, studyInfoEnabled).length > 0 : undefined })
      : undefined,
    handlers: textHandlerEnabled && !replyGuardInvalid ? { text: createTextHandler({
    handoff: crmOutbox ? createCrmHandoffSink() : BLOCKED_HANDOFF,
    log: logLine,
    loopProtection: replyGuard.enabled,
    attention: attentionConfig !== undefined,
    conversation: conversationModel,
    // Los últimos mensajes del MISMO contacto y línea (la clave del contacto incluye la línea). Sin clave de contacto no hay historial.
    history: conversationMemory ? async (turn) => {
      const contactKey = contactKeyFor(turn.from);
      return contactKey ? conversationMemory.history({ contactKey, currentMessageId: turn.messageId }) : [];
    } : undefined,
    knowledge: knowledgeOptions
  }) } : undefined } : undefined
};

// Plazos cortos para el registro de la pausa (se hace ANTES de responder; Kapso concede 10 s): 2 intentos de 3 s.
let attentionRepository: AttentionRepository | undefined;
const attention = (): AttentionRepository => (attentionRepository ??= createAttentionRepository({ requestTimeoutMs: 3000, retryDelayMs: 200 }));

const attentionProxy: AttentionRepository = {
  status: (...args) => attention().status(...args),
  registerHumanMessage: (...args) => attention().registerHumanMessage(...args),
  recordEvent: (...args) => attention().recordEvent(...args),
  resume: (...args) => attention().resume(...args)
};

export async function POST(request: Request): Promise<Response> {
  return handleKapsoWebhook(request, {
    secret: process.env.WEBHOOK_SECRET,
    allowedPhones: process.env.ALLOWED_PHONES,
    quote: realDeps,
    textPilotPhone: textPilotGate.enabled && textPilotGate.ready ? textPilotGate.pilotPhone : undefined,
    textPilotExtraPhones: textPilotGate.enabled && textPilotGate.ready ? textPilotGate.extraPhones : undefined,
    legacyQuote: textPilotGate.enabled && textPilotGate.ready && turnsEnabled
      ? { ...realDeps, turns: undefined, requireAuditGuard: humanControlEnabled || on("REQUIRE_AUDIT_GUARD") }
      : undefined,
    schedule: (task) => waitUntil(task),
    ...(messageHistory ? { history: messageHistory } : {}),
    ...(convState ? { convState } : {}),
    humanControl: humanControlEnabled ? { labPhoneNumberId: process.env.KAPSO_PHONE_NUMBER_ID, contactKeyFor, attention: attentionProxy } : undefined,
    log: realDeps.log
  });
}

export function GET(): Response {
  return new Response(JSON.stringify({ ok: true, service: "plusmedik-kapso-webhook" }), { status: 200, headers: { "content-type": "application/json" } });
}
