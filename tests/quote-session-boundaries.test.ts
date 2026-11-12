import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// FRONTERAS DEL CÓDIGO de las sesiones de cotización (análisis estático): el motor de recetas y el flujo de imágenes de siempre no las conocen, los precios y los estudios solo
// salen del catálogo, nada llama a modelos ni a la red, y todo sigue apagado por defecto.

const root = join(__dirname, "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
const source = (path: string) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");
const code = (path: string) => source(path).split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).map((line) => line.replace(/\s\/\/.*$/, "")).join("\n");
const rel = (path: string) => relative(root, path).replaceAll("\\", "/");
const importsOf = (path: string) => [...source(path).matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((match) => match[1]!);
const files = [...walk(join(root, "src")), ...walk(join(root, "api"))].filter((path) => path.endsWith(".ts"));
const SESSION_FILES = ["src/quote-session.ts", "src/quote-session-turns.ts"].map((name) => join(root, name));
const MENTION = /quote[-_ ]?sessions?|quoteSessions|plusmedik_quote_|sessionImageProducer|sessionTextProducer|parseSessionCommand|extractStudyRequests/i;

describe("G4.0: dónde pueden aparecer las sesiones de cotización", () => {
  it("el motor de recetas, los lectores, el juez, el catálogo y la cotización de siempre NO las conocen (el flujo de recetas queda intacto)", () => {
    const recipe = ["analyze", "partial-auto", "quote-completion", "whatsapp-quote", "catalog", "catalog-shadow", "catalog-semantic-resolver", "supabase-catalog", "ai", "judge", "consensus", "line-groups", "document-signal", "document-function", "study-impact", "visual-risk", "uncertainty", "safety", "pipeline", "image", "cache", "offline", "kapso-webhook", "human-control"];
    for (const name of recipe) expect(source(join(root, "src", `${name}.ts`)), name).not.toMatch(MENTION);
  });

  it("solo las propias sesiones, la elección de productor (turns), la configuración (guarded-turn), el repositorio (audit) y el cableado de Vercel las nombran", () => {
    // src/batch-understanding.ts y src/batch-policy.ts: Fase 1 del rediseño del lote (puros y sin conectar; ver el bloque que los acota más abajo).
    // src/text-fragments.ts: reconstruye nombres de estudios partidos entre mensajes de un lote de Kapso; solo reutiliza funciones PURAS del módulo de sesiones (interpretar y reconocer comandos) y únicamente lo conecta turns.ts.
    const allowed = new Set(["src/quote-session.ts", "src/quote-session-turns.ts", "src/turns.ts", "src/guarded-turn.ts", "src/audit.ts", "api/kapso/webhook.ts", "src/study-interpreter.ts", "src/study-interpreter-openai.ts", "src/text-fragments.ts", "src/conversation-state-store.ts", "src/agent/tools.ts", "src/batch-understanding.ts", "src/batch-policy.ts", "src/batch-compose.ts", "src/batch-execution.ts", "src/batch-shadow.ts", "src/batch-engine.ts", "src/audio-turns.ts"]);
    for (const path of files) {
      // G5.0: la cola de salida hacia el CRM lee los mensajes dudosos de una solicitud cerrada en revisión (plusmedik_quote_review_targets)
      if (allowed.has(rel(path)) || rel(path).startsWith("src/crm-outbox/")) continue;
      expect(source(path), rel(path)).not.toMatch(MENTION);
    }
  });

  // Excepción de arriba: text-fragments.ts reconstruye nombres de estudios partidos entre mensajes de un lote. Estas pruebas la acotan: es PURO (solo lee y devuelve las mismas unidades) y no toca sesiones,
  // reservas, auditoría, red ni estado. Si alguien le agrega esas responsabilidades, la excepción deja de valer y estas pruebas fallan.
  describe("excepción: text-fragments.ts solo reconstruye nombres", () => {
    const FRAGMENTS = join(root, "src/text-fragments.ts");

    it("solo importa funciones puras de lectura/clasificación y tipos: nada de auditoría, repositorios, entrega ni de las producciones de las sesiones", () => {
      expect(importsOf(FRAGMENTS).sort()).toEqual(["./consensus.js", "./quote-session.js", "./text-handler.js", "./turn-batch.js", "./types.js"]);
      // de las sesiones toma SOLO el intérprete de texto y el reconocimiento de comandos: no las operaciones que abren, anotan, cierran o leen una sesión
      const fromSessions = /import\s*\{([^}]*)\}\s*from\s*"\.\/quote-session\.js"/.exec(source(FRAGMENTS))?.[1]?.split(",").map((name) => name.trim()).filter(Boolean).sort();
      expect(fromSessions).toEqual(["extractStudyRequests", "parseSessionCommand", "parseSessionReply"]);
    });

    it("no hace E/S ni toca estado: ni red, ni base, ni variables de entorno, ni auditoría, reservas, leases, reclamos, envíos o escritura de sesión", () => {
      const text = code(FRAGMENTS);
      expect(text).not.toMatch(/\bfetch\s*\(|process\.env|supabase|createClient|XMLHttpRequest|require\(|import\(/i);
      expect(text).not.toMatch(/audit|reserve|persist|lease|claim|\brpc\b|recordIgnored|recordReply|recordFailure|foldTurn|releaseTurn|confirmSend|quoteBegin|quoteFinish|quoteRead|quoteClose|sendText|\bctx\b|\bdeps\b/i);
      expect(text).not.toMatch(/Date\.now|Math\.random|setTimeout|setInterval|writeFile|localStorage|globalThis|\bglobal\./);
    });

    it("solo exporta las dos funciones de reconstrucción", () => {
      expect([...source(FRAGMENTS).matchAll(/^export\s+(?:async\s+)?(?:function|const|class|let|var)\s+(\w+)/gm)].map((match) => match[1]).sort()).toEqual(["continuesStudyName", "joinStudyFragments"]);
    });

    it("solo lo conecta turns.ts (la elección de qué se interpreta); ningún otro archivo del servicio lo importa", () => {
      const importers = files.filter((path) => importsOf(path).some((imported) => /text-fragments/.test(imported))).map(rel);
      expect(importers).toEqual(["src/turns.ts"]);
    });

    it("recibe el catálogo por parámetro (no lo carga por su cuenta) y devuelve unidades nuevas sin tocar las recibidas", () => {
      const text = code(FRAGMENTS);
      expect(text).toMatch(/loadCatalog:\s*\(\)\s*=>\s*Promise</);
      expect(text).not.toMatch(/loadActiveCatalog|supabase-catalog/);
      // nunca asigna sobre las unidades de entrada (solo construye objetos nuevos)
      expect(text).not.toMatch(/\bunits\s*\[[^\]]*\]\s*=[^=]|\bunits\.(push|splice|pop|shift|unshift|sort|reverse)\(|\.members\.(push|splice)\(|\.turn\.text\s*=[^=]/);
    });
  });

  // Rediseño del lote, Fase 1: comprensión global y política de decisión. Son funciones PURAS (reciben datos y devuelven datos) y todavía NO están conectadas al webhook ni a los turnos: estas pruebas
  // fijan ambas cosas. Cuando una fase posterior las conecte, este bloque debe revisarse a conciencia en vez de relajarse.
  describe("Fase 1 del rediseño del lote: módulos puros y sin conectar", () => {
    const UNDERSTANDING = join(root, "src/batch-understanding.ts");
    const POLICY = join(root, "src/batch-policy.ts");
    const IMPURE = /\bfetch\s*\(|process\.env|supabase|createClient|XMLHttpRequest|require\(|import\(|openai|anthropic|openrouter/i;
    const STATE = /audit|reserve|persist|lease|claim|\brpc\b|recordIgnored|recordReply|recordFailure|foldTurn|releaseTurn|confirmSend|quoteBegin|quoteFinish|quoteRead|quoteClose|sendText|\bctx\b|\bdeps\b|loadCatalog|loadActiveCatalog/i;
    const NONDETERMINISTIC = /Date\.now|new Date|Math\.random|setTimeout|setInterval|writeFile|localStorage|globalThis|\bglobal\./;

    it("la comprensión solo importa lectura/clasificación del catálogo y de los textos; la política solo tipos", () => {
      expect(importsOf(UNDERSTANDING).sort()).toEqual(["./catalog-search.js", "./consensus.js", "./quote-session.js", "./text-handler.js", "./types.js"]);
      // la atención selectiva (G6.0) no se importa: su detector de cortesías entra como parte de la entrada
      expect(code(UNDERSTANDING)).not.toMatch(/attention-filter|socialOf|decideAttention/);
      expect(importsOf(POLICY).sort()).toEqual(["./batch-understanding.js", "./quote-session.js"]);
      // la política importa SOLO tipos (no arrastra ningún comportamiento)
      expect(source(POLICY)).not.toMatch(/^import\s+(?!type\b)/m);
      // de las sesiones toman únicamente funciones puras de interpretar y reconocer comandos: nada que abra, anote, cierre o lea una sesión
      const fromSessions = /import\s*\{([^}]*)\}\s*from\s*"\.\/quote-session\.js"/.exec(source(UNDERSTANDING))?.[1]?.split(",").map((name) => name.replace(/\btype\b/, "").trim()).filter(Boolean).sort();
      expect(fromSessions).toEqual(["ItemResult", "StudyInterpreter", "TextExtraction", "InterpretationNotes", "InterpretedStudyRequest", "cleanMention", "extractStudyRequests", "extractWithNotes", "isAddingMore", "isOnlyFiller", "isSectionHeading", "isGeneralQuestion", "mergeInterpretation", "optionsOf", "parseSessionCommand", "parseSessionReply", "wantsQuoteNow"].sort());
    });

    it("no hacen E/S ni tocan estado: ni red, ni base, ni entorno, ni auditoría, reservas, leases, reclamos, envíos o escritura de sesión; y son deterministas", () => {
      for (const path of [UNDERSTANDING, POLICY]) {
        expect(code(path), rel(path)).not.toMatch(IMPURE);
        expect(code(path), rel(path)).not.toMatch(STATE);
        expect(code(path), rel(path)).not.toMatch(NONDETERMINISTIC);
      }
    });

    it("el modelo entra SOLO por un puerto inyectado (StudyInterpreter): no hay cliente de OpenAI ni claves dentro", () => {
      expect(code(UNDERSTANDING)).toMatch(/interpret\?:\s*StudyInterpreter/);
      expect(importsOf(UNDERSTANDING).some((imported) => /openai|study-interpreter|conversation-model|ai\.js/.test(imported))).toBe(false);
    });

    it("no hay precios: ni campos ni lecturas de precio en la política; en la comprensión solo viajan ids de estudios", () => {
      expect(code(POLICY)).not.toMatch(/priceBs|\bprice\b|precio|\btotalBs\b|toCents/i);
      expect(code(UNDERSTANDING)).not.toMatch(/priceBs|toCents|totalBs/);
    });

    it("solo los importan los propios módulos del rediseño del lote y el puente (batch-engine.ts): nada más de src/ ni api/ los conoce", () => {
      const family = ["src/batch-understanding.ts", "src/batch-policy.ts", "src/batch-compose.ts", "src/batch-execution.ts", "src/batch-shadow.ts", "src/batch-engine.ts"];
      const importers = files.filter((path) => importsOf(path).some((imported) => /batch-(understanding|policy|compose|execution|shadow)/.test(imported))).map(rel).sort();
      expect(importers.every((path) => family.includes(path))).toBe(true);
      expect(importers).toEqual(["src/batch-compose.ts", "src/batch-engine.ts", "src/batch-execution.ts", "src/batch-policy.ts", "src/batch-shadow.ts"]);
    });

    it("solo exportan lo previsto", () => {
      const exportsOf = (path: string) => [...source(path).matchAll(/^export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+(\w+)/gm)].map((match) => match[1]!).sort();
      expect(exportsOf(UNDERSTANDING)).toEqual(["AmbiguousGroup", "BatchCommand", "BatchFragment", "BatchIntent", "BatchUnderstanding", "DEFAULT_MAX_MODEL_CHARS", "EMPTY_SESSION", "IntentSource", "ModelUse", "NegationDoubt", "SessionContext", "UnderstandInput", "understandBatch"].sort());
      expect(exportsOf(POLICY)).toEqual(["Core", "Notice", "PhotoOutcome", "PlanReason", "PolicyInput", "Question", "ReplyPlan", "SafetyBlock", "decideBatch"].sort());
    });
  });

  // Rediseño del lote, Fase 2: composición (pura) y ejecutores (con efectos, pero solo sobre las sesiones de siempre). Solo el puente de la Fase 3 los conecta, y apagado por defecto.
  describe("Fase 2 del rediseño del lote: composición pura y ejecutores acotados", () => {
    const COMPOSE = join(root, "src/batch-compose.ts");
    const EXECUTION = join(root, "src/batch-execution.ts");
    const IMPURE = /\bfetch\s*\(|process\.env|supabase|createClient|XMLHttpRequest|require\(|import\(|openai|anthropic|openrouter/i;
    const STATE = /audit|reserve|persist|lease|claim|\brpc\b|recordIgnored|recordReply|recordFailure|foldTurn|releaseTurn|confirmSend|quoteBegin|quoteFinish|quoteRead|quoteClose|sendText|\bctx\b|\bdeps\b|loadCatalog|loadActiveCatalog/i;
    const NONDETERMINISTIC = /Date\.now|new Date|Math\.random|setInterval|writeFile|localStorage|globalThis|\bglobal\./;
    const PRODUCTION_PATH = ["api/kapso/webhook.ts", "src/kapso-webhook.ts", "src/turns.ts", "src/guarded-turn.ts", "src/whatsapp-quote.ts", "src/text-handler.ts", "src/quote-session-turns.ts", "src/quote-session.ts", "src/audit.ts"];

    it("la composición es PURA: solo importa textos y tipos, no toca red, base, entorno, auditoría ni reservas, y no sabe de precios", () => {
      expect(importsOf(COMPOSE).sort()).toEqual(["./batch-policy.js", "./consensus.js", "./quote-session.js", "./text-handler.js"]);
      expect(code(COMPOSE)).not.toMatch(IMPURE);
      expect(code(COMPOSE)).not.toMatch(STATE);
      expect(code(COMPOSE)).not.toMatch(NONDETERMINISTIC);
      expect(code(COMPOSE)).not.toMatch(/priceBs|toCents|totalBs|evaluateSession|catalogFingerprint/);
    });

    it("el ejecutor solo se apoya en el plan, las sesiones de siempre, la máquina de envío por tipos y los textos: nada del webhook, de Kapso, del modelo ni de otros motores", () => {
      expect(importsOf(EXECUTION).sort()).toEqual(["./audit.js", "./batch-compose.js", "./batch-policy.js", "./batch-understanding.js", "./guarded-turn.js", "./quote-session-turns.js", "./quote-session.js", "./reply-guard.js", "./text-handler.js", "./types.js", "./whatsapp-quote.js"]);
      expect(code(EXECUTION)).not.toMatch(IMPURE);
      expect(code(EXECUTION)).not.toMatch(NONDETERMINISTIC);
      expect(importsOf(EXECUTION).some((imported) => /kapso|webhook|^\.\/turns\.js$|study-interpreter|conversation-|crm-outbox|supabase|human-control|attention/.test(imported))).toBe(false);
    });

    it("los precios solo salen del catálogo recargado al cotizar: el ejecutor no los calcula, no los lee del plan y no los toma del modelo", () => {
      const text = code(EXECUTION);
      expect(text).toMatch(/evaluateSession\(read\.items, catalog\)/);
      expect(text).toMatch(/const catalog = await deps\.loadCatalog\(\);/);
      expect(text).not.toMatch(/priceBs|toCents|\.price\b/);
    });

    it("la ruta de Production solo conoce el puente (batch-engine): ni el webhook, ni los turnos, ni la máquina de envío, ni las sesiones importan directamente la comprensión, la política, la composición, los ejecutores ni el modo sombra", () => {
      for (const name of PRODUCTION_PATH) expect(importsOf(join(root, name)).some((imported) => /batch-(understanding|policy|compose|execution|shadow)/.test(imported)), name).toBe(false);
    });

    it("lo único que cambió en las sesiones de siempre es que ciertas utilidades se exportan: el comportamiento es el mismo", () => {
      const turns = source(join(root, "src/quote-session-turns.ts"));
      for (const exported of ["export class SessionUnavailableError", "export const namesOf", "export function needs", "export async function withSession"]) expect(turns).toContain(exported);
    });

    it("solo exportan lo previsto", () => {
      const exportsOf = (path: string) => [...source(path).matchAll(/^export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+(\w+)/gm)].map((match) => match[1]!).sort();
      expect(exportsOf(COMPOSE)).toEqual(["BATCH_TEXTS", "BatchTexts", "ComposeFacts", "ComposeTexts", "ComposedReply", "CoreOverride", "DelegatedReply", "StalePolicy", "UnsafeBatchTextError", "assertSafeBatchTexts", "composeReply", "composeTextsFor"].sort());
      expect(exportsOf(EXECUTION)).toEqual(["BatchTurnInput", "BatchTurnTrace", "DelegationRequest", "PreviewInput", "PreviewState", "SessionSnapshot", "previewPlan", "previewUnderstanding", "probeBatch", "produceBatchReply", "runBatchTurn", "snapshotSession"].sort());
    });
  });

  // Rediseño del lote, Fase 3: la conexión. Apagada por defecto; la ruta de siempre se conserva (text-fragments.ts y mergeProduced siguen en uso como respaldo); el modo sombra no escribe ni responde nada.
  describe("Fase 3 del rediseño del lote: conexión apagada por defecto, respaldo y modo sombra", () => {
    const SHADOW = join(root, "src/batch-shadow.ts");
    const ENGINE = join(root, "src/batch-engine.ts");
    const TURNS = join(root, "src/turns.ts");
    const IMPURE = /\bfetch\s*\(|process\.env|supabase|createClient|XMLHttpRequest|require\(|import\(|openai|anthropic|openrouter/i;
    const STATE = /audit|reserve|persist|lease|claim|\brpc\b|recordIgnored|recordReply|recordFailure|foldTurn|releaseTurn|confirmSend|quoteBegin|quoteFinish|quoteRead|quoteClose|sendText|\bctx\b|\bdeps\b|loadCatalog|loadActiveCatalog/i;
    const NONDETERMINISTIC = /Date\.now|new Date|Math\.random|setInterval|writeFile|localStorage|globalThis|\bglobal\./;

    it("el modo sombra (comparación) es PURO: solo tipos, sin red, base, entorno, auditoría, reservas ni precios", () => {
      expect(importsOf(SHADOW).sort()).toEqual(["./batch-policy.js", "./batch-understanding.js", "./guarded-turn.js", "./quote-session.js"]);
      // todo lo que importa son tipos: no hay ninguna importación con valores
      expect(source(SHADOW)).not.toMatch(/^import\s+(?!type\b)/m);
      expect(code(SHADOW)).not.toMatch(IMPURE);
      expect(code(SHADOW)).not.toMatch(STATE);
      expect(code(SHADOW)).not.toMatch(NONDETERMINISTIC);
      expect(code(SHADOW)).not.toMatch(/priceBs|toCents|totalBs|evaluateSession|catalogFingerprint/);
    });

    it("el puente solo se apoya en el ejecutor, el modo sombra, la comprensión (tipos), la atención selectiva (reconocer cortesías) y los tipos de los turnos: nada del webhook, del modelo ni de la base", () => {
      expect(importsOf(ENGINE).sort()).toEqual(["./attention-filter.js", "./batch-execution.js", "./batch-policy.js", "./batch-shadow.js", "./batch-understanding.js", "./guarded-turn.js", "./quote-session.js", "./turns.js", "./whatsapp-quote.js"]);
      // ./turns.js y ./guarded-turn.js solo como tipos (el puente no puede crear ciclos de valores con los turnos)
      expect(source(ENGINE)).toMatch(/^import type \{ IncomingTurn \} from "\.\/turns\.js";/m);
      expect(source(ENGINE)).toMatch(/^import type \{ Produced, TurnContext \} from "\.\/guarded-turn\.js";/m);
      expect(code(ENGINE)).not.toMatch(IMPURE);
      expect(code(ENGINE)).not.toMatch(NONDETERMINISTIC);
    });

    it("solo los turnos y el cableado de Vercel conocen el puente", () => {
      const importers = files.filter((path) => importsOf(path).some((imported) => /batch-engine/.test(imported))).map(rel).sort();
      expect(importers).toEqual(["api/kapso/webhook.ts", "src/turns.ts"]);
    });

    it("APAGADO POR DEFECTO: sin la variable, vacía, «off» o con un valor desconocido el motor queda apagado; solo «shadow» y «on» lo encienden", () => {
      const turns = source(TURNS);
      // los turnos solo activan el motor si la configuración lo pide explícitamente
      expect(turns).toMatch(/deps\.turns\?\.batchEngine\?\.mode : undefined;/);
      expect(turns).toMatch(/if \(engine === "shadow"\)/);
      expect(turns).toMatch(/else if \(engine === "on"\)/);
      // el cableado solo la rellena desde resolveBatchEngine, y solo con las sesiones de cotización activas
      const webhook = source(join(root, "api/kapso/webhook.ts"));
      expect(webhook).toMatch(/resolveBatchEngine\(process\.env\)/);
      expect(webhook).toMatch(/const batchEngineMode = quoteSessionsEnabled && !replyGuardInvalid \? batchEngineResolution\.mode : undefined;/);
      expect(webhook).toMatch(/\.\.\.\(batchEngineMode \? \{ batchEngine: \{ mode: batchEngineMode \} \} : \{\}\)/);
      // la plantilla de variables la deja EN BLANCO (apagada) y el README la documenta como apagada por defecto
      expect(source(join(root, ".env.example"))).toMatch(/^PLUSMEDIK_BATCH_ENGINE=\r?$/m);
      expect(source(join(root, "README.md"))).toMatch(/PLUSMEDIK_BATCH_ENGINE.*apagada por defecto/);
    });

    it("la ruta de siempre se conserva: text-fragments.ts y mergeProduced siguen en uso (no se eliminan todavía) y el respaldo vuelve a la ruta de siempre", () => {
      const turns = source(TURNS);
      expect(turns).toContain('import { joinStudyFragments } from "./text-fragments.js";');
      expect(turns).toMatch(/import \{ deferClosing, mergeContactTurns, mergeProduced, type BatchUnit \} from "\.\/turn-batch\.js";/);
      expect(turns).toMatch(/units = await joinStudyFragments\(units/);
      expect(turns).toContain("const legacy: TurnProducer");
      // el respaldo: si el motor no puede decidir, o el último mensaje no es texto, el lote completo vuelve a la ruta de siempre
      expect(turns).toMatch(/const verdict = await engineCanDecide\([^)]*\);\s*if \(!verdict\.ok\) \{[\s\S]*?return legacy\(ctx\);/);
      expect(turns).toMatch(/if \(verdict\.cancelled && hasPhotos\) \{[\s\S]*?return legacy\(ctx\);/);
      // el último mensaje ya no decide si interviene el motor: lotes mixtos en cualquier orden
      expect(turns).not.toContain("LAST_MESSAGE_NOT_TEXT");
      expect(source(join(root, "src/turn-batch.ts"))).toContain("export function mergeProduced");
      expect(source(join(root, "src/text-fragments.ts"))).toContain("export async function joinStudyFragments");
    });

    it("el modo sombra no ejecuta nada: solo lee la sesión y el catálogo antes, decide con una función pura después y registra un código", () => {
      const engine = code(ENGINE);
      const shadowPart = engine.slice(engine.indexOf("export async function shadowBefore"));
      expect(shadowPart).not.toMatch(/runBatchTurn|quoteBegin|quoteClose|quoteFinish|recordIgnored|recordFailure|recordReply|foldTurn|reserveSend|confirmSend|sendText|delegate|handle\(|crm|knowledge|interpret\b/i);
      expect(shadowPart).toMatch(/snapshotSession/);
      expect(shadowPart).toMatch(/previewPlan\(/);
      // el motor ejecutor no se usa en la sombra, y la comprensión del modo sombra nunca usa el modelo
      expect(code(join(root, "src/batch-execution.ts"))).toMatch(/modelUse: "never"/);
    });

    // ESTRICTAMENTE de solo lectura: el modo sombra lee con UNA función de la base declarada STABLE (migración 20) y no usa nada que escriba, bloquee filas o venza sesiones.
    it("la lectura del modo sombra usa SOLO la función de solo lectura de la migración 20: ni la lectura que bloquea y vence sesiones, ni la consulta de la última cotización, ni nada que escriba", () => {
      const execution = code(join(root, "src/batch-execution.ts"));
      const slice = (from: string, to: string) => {
        const start = execution.indexOf(from);
        const end = execution.indexOf(to, start + from.length);
        expect(start, from).toBeGreaterThanOrEqual(0);
        expect(end, to).toBeGreaterThan(start);
        return execution.slice(start, end);
      };
      const shadowRead = slice("export async function snapshotSession", "export interface PreviewInput");
      expect(shadowRead).toContain("quoteShadowPeek");
      expect(shadowRead).not.toMatch(/quoteRead|quoteLastStudies|quoteBegin|quoteFinish|quoteClose|recordIgnored|recordFailure|foldTurn|readSession|hadRecentQuote|withSession/);
      const shadowPlan = slice("export interface PreviewInput", "export async function probeBatch");
      expect(shadowPlan).not.toMatch(/persist|audit|quote[A-Z]\w*\(|recordIgnored|hadRecentQuote|readSession|interpret\b/);
      // el repositorio: el método llama a una única función, la de solo lectura
      const audit = code(join(root, "src/audit.ts"));
      const method = audit.slice(audit.indexOf("async quoteShadowPeek"), audit.indexOf("async quoteClose"));
      expect([...method.matchAll(/rpc\("([a-z_]+)"/g)].map((m) => m[1])).toEqual(["plusmedik_quote_shadow_peek"]);
    });

    it("el cableado de Vercel entrega la lectura de solo lectura al repositorio (si no, el modo sombra se saltaría siempre)", () => {
      expect(source(join(root, "api/kapso/webhook.ts"))).toMatch(/quoteShadowPeek: \(\.\.\.args\) => audit\(\)\.quoteShadowPeek!\(\.\.\.args\)/);
    });

    it("el modo sombra se ejecuta fuera de la ruta de escritura: en turns.ts solo se invoca el puente (lectura antes, comparación pura después) y la ruta de siempre produce la respuesta intacta", () => {
      const turns = source(TURNS);
      const shadowBlock = turns.slice(turns.indexOf('if (engine === "shadow") {\r\n      // La ruta de siempre responde') >= 0 ? turns.indexOf('if (engine === "shadow") {\r\n      // La ruta de siempre responde') : turns.indexOf('if (engine === "shadow") {\n      // La ruta de siempre responde'), turns.indexOf('} else if (engine === "on") {'));
      expect(shadowBlock).toContain("const produced = await legacy(ctx);");
      expect(shadowBlock).toMatch(/return produced;/);
      expect(shadowBlock).not.toMatch(/engineReply|runBatchTurn|quoteBegin|quoteClose|absorb|skip\(|persist/);
    });
  });

  it("whatsapp-quote.ts (el flujo de imágenes de siempre) no importa nada de las sesiones; son las sesiones las que reutilizan sus funciones", () => {
    expect(importsOf(join(root, "src/whatsapp-quote.ts")).some((imported) => /quote-session/.test(imported))).toBe(false);
    expect(importsOf(join(root, "src/quote-session-turns.ts"))).toContain("./whatsapp-quote.js");
  });

  it("el módulo puro no toca la red ni la base: solo catálogo, normalización, formato de cotización y clasificación de texto", () => {
    expect(importsOf(join(root, "src/quote-session.ts")).sort()).toEqual(["./catalog-search.js", "./catalog.js", "./consensus.js", "./partial-auto.js", "./study-synonyms.js", "./text-handler.js", "./text-normalize.js", "./types.js", "./whatsapp-quote.js"].sort());
    expect(code(join(root, "src/quote-session.ts"))).not.toMatch(/\bfetch\s*\(|process\.env|supabase|createClient/i);
  });

  it("nada en las sesiones llama a modelos: el análisis solo entra por deps.analyze (el motor de siempre), sin importarlo", () => {
    for (const path of SESSION_FILES) {
      const imports = importsOf(path);
      expect(imports.some((imported) => /(^|\/)(ai|judge|analyze|semantic|openai|openrouter)(\.js)?$/.test(imported) && !/analyze\.js$/.test(imported)), rel(path)).toBe(false);
      expect(code(path), rel(path)).not.toMatch(/\bfetch\s*\(|openai|openrouter|anthropic|process\.env/i);
    }
    // analyze.js solo como tipo (AnalysisResult)
    expect(source(join(root, "src/quote-session-turns.ts"))).toMatch(/import type \{ AnalysisResult \} from "\.\/analyze\.js";/);
  });

  it("los precios y los estudios solo salen del catálogo: ningún precio ni id de estudio escrito en el código de las sesiones", () => {
    for (const path of SESSION_FILES) {
      expect(code(path), rel(path)).not.toMatch(/priceBs\s*[:=]\s*\d/);
      expect(code(path), rel(path)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    }
  });

  it("G5.9: los nombres habituales y abreviaturas son solo FRASES para buscar en el catálogo: el módulo no importa catálogo ni tipos de estudios, y solo lo usa el módulo puro de sesiones", () => {
    expect(importsOf(join(root, "src/study-synonyms.ts"))).toEqual(["./consensus.js"]);
    const synonyms = code(join(root, "src/study-synonyms.ts"));
    expect(synonyms).not.toMatch(/\bfetch\s*\(|process\.env|supabase|openai|priceBs|CatalogStudy|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    for (const path of files) if (/study-synonyms/.test(source(path)) && rel(path) !== "src/study-synonyms.ts") expect(["src/quote-session.ts", "src/catalog-search.ts"]).toContain(rel(path));
    // el resolvedor exacto del catálogo es quien acepta o rechaza cada frase
    expect(code(join(root, "src/quote-session.ts"))).toMatch(/for \(const other of synonymsOf\(key\)\) \{\s*\n\s*const resolution = resolver\.resolve\(observation\(other\)\);/);
  });

  it("G5.9: una cotización por texto solo se cierra con estudios identificados con certeza; sin «listo» nunca se manda un caso a revisión salvo lo que el paciente no puede arreglar escribiendo", () => {
    const turns = code(join(root, "src/quote-session-turns.ts"));
    expect(turns).toMatch(/command === "AUTO" && evaluation\.kind === "REVIEW" && !evaluation\.reasons\.some\(\(reason\) => reason === "STUDY_UNAVAILABLE" \|\| reason === "PRICE_INVALID"\)/);
    expect(turns).toMatch(/if \(extraction\.wantsQuote && extraction\.result\.status === "RESOLVED"\) return await finalize\(ctx, "AUTO", undefined, note\);/);
    // las respuestas por texto no llevan precios: la única cotización sale de formatSessionQuote
    expect(turns.match(/formatSessionQuote\(/g)).toHaveLength(2);
  });

  it("el cierre usa SIEMPRE un catálogo recargado (deps.loadCatalog), nunca el de la caché de textos", () => {
    const turns = code(join(root, "src/quote-session-turns.ts"));
    expect(turns).toMatch(/const catalog = await deps\.loadCatalog\(\);\s*\n\s*const evaluation = evaluateSession\(read\.items, catalog\);/);
  });

  it("el cableado de Vercel exige turnos Y manejador de texto, y no cambia las banderas del motor de recetas", () => {
    const api = source(join(root, "api/kapso/webhook.ts"));
    expect(api).toMatch(/const quoteSessionsEnabled = on\("PLUSMEDIK_QUOTE_SESSIONS"\) && turnsEnabled && textHandlerEnabled;/);
    expect(api).toMatch(/quoteSessions: quoteSessionsEnabled && !replyGuardInvalid/);
    expect(api).toContain('const ENGINE_FLAGS = { semanticPrimary: true, semanticAuto: true, partialAuto: true, handwrittenAuto: "on" } as const;');
  });

  it(".env.example declara únicamente sesiones y preparación anexa, ambas apagadas", () => {
    const example = source(join(root, ".env.example"));
    expect([...example.matchAll(/^(PLUSMEDIK_QUOTE_[A-Z_]*)=(.*)$/gm)].map((match) => [match[1], match[2]!.trim()])).toEqual([
      ["PLUSMEDIK_QUOTE_SESSIONS", ""],
      ["PLUSMEDIK_QUOTE_PREPARATIONS", ""]
    ]);
  });

  it("las sesiones solo mencionan a una persona con el caso YA registrado en el CRM (G5.0): sin la cola configurada, o con algo pendiente, el aviso no promete nada", () => {
    for (const path of SESSION_FILES) expect(code(path), rel(path)).not.toMatch(/HandoffSink|BLOCKED_HANDOFF|createCrmHandoffSink/);
    const turns = code(join(root, "src/quote-session-turns.ts"));
    expect(turns).toMatch(/const registered = outcomes\.length > 0 && outcomes\.every\(\(outcome\) => outcome\.state === "REGISTERED"\);/);
    expect(turns).toMatch(/plain\(registered \? texts\.review_confirmed : texts\.review\)/);
    expect(turns.match(/review_confirmed/g)).toHaveLength(1);
  });
});
