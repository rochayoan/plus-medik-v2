import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// FRONTERAS DEL CÓDIGO de la capa conversacional con modelo (G5.3, análisis estático): el motor de recetas y la cotización no la conocen, solo un adaptador habla con OpenAI, el modelo no
// toca precios ni conocimiento, el texto del paciente no se registra y todo sigue apagado por defecto.

const root = join(__dirname, "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
const source = (path: string) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");
const code = (path: string) => source(path).split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).map((line) => line.replace(/\s\/\/.*$/, "")).join("\n");
const rel = (path: string) => relative(root, path).replaceAll("\\", "/");
const importsOf = (path: string) => [...source(path).matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((match) => match[1]!);
const files = [...walk(join(root, "src")), ...walk(join(root, "api"))].filter((path) => path.endsWith(".ts"));
const MENTION = /conversation-model|conversation-openai|conversation-facts|system-prompt|SYSTEM_PROMPT|BUSINESS_DATA|ConversationModel|resolveConversationModel|CONVERSATION_SECTIONS|PLUSMEDIK_LLM_|OPENAI_CONVERSATION/;

describe("G5.3: dónde puede aparecer la conversación con modelo", () => {
  it("el motor de recetas, los lectores, el juez, el catálogo, la cotización, las sesiones, el conocimiento, los datos por estudio y la cola al CRM NO la conocen", () => {
    const recipe = ["analyze", "partial-auto", "quote-completion", "whatsapp-quote", "catalog", "catalog-shadow", "catalog-semantic-resolver", "supabase-catalog", "ai", "judge", "consensus", "line-groups", "document-signal", "document-function", "study-impact", "visual-risk", "uncertainty", "safety", "pipeline", "image", "cache", "offline", "kapso-webhook", "human-control", "audit", "guarded-turn", "turns", "reply-guard", "quote-session", "quote-session-turns", "knowledge-answers"];
    for (const name of recipe) expect(source(join(root, "src", `${name}.ts`)), name).not.toMatch(MENTION);
    for (const path of files.filter((file) => /^src\/(knowledge|study-facts|crm-outbox)\//.test(rel(file)))) expect(source(path), rel(path)).not.toMatch(MENTION);
  });

  it("solo la propia capa, el manejador de texto (como TIPO) y el cableado de Vercel la nombran", () => {
    const allowed = new Set(["src/conversation-model.ts", "src/conversation-openai.ts", "src/conversation-facts.ts", "src/system-prompt.ts", "src/text-handler.ts", "src/conversation-memory.ts", "src/study-interpreter.ts", "src/agent/verify.ts", "src/agent/openai.ts", "src/agent/shadow.ts", "src/agent/pilot.ts", "api/kapso/webhook.ts"]);
    for (const path of files) {
      if (allowed.has(rel(path))) continue;
      expect(source(path), rel(path)).not.toMatch(MENTION);
    }
    // el manejador de texto solo importa TIPOS de la capa: no depende de ella ni del proveedor en tiempo de ejecución
    expect(source(join(root, "src/text-handler.ts"))).toMatch(/^import type \{ ConversationModel, ConversationOutcome, HistoryEntry, ModelCategory \} from "\.\/conversation-model\.js";$/m);
    expect(importsOf(join(root, "src/text-handler.ts")).filter((imported) => /conversation|openai/i.test(imported))).toEqual(["./conversation-model.js"]);
  });
});

describe("G5.3: el proveedor y la red", () => {
  it("la lógica (conversation-model.ts) no importa ningún proveedor ni toca la red, el entorno ni el motor de recetas", () => {
    // ./provider-error.js (G7) es PURO —sin imports, red, entorno ni registro—: solo convierte un error en códigos de lista blanca para el log; ver la prueba siguiente.
    expect(importsOf(join(root, "src/conversation-model.ts")).sort()).toEqual(["./conversation-facts.js", "./provider-error.js", "./text-normalize.js", "zod"]);
    expect(code(join(root, "src/conversation-model.ts"))).not.toMatch(/\bfetch\s*\(|process\.env|from "openai"|new OpenAI|responses\.create|openrouter|anthropic|supabase|console\./i);
  });

  it("provider-error.ts (causa de un fallo, solo códigos) es puro: sin imports, red, entorno, base de datos ni registro, y nunca lee el mensaje del error", () => {
    const file = join(root, "src/provider-error.ts");
    expect(importsOf(file)).toEqual([]);
    expect(code(file)).not.toMatch(/\bfetch\s*\(|process\.env|console\.|supabase|from "openai"|\.message\b/i);
  });

  it("solo conversation-openai.ts habla con OpenAI en esta capa: respeta el modo offline, no guarda el texto en el proveedor, sin reintentos ocultos y sin la caché de disco", () => {
    const adapter = code(join(root, "src/conversation-openai.ts"));
    expect(adapter).toMatch(/assertModelCallsAllowed\("conversation", "openai", options\.model\);/);
    expect(adapter).toMatch(/store: false/);
    expect(adapter).toMatch(/maxRetries: 0/);
    expect(adapter).not.toMatch(/cachedAiCall|AI_CACHE|appendFile|writeFile/);
    expect(importsOf(join(root, "src/conversation-openai.ts")).sort()).toEqual(["./cache.js", "./conversation-facts.js", "./conversation-model.js", "./offline.js", "./system-prompt.js", "node:crypto", "openai"]);
  });

  it("la capa no toca precios, catálogo ni conocimiento: no importa nada de eso", () => {
    for (const name of ["conversation-model", "conversation-openai"]) {
      for (const imported of importsOf(join(root, "src", `${name}.ts`))) expect(imported, `${name} importa ${imported}`).not.toMatch(/catalog|knowledge|study-facts|quote|analyze|audit|supabase|crm-outbox|turns/);
    }
  });
});

describe("G5.3: privacidad y registro", () => {
  it("el registro de la capa solo lleva códigos y contadores: nunca el texto del paciente ni el de la respuesta", () => {
    const model = code(join(root, "src/conversation-model.ts"));
    for (const call of model.matchAll(/record\(\{[^}]*\}\)/g)) expect(call[0], call[0]).not.toMatch(/\b(text|message|reply|body|sanitized|completion\.text)\s*[,:}]/);
    const handler = code(join(root, "src/text-handler.ts"));
    expect(handler).toMatch(/options\.log\("llm_conversation", \{ outcome: "FALLBACK", reason: "ERROR", category \}\);/);
  });

  it("el mensaje que se envía al modelo se sanea (sin enlaces, correos ni números largos) y el teléfono del paciente nunca forma parte de la entrada", () => {
    const model = code(join(root, "src/conversation-model.ts"));
    expect(model).toMatch(/sanitizeForModel\(text, maxInputChars\)/);
    expect(model).not.toMatch(/turn\.from|contactPhone|\.phone/);
    // G6.0: además del mensaje, solo el ESTADO de la conversación (cantidades), y únicamente con la atención selectiva
    expect(code(join(root, "src/text-handler.ts"))).toMatch(/conversation\.reply\(\{ text: turn\.text \?\? "", category, \.\.\.\(context \? \{ context \} : \{\}\), \.\.\.\(history && history\.length > 0 \? \{ history \} : \{\}\) \}\)/);
    expect(code(join(root, "src/text-handler.ts"))).toMatch(/const context = options\.attention \|\| silences \? await turnContext\?\.memory\?\.\(\{ wait: silences \}\)\.catch\(\(\) => undefined\) : undefined;/);
  });
});

describe("G5.3: apagada por defecto y cableado", () => {
  it("el cableado exige turnos Y manejador de texto, la guarda de respuestas válida, y no cambia las banderas del motor de recetas", () => {
    const api = source(join(root, "api/kapso/webhook.ts"));
    expect(api).toMatch(/const conversationModel = turnsEnabled && textHandlerEnabled \? resolveConversationModel\(process\.env, logLine, \{ responseGuardActive: replyGuard\.enabled && !\("error" in replyGuard\) \}\) : undefined;/);
    expect(api).toMatch(/conversation: conversationModel,/);
    expect(api).toContain('const ENGINE_FLAGS = { semanticPrimary: true, semanticAuto: true, partialAuto: true, handwrittenAuto: "on" } as const;');
  });

  it("la configuración exige la bandera EXPLÍCITA, el modelo (sin valor por defecto), la clave y la guarda de respuestas", () => {
    const config = code(join(root, "src/conversation-openai.ts"));
    expect(config).toMatch(/PLUSMEDIK_LLM_CONVERSATION\?\.trim\(\)\.toLowerCase\(\) !== "on"\) return undefined;/);
    expect(config).toMatch(/OPENAI_CONVERSATION_MODEL/);
    expect(config).not.toMatch(/OPENAI_CONVERSATION_MODEL\s*\?\?\s*["']/);
    expect(config).toMatch(/RESPONSE_GUARD_REQUIRED/);
    expect(config).toMatch(/MISSING_API_KEY/);
    expect(config).toMatch(/log\("llm_conversation_config_invalid", \{ error \}\);/);
  });

  it(".env.example define las variables nuevas y todas están en blanco (apagadas)", () => {
    const example = source(join(root, ".env.example"));
    for (const name of ["PLUSMEDIK_LLM_CONVERSATION", "PLUSMEDIK_LLM_BUSINESS_INFO", "OPENAI_CONVERSATION_MODEL", "OPENAI_CONVERSATION_REASONING", "PLUSMEDIK_LLM_CATEGORIES", "PLUSMEDIK_LLM_TIMEOUT_MS", "PLUSMEDIK_LLM_MAX_OUTPUT_TOKENS", "PLUSMEDIK_LLM_MAX_INPUT_CHARS"]) {
      expect([...example.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))].map((match) => match[1]!.trim()), name).toEqual([""]);
    }
  });

  it("el prompt es una constante de código (src/system-prompt.ts): no existe módulo generado, archivo Markdown ni paso de generación", () => {
    expect(readdirSync(join(root, "src")).filter((name) => /generated|conversation-source/.test(name))).toEqual([]);
    expect(source(join(root, "src/system-prompt.ts"))).toMatch(/^export const SYSTEM_PROMPT = `/m);
  });
});

describe("G5.6: el archivo principal es la única fuente de los datos comerciales, y Supabase la de lo demás", () => {
  it("conversation-facts.ts es puro: solo normaliza texto, sin red, entorno, base de datos ni motor", () => {
    expect(importsOf(join(root, "src/conversation-facts.ts"))).toEqual(["./text-normalize.js"]);
    expect(code(join(root, "src/conversation-facts.ts"))).not.toMatch(/\bfetch\s*\(|process\.env|supabase|openai|lab_tests|price|precio/i);
  });

  it("no queda ningún archivo de datos aparte: agent-config no tiene laboratorio.json ni plantillas", () => {
    const names = readdirSync(join(root, "agent-config"));
    expect(names.filter((name) => /laboratorio|plantilla|pendientes/.test(name))).toEqual([]);
    expect(names.filter((name) => /system-prompt/.test(name))).toEqual([]);
  });

  it("el cableado de los datos exige su propia bandera, y las secciones sin confirmar o vencidas no se envían", () => {
    const config = code(join(root, "src/conversation-openai.ts"));
    expect(config).toMatch(/PLUSMEDIK_LLM_BUSINESS_INFO\?\.trim\(\)\.toLowerCase\(\) === "on"/);
    expect(config).toMatch(/BUSINESS_DATA_PENDING/);
    const model = code(join(root, "src/conversation-model.ts"));
    expect(model).toMatch(/const view = businessInfo \? renderFacts\(sections, new Date\(now\(\)\)\) : undefined;/);
    expect(model).toMatch(/instructionsFor\(options\.prompt, view\?\.block \?\? NO_DATA_BLOCK\)/);
  });

  it("el modelo nunca decide derivaciones ni cotizaciones: el manejador solo recibe un texto, una intención o un reencaminamiento, y el sumidero lo llama el manejador", () => {
    const model = code(join(root, "src/conversation-model.ts"));
    expect(model).not.toMatch(/handoff|HandoffSink|registerCase|crmHandoff|lab_tests|catalog\.|supabase/i);
    const handler = code(join(root, "src/text-handler.ts"));
    expect(handler).toMatch(/if \(allowModel && category === "INFO_REQUEST" && options\.conversation\?\.businessInfo && isCommercialQuestion\(text\)\)/);
  });
});

describe("G5.8: el prompt es código TypeScript (src/system-prompt.ts) y se despliega igual en cualquier hosting", () => {
  it("system-prompt.ts exporta SYSTEM_PROMPT y BUSINESS_DATA como constantes y solo importa un TIPO: sin Node, red, entorno ni archivos", () => {
    const text = source(join(root, "src/system-prompt.ts"));
    expect(text).toMatch(/^export const SYSTEM_PROMPT = `/m);
    expect(text).toMatch(/^export const BUSINESS_DATA: BusinessData = \{/m);
    expect(importsOf(join(root, "src/system-prompt.ts"))).toEqual(["./conversation-facts.js"]);
    expect(text).toMatch(/^import type \{ BusinessData \} from "\.\/conversation-facts\.js";$/m);
    expect(code(join(root, "src/system-prompt.ts"))).not.toMatch(/\bfetch\s*\(|process\.env|node:|readFile|openai|supabase|require\(/i);
  });

  it("el adaptador IMPORTA el prompt directamente (sin leer archivos) y falla cerrado si la plantilla no tiene exactamente un marcador de datos", () => {
    const config = code(join(root, "src/conversation-openai.ts"));
    expect(config).toMatch(/^import \{ BUSINESS_DATA, SYSTEM_PROMPT \} from "\.\/system-prompt\.js";$/m);
    expect(config).not.toMatch(/readFileSync|node:fs|node:path|node:url|PROMPT_FILE|loadConversationSource|process\.cwd/);
    expect(config).toMatch(/if \(source\.prompt\.split\(MARKER\)\.length !== 2\) return fail\("PROMPT_INVALID"\);/);
  });

  it("no queda ningún rastro de la carga por archivo: sin Markdown del prompt, sin cargador, sin variable de entorno de ruta, sin módulos generados", () => {
    expect(readdirSync(join(root, "agent-config")).filter((name) => /system-prompt/.test(name))).toEqual([]);
    expect(readdirSync(join(root, "src")).filter((name) => /conversation-source|generated/.test(name))).toEqual([]);
    for (const path of [...files, join(root, "scripts/agent-config.ts"), join(root, ".env.example"), join(root, "vercel.json"), join(root, ".vercelignore")]) {
      expect(source(path), rel(path)).not.toMatch(/PLUSMEDIK_AGENT_PROMPT_FILE|conversation-source|system-prompt\.es\.md|includeFiles|PROMPT:BEGIN/);
    }
  });

  it("ningún script de instalación ni de compilación necesita generar nada (Docker con package.json copiado antes, Dokku, Railway, Vercel y Node a secas funcionan igual)", () => {
    const pkg = JSON.parse(source(join(root, "package.json"))) as { scripts: Record<string, string> };
    for (const name of ["postinstall", "preinstall", "prepare", "prebuild", "build", "vercel-build", "prestart", "start"]) expect(pkg.scripts[name], name).toBeUndefined();
    expect(Object.values(pkg.scripts).join(" ")).not.toMatch(/prompt --write|prompt --check/);
  });

  it("apagada por defecto: el prompt solo se prepara cuando PLUSMEDIK_LLM_CONVERSATION=on, y los controles de salida siguen en el código del modelo", () => {
    const config = code(join(root, "src/conversation-openai.ts"));
    expect(config.indexOf("buildPromptSource()")).toBeGreaterThan(config.indexOf('!== "on") return undefined;'));
    const model = code(join(root, "src/conversation-model.ts"));
    expect(model).toMatch(/export function guardModelReply/);
    expect(model).not.toMatch(/system-prompt|SYSTEM_PROMPT|BUSINESS_DATA/);
  });

  it("los datos comerciales confirmados no contienen precios, estudios ni derivaciones", () => {
    const data = source(join(root, "src/system-prompt.ts")).split("export const BUSINESS_DATA")[1]!;
    expect(data).not.toMatch(/\b(bs|bob|usd)\b\s*\d|\$\s*\d/i);
    expect(data.match(/estado: "POR_COMPLETAR"/g)).toHaveLength(4);
    expect(data.match(/estado: "CONFIRMADO"/g)).toHaveLength(3);
    expect(data).toContain("Atención general del laboratorio: las 24 horas, todos los días");
  });

  it("no hay .dockerignore, .slugignore ni .gitignore del proyecto que excluyan src/system-prompt.ts", () => {
    for (const name of [".dockerignore", ".slugignore", ".gitignore", ".vercelignore"]) {
      let text = "";
      try { text = source(join(root, name)); } catch { continue; }
      expect(text, name).not.toMatch(/system-prompt/);
      expect(text.split("\n").map((line) => line.trim()), name).not.toContain("src");
    }
  });
});
