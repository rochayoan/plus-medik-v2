import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// FRONTERAS DEL CÓDIGO de la atención selectiva (G6.0, análisis estático): el filtro es puro y conservador, el motor de recetas y las fotos no lo conocen, la seguridad se evalúa primero, el texto del paciente no se
// registra y todo sigue apagado por defecto.

const root = join(__dirname, "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
const source = (path: string) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");
const code = (path: string) => source(path).split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).map((line) => line.replace(/\s\/\/.*$/, "")).join("\n");
const rel = (path: string) => relative(root, path).replaceAll("\\", "/");
const importsOf = (path: string) => [...source(path).matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((match) => match[1]!);
const files = [...walk(join(root, "src")), ...walk(join(root, "api"))].filter((path) => path.endsWith(".ts"));
const MENTION = /attention-filter|AttentionConfig|resolveAttentionFilter|PLUSMEDIK_ATTENTION|decideAttention|socialOf|createReplyGate|createRepeatTracker|repeatCandidate/;

describe("G6.0: dónde puede aparecer la atención selectiva", () => {
  it("el motor de recetas, los lectores, el juez, el catálogo, la cotización de fotos, el conocimiento, los datos por estudio y la cola al CRM NO la conocen", () => {
    const recipe = ["analyze", "partial-auto", "quote-completion", "whatsapp-quote", "catalog", "catalog-shadow", "catalog-semantic-resolver", "supabase-catalog", "ai", "judge", "consensus", "line-groups", "document-signal", "document-function", "study-impact", "visual-risk", "uncertainty", "safety", "pipeline", "image", "cache", "offline", "kapso-webhook", "human-control", "audit", "reply-guard", "knowledge-answers", "quote-session", "study-synonyms", "conversation-model", "conversation-openai", "conversation-facts", "system-prompt"];
    for (const name of recipe) expect(source(join(root, "src", `${name}.ts`)), name).not.toMatch(MENTION);
    for (const path of files.filter((file) => /^src\/(knowledge|study-facts|crm-outbox)\//.test(rel(file)))) expect(source(path), rel(path)).not.toMatch(MENTION);
  });

  it("solo el propio módulo, el manejador de texto, los turnos, la configuración de turnos, el productor de texto de las sesiones y el cableado de Vercel la nombran", () => {
    const allowed = new Set(["src/attention-filter.ts", "src/text-handler.ts", "src/turns.ts", "src/guarded-turn.ts", "src/quote-session-turns.ts", "api/kapso/webhook.ts"]);
    for (const path of files) {
      if (allowed.has(rel(path))) continue;
      expect(source(path), rel(path)).not.toMatch(MENTION);
    }
  });

  it("el productor de FOTOS de las sesiones no usa el filtro: sessionImageProducer no mira la puerta ni el filtro", () => {
    const turns = source(join(root, "src/quote-session-turns.ts"));
    const image = turns.slice(turns.indexOf("export function sessionImageProducer"), turns.indexOf("// ───────────────────────────── texto"));
    expect(image.length).toBeGreaterThan(500);
    expect(image).not.toMatch(/attention|socialOf|gate|decideAttention/);
    // y el filtro de repeticiones solo mira textos
    expect(code(join(root, "src/turns.ts"))).toMatch(/if \(!attention \|\| turn\.kind !== "TEXT" \|\| typeof turn\.text !== "string"\) return false;/);
  });
});

describe("G6.0: el filtro es puro, determinista y no guarda texto", () => {
  it("attention-filter.ts no toca la red, la base, el entorno de modelos ni el registro, y solo importa normalización, crypto y un TIPO del manejador de texto", () => {
    const path = join(root, "src/attention-filter.ts");
    expect(importsOf(path).sort()).toEqual(["./text-handler.js", "./text-normalize.js", "node:crypto"]);
    expect(source(path)).toMatch(/^import type \{ TextCategory \} from "\.\/text-handler\.js";$/m);
    expect(code(path)).not.toMatch(/\bfetch\s*\(|supabase|openai|audit|anthropic|console\.|writeFile|appendFile|localStorage|JSON\.stringify\(text/i);
    // el entorno solo se lee en la función de configuración, con nombres propios
    const env = [...code(path).matchAll(/env\.([A-Z_]+)/g)].map((match) => match[1]);
    expect([...new Set(env)].sort()).toEqual(["PLUSMEDIK_ATTENTION_FILTER", "PLUSMEDIK_ATTENTION_REPEAT_SECONDS", "PLUSMEDIK_ATTENTION_SETTLE_MS"]);
  });

  it("de un mensaje solo se guarda una huella SHA-256 truncada (nunca el texto ni el teléfono), en memoria y acotada", () => {
    const filter = code(join(root, "src/attention-filter.ts"));
    expect(filter).toMatch(/createHash\("sha256"\)\.update\(`\$\{from\}\\u0000\$\{plain\(text\.slice\(0, 1500\)\)\}`\)\.digest\("hex"\)\.slice\(0, 24\)/);
    expect(filter).toMatch(/createHash\("sha256"\)\.update\(from\)\.digest\("hex"\)\.slice\(0, 24\)/);
    expect(filter).toMatch(/maxEntries \?\? 2000/);
  });

  it("la seguridad se evalúa PRIMERO: lo médico y pedir a una persona devuelven PROCESS antes de mirar si el mensaje es social", () => {
    const filter = code(join(root, "src/attention-filter.ts"));
    const decide = filter.slice(filter.indexOf("export function decideAttention"), filter.indexOf("// ───────────────────────────── repeticiones"));
    expect(decide.indexOf('category === "MEDICAL" || category === "HUMAN_REQUEST"')).toBeGreaterThan(-1);
    expect(decide.indexOf('category === "MEDICAL" || category === "HUMAN_REQUEST"')).toBeLessThan(decide.indexOf("socialOf(text)"));
    // y lo repetido nunca incluye lo médico ni lo humano
    expect(filter).toMatch(/if \(category === "MEDICAL" \|\| category === "HUMAN_REQUEST" \|\| isSessionShaped\) return false;/);
  });

  it("el vocabulario social no contiene palabras de solicitud (estudios, precios, horarios, urgencias, personas)", () => {
    const filter = source(join(root, "src/attention-filter.ts"));
    const vocab = [...filter.matchAll(/const (?:GREETING_VOCAB|COURTESY_VOCAB|ANCHOR|AFFIRMATIVE) = new Set\(\[([^\]]*)\]\)/g)].flatMap((match) => [...match[1]!.matchAll(/"([^"]+)"/g)].map((word) => word[1]!));
    expect(vocab.length).toBeGreaterThan(80);
    for (const word of vocab) expect(word, word).not.toMatch(/^(cotiz|precio|cuesta|costo|estudio|analisis|examen|receta|horario|urgen|dolor|persona|asesor|ayudar|ayudame|necesito|quiero|quisiera|hemograma|glucosa|duele|fiebre|medic)/);
  });
});

describe("G6.1: el silencio no es una confirmación", () => {
  it("ninguna cortesía puede cerrar una solicitud: socialOf no tiene 'afirmación' y las sesiones no la consultan", () => {
    expect(code(join(root, "src/attention-filter.ts"))).not.toMatch(/affirmative|AFFIRMATIVE/i);
    expect(code(join(root, "src/quote-session-turns.ts"))).not.toMatch(/socialOf|affirmative/);
  });

  it("las palabras que confirman en las sesiones no incluyen agradecimientos ni acuses (gracias, ok, okay, dale, vale, perfecto)", () => {
    const sessions = source(join(root, "src/quote-session.ts"));
    const sets = [...sessions.matchAll(/const (?:YES_CORE|YES_EXTRA|NO_EXTRA) = new Set\(\[([^\]]*)\]\)/g)].flatMap((match) => [...match[1]!.matchAll(/"([^"]+)"/g)].map((word) => word[1]!));
    expect(sets.length).toBeGreaterThan(30);
    for (const word of ["gracias", "ok", "okay", "dale", "vale", "perfecto", "muchas"]) expect(sets, word).not.toContain(word);
    expect(sessions).not.toMatch(/YES_PHRASES = \/\^\(\?:\(\?:si\|ok/);
  });

  it("lo ignorado cierra solo el turno (NO_REPLY): el manejador no llama a ninguna operación de la solicitud", () => {
    const handler = code(join(root, "src/text-handler.ts"));
    const tail = handler.slice(handler.lastIndexOf("return async (turn, context) => {"));
    const ignored = tail.slice(tail.indexOf('if (decision.action === "IGNORE")'), tail.indexOf("return route(turn, category, context, true);"));
    expect(ignored).toMatch(/return undefined;/);
    expect(ignored).not.toMatch(/quote|session|close|cancel|audit|memory/i);
  });
});

describe("G6.0: el orden del procesamiento", () => {
  it("el manejador de texto aplica el filtro ANTES de enrutar (sin conocimiento, sin modelo, sin derivación para lo descartado) y registra solo códigos", () => {
    const handler = code(join(root, "src/text-handler.ts"));
    const tail = handler.slice(handler.lastIndexOf("return async (turn, context) => {"));
    expect(tail.indexOf("decideAttention(turn.text, category)")).toBeGreaterThan(-1);
    expect(tail.indexOf("decideAttention(turn.text, category)")).toBeLessThan(tail.indexOf("return route(turn, category, context, true);"));
    expect(tail).toMatch(/options\.log\("attention_filter", \{ action: "IGNORE", reason: decision\.reason, category \}\);/);
    expect(tail).toMatch(/if \(options\.attention\) \{/);
  });

  it("las repeticiones se descartan ANTES de reclamar el turno (antes de beginTurn): no escriben en la base", () => {
    const turns = code(join(root, "src/turns.ts"));
    const loop = turns.slice(turns.indexOf("export async function processTurns"));
    expect(loop.indexOf("isRepeatedMessage(turn, deps)")).toBeGreaterThan(-1);
    expect(loop.indexOf("isRepeatedMessage(turn, deps)")).toBeLessThan(loop.indexOf("beginTurn(refOf(turn), deps)"));
    expect(loop).toMatch(/deps\.log\("attention_filter", \{ action: "IGNORE", reason: "REPEAT" \}\);/);
  });

  it("el número del mensaje en la puerta se toma al inicio del productor, de forma síncrona, con el turno que dio la base", () => {
    const turns = code(join(root, "src/quote-session-turns.ts"));
    expect(turns).toMatch(/return async \(ctx\): Promise<Produced> => \{\n    const text = turn\.text \?\? "";\n    if \(attention\) ticket = attention\.gate\.enter\(turn\.from, ctx\.seq\);/);
    expect(code(join(root, "src/guarded-turn.ts"))).toMatch(/turnSeq = claim\.seq;/);
  });

  it("todo lo que va al manejador de texto retira el número de la puerta (no silencia confirmaciones anteriores)", () => {
    const turns = code(join(root, "src/quote-session-turns.ts"));
    expect(turns.match(/delegate\(\)\(ctx\)/g)).toHaveLength(1);
    expect(turns).toMatch(/const handOver = \(ctx: TurnContext\): Promise<Produced> => \{\n    retire\(\);\n    return delegate\(\)\(ctx\);/);
  });
});

describe("G6.0: el contexto que recibe el modelo", () => {
  it("ConversationContext son solo cantidades y banderas: ningún campo de texto, nombre ni identificador", () => {
    const model = source(join(root, "src/conversation-model.ts"));
    const body = /export interface ConversationContext \{([^}]*)\}/.exec(model)![1]!;
    const fields = [...body.matchAll(/^\s+(\w+): (\w+);/gm)].map((match) => [match[1], match[2]]);
    expect(fields).toEqual([["openRequest", "boolean"], ["openStudies", "number"], ["openDoubt", "boolean"], ["recentQuoteStudies", "number"]]);
    const memory = /export interface ConversationMemory \{([^}]*)\}/.exec(source(join(root, "src/turns.ts")))![1]!;
    expect([...memory.matchAll(/^\s+(\w+): (\w+);/gm)].map((match) => [match[1], match[2]])).toEqual(fields);
  });

  it("la memoria reutiliza la sesión y la última cotización de siempre (quoteRead y quoteLastStudies): no hay tabla, RPC ni migración nueva", () => {
    const turns = code(join(root, "src/turns.ts"));
    expect(turns).toMatch(/audit\.quoteRead\?\.\(runId, lease\)/);
    expect(turns).toMatch(/audit\.quoteLastStudies\?\.\(runId, lease,/);
    expect(turns).toMatch(/deps\.turns\?\.attention && deps\.turns\.quoteSessions/);
    expect(readdirSync(join(root, "supabase/migrations")).filter((name) => name.endsWith(".sql"))).toHaveLength(16);
    expect(code(join(root, "src/attention-filter.ts"))).not.toMatch(/plusmedik_|rpc\(/);
  });

  it("el modelo solo recibe el estado si la atención selectiva está encendida, y el estado se calcula al pedirlo (no en cada mensaje)", () => {
    const handler = code(join(root, "src/text-handler.ts"));
    expect(handler).toMatch(/const context = options\.attention \? await turnContext\?\.memory\?\.\(\)\.catch\(\(\) => undefined\) : undefined;/);
    expect(code(join(root, "src/turns.ts"))).toMatch(/async memory\(\): Promise<ConversationMemory \| undefined> \{/);
  });
});

describe("G6.0: apagada por defecto y cableado", () => {
  it("el cableado exige turnos Y manejador de texto, informa un código si la configuración es inválida y no cambia las banderas del motor de recetas", () => {
    const api = source(join(root, "api/kapso/webhook.ts"));
    expect(api).toMatch(/const attentionFilter = turnsEnabled && textHandlerEnabled \? resolveAttentionFilter\(process\.env\) : \(\{ enabled: false \} as const\);/);
    expect(api).toMatch(/logLine\("attention_filter_config_invalid", \{ error: attentionFilter\.error \}\);/);
    expect(api).toContain("attention: attentionConfig,");
    expect(api).toContain("attention: attentionConfig !== undefined,");
    expect(api).toContain('const ENGINE_FLAGS = { semanticPrimary: true, semanticAuto: true, partialAuto: true, handwrittenAuto: "on" } as const;');
  });

  it("la bandera exige el valor exacto «on» y una configuración inválida deja el filtro apagado", () => {
    const filter = code(join(root, "src/attention-filter.ts"));
    expect(filter).toMatch(/PLUSMEDIK_ATTENTION_FILTER\?\.trim\(\)\.toLowerCase\(\) !== "on"\) return \{ enabled: false \};/);
    expect(filter).toMatch(/return \{ enabled: true, error: "INVALID_REPEAT_SECONDS" \};/);
    expect(filter).toMatch(/return \{ enabled: true, error: "INVALID_SETTLE_MS" \};/);
  });

  it(".env.example define las tres variables nuevas y todas están en blanco (apagadas / valores por defecto)", () => {
    const example = source(join(root, ".env.example"));
    for (const name of ["PLUSMEDIK_ATTENTION_FILTER", "PLUSMEDIK_ATTENTION_REPEAT_SECONDS", "PLUSMEDIK_ATTENTION_SETTLE_MS"]) {
      expect([...example.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))].map((match) => match[1]!.trim()), name).toEqual([""]);
    }
  });
});
