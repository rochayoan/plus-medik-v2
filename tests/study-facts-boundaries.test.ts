import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// FRONTERAS DEL CÓDIGO de los datos por estudio (G4.1, análisis estático): el motor de recetas no los conoce, la administración no es accesible para el agente, no hay precios ni
// duplicación del catálogo, y todo sigue apagado por defecto. Además verifica que el cableado de Vercel exponga TODAS las operaciones del repositorio de auditoría.

const root = join(__dirname, "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
const source = (path: string) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");
const code = (path: string) => source(path).split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).map((line) => line.replace(/\s\/\/.*$/, "")).join("\n");
const rel = (path: string) => relative(root, path).replaceAll("\\", "/");
const importsOf = (path: string) => [...source(path).matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((match) => match[1]!);
const files = [...walk(join(root, "src")), ...walk(join(root, "api"))].filter((path) => path.endsWith(".ts"));
const factFiles = files.filter((path) => rel(path).startsWith("src/study-facts/"));
const MENTION = /study-?facts|studyFacts|plusmedik_study_fact|plusmedik_facts_|record_facts|recordFactRefs|quoteLastStudies|quote_last_studies|studyInfoContext|FactRefRecord|STUDY_INFO/i;

describe("G4.1: dónde pueden aparecer los datos por estudio", () => {
  it("el motor de recetas, los lectores, el juez, el catálogo, la cotización y las sesiones de cotización NO los conocen (el flujo de recetas queda intacto)", () => {
    const recipe = ["analyze", "partial-auto", "quote-completion", "whatsapp-quote", "catalog", "catalog-shadow", "catalog-semantic-resolver", "supabase-catalog", "ai", "judge", "consensus", "line-groups", "document-signal", "document-function", "study-impact", "visual-risk", "uncertainty", "safety", "pipeline", "image", "cache", "offline", "kapso-webhook", "human-control", "quote-session", "quote-session-turns", "reply-guard"];
    for (const name of recipe) expect(source(join(root, "src", `${name}.ts`)), name).not.toMatch(MENTION);
  });

  it("solo su módulo, la capa de respuestas, el manejador, los turnos, la auditoría, la configuración de turnos y el cableado de Vercel los nombran", () => {
    const allowed = new Set(["src/knowledge-answers.ts", "src/quote-study-details.ts", "src/text-handler.ts", "src/turns.ts", "src/audit.ts", "src/guarded-turn.ts", "src/batch-execution.ts", "api/kapso/webhook.ts"]);
    for (const path of files) {
      if (allowed.has(rel(path)) || rel(path).startsWith("src/study-facts/")) continue;
      expect(source(path), rel(path)).not.toMatch(MENTION);
    }
  });

  it("la administración (borrador, envío, aprobación, retiro) solo existe en src/study-facts/admin.ts; nada la importa y el índice de lectura no la exporta", () => {
    const adminFunctions = /plusmedik_study_fact_(create_draft|edit_draft|submit|reject|approve|deactivate)/;
    for (const path of files) {
      if (rel(path) === "src/study-facts/admin.ts") continue;
      expect(source(path), rel(path)).not.toMatch(adminFunctions);
      expect(importsOf(path).some((imported) => /study-facts\/admin|(^|\/)admin\.js$/.test(imported) && !/knowledge\/admin/.test(imported)), `${rel(path)} importa la administración`).toBe(false);
    }
    expect(source(join(root, "src/study-facts/admin.ts"))).toMatch(adminFunctions);
    expect(source(join(root, "src/study-facts/index.ts"))).not.toMatch(/export.*admin/i);
  });

  it("el módulo solo importa zod, las utilidades del conocimiento (tipos), la auditoría (RPC) y los tipos del catálogo: nada del motor de recetas, de modelos ni de la red", () => {
    const allowed = new Set(["zod", "./types.js", "./store.js", "./service.js", "../audit.js", "../knowledge/types.js", "../types.js"]);
    for (const path of factFiles) for (const imported of importsOf(path)) expect(allowed.has(imported), `${rel(path)} importa ${imported}`).toBe(true);
    for (const path of factFiles) expect(code(path), rel(path)).not.toMatch(/\bfetch\s*\(|process\.env|openai|openrouter|anthropic/i);
  });

  it("no manejan precios ni duplican el catálogo: ni un campo de precio, ni nombres/alias de estudios guardados (solo el id de lab_tests)", () => {
    for (const path of factFiles) {
      expect(code(path), rel(path)).not.toMatch(/\b(priceBs|price_bs|precio|tarifa)\b/i);
      expect(code(path), rel(path)).not.toMatch(/normalizedName|normalizedAliases|aliases/);
    }
    // el contenido guardado se refiere al estudio solo por labTestId
    expect(source(join(root, "src/study-facts/types.ts"))).toMatch(/labTestId/);
  });

  it("la capa de respuestas jamás lee el precio del catálogo al responder estos temas", () => {
    const answers = code(join(root, "src/knowledge-answers.ts"));
    expect(answers).not.toMatch(/\.priceBs|price_bs/);
  });

  it("el cableado de Vercel enciende los datos por estudio solo con PLUSMEDIK_STUDY_INFO=on Y turnos, manejador de texto y respuestas con conocimiento", () => {
    const api = source(join(root, "api/kapso/webhook.ts"));
    expect(api).toMatch(/const studyInfoEnabled = on\("PLUSMEDIK_STUDY_INFO"\) && turnsEnabled && textHandlerEnabled && knowledgeAnswersEnabled;/);
    expect(api).toMatch(/studyFacts: studyInfoEnabled\s*\?[\s\S]*:\s*undefined/);
    expect(api).toContain('const ENGINE_FLAGS = { semanticPrimary: true, semanticAuto: true, partialAuto: true, handwrittenAuto: "on" } as const;');
  });

  it(".env.example define UNA variable de datos por estudio y está en blanco (apagada)", () => {
    const example = source(join(root, ".env.example"));
    expect([...example.matchAll(/^(PLUSMEDIK_STUDY_[A-Z_]*)=(.*)$/gm)].map((match) => [match[1], match[2]!.trim()])).toEqual([["PLUSMEDIK_STUDY_INFO", ""]]);
  });

  it("la derivación a una persona sigue bloqueada: estos módulos no la usan ni prometen una", () => {
    for (const path of factFiles) expect(code(path), rel(path)).not.toMatch(/handoff|HandoffSink|BLOCKED_HANDOFF/i);
    const texts = source(join(root, "src/knowledge-answers.ts")).split("export const ANSWER_TEXTS")[1]!.split("};")[0]!;
    expect(texts).not.toMatch(/te escribir|te llamar|una persona|asesor|nuestro equipo/i);
  });
});

describe("el repositorio de auditoría completo llega al cableado de Vercel", () => {
  it("el proxy de api/kapso/webhook.ts expone CADA operación de AuditRepository (si falta una opcional, esa función fallaría cerrado en producción sin que ninguna prueba lo notara)", () => {
    const audit = source(join(root, "src/audit.ts"));
    const block = audit.split("export interface AuditRepository {")[1]!.split("\n}\n")[0]!;
    const methods = [...block.matchAll(/^ {2}(\w+)\??\(/gm)].map((match) => match[1]!);
    expect(methods.length).toBeGreaterThanOrEqual(16);
    const api = source(join(root, "api/kapso/webhook.ts"));
    for (const method of methods) expect(api, `falta ${method} en el proxy de auditoría`).toMatch(new RegExp(`\\b${method}:\\s*\\(`));
  });
});
