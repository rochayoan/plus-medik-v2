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
    // src/text-fragments.ts: reconstruye nombres de estudios partidos entre mensajes de un lote de Kapso; solo reutiliza funciones PURAS del módulo de sesiones (interpretar y reconocer comandos) y únicamente lo conecta turns.ts.
    const allowed = new Set(["src/quote-session.ts", "src/quote-session-turns.ts", "src/turns.ts", "src/guarded-turn.ts", "src/audit.ts", "api/kapso/webhook.ts", "src/study-interpreter.ts", "src/study-interpreter-openai.ts", "src/text-fragments.ts"]);
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

  it("whatsapp-quote.ts (el flujo de imágenes de siempre) no importa nada de las sesiones; son las sesiones las que reutilizan sus funciones", () => {
    expect(importsOf(join(root, "src/whatsapp-quote.ts")).some((imported) => /quote-session/.test(imported))).toBe(false);
    expect(importsOf(join(root, "src/quote-session-turns.ts"))).toContain("./whatsapp-quote.js");
  });

  it("el módulo puro no toca la red ni la base: solo catálogo, normalización, formato de cotización y clasificación de texto", () => {
    expect(importsOf(join(root, "src/quote-session.ts")).sort()).toEqual(["./catalog.js", "./consensus.js", "./partial-auto.js", "./study-synonyms.js", "./text-handler.js", "./text-normalize.js", "./types.js", "./whatsapp-quote.js"].sort());
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
