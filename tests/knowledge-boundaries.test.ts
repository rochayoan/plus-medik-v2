import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// FRONTERAS DEL CÓDIGO (análisis estático del repositorio): el conocimiento del laboratorio está separado de recetas, cotizaciones, precios e imágenes; el agente en ejecución no
// puede aprobar conocimiento; y G3.0 no conectó nada al webhook ni activó banderas.

const root = join(__dirname, "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const source = (path: string) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");
const code = (path: string) => source(path).split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).map((line) => line.replace(/\s\/\/.*$/, "")).join("\n");
const rel = (path: string) => relative(root, path).replaceAll("\\", "/");
const importsOf = (path: string) => [...source(path).matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((match) => match[1]!);

const srcFiles = walk(join(root, "src")).filter((path) => path.endsWith(".ts"));
const knowledge = srcFiles.filter((path) => rel(path).startsWith("src/knowledge/"));
const knowledgeRead = knowledge.filter((path) => !rel(path).endsWith("/admin.ts"));
const outsideKnowledge = srcFiles.filter((path) => !rel(path).startsWith("src/knowledge/"));
const apiFiles = walk(join(root, "api")).filter((path) => path.endsWith(".ts"));

describe("separación entre conocimiento y recetas/cotizaciones", () => {
  it("el módulo de conocimiento solo importa sus propios archivos, la lectura RPC de la auditoría, los tipos del catálogo y zod: nada del motor de recetas", () => {
    const allowedRead = new Set(["./types.js", "./schedule.js", "./store.js", "./service.js", "../audit.js", "../types.js", "zod"]);
    for (const path of knowledgeRead) for (const imported of importsOf(path)) expect(allowedRead.has(imported), `${rel(path)} importa ${imported}`).toBe(true);
    for (const imported of importsOf(join(root, "src/knowledge/admin.ts"))) expect(["../audit.js", "./types.js"].includes(imported), `admin.ts importa ${imported}`).toBe(true);
  });

  it("el motor de recetas, la cotización y los lectores de imágenes no conocen el módulo de conocimiento", () => {
    const recipe = ["analyze", "partial-auto", "quote-completion", "whatsapp-quote", "catalog", "catalog-shadow", "catalog-semantic-resolver", "supabase-catalog", "ai", "judge", "consensus", "line-groups", "document-signal", "document-function", "study-impact", "visual-risk", "uncertainty", "safety", "pipeline", "image", "cache", "offline"];
    for (const name of recipe) expect(source(join(root, "src", `${name}.ts`)), name).not.toMatch(/knowledge/i);
  });

  it("el conocimiento no maneja precios: ningún campo, columna ni lectura de precios en su código", () => {
    for (const path of knowledge) expect(code(path), rel(path)).not.toMatch(/\b(priceBs|price_bs|precio|tarifa)\b/i);
    const migration = readFileSync(join(root, "supabase/migrations/20261027000000_plusmedik_knowledge.sql"), "utf8").split("\n").filter((line) => !/^\s*--/.test(line)).join("\n");
    expect(migration).not.toMatch(/\bprice_bs\b/i);
    expect(migration).not.toMatch(/create table[^;]*\b(price|precio|tarifa|cost)\w*/i);
  });

  it("del catálogo solo se usan id, nombre y estado activo (no se duplica ni se almacena ningún catálogo paralelo)", () => {
    const service = code(join(root, "src/knowledge/service.ts"));
    expect(service).toContain('Pick<CatalogStudy, "id" | "name" | "active">');
    expect(service).not.toMatch(/\.(priceBs|code|normalizedName|normalizedAliases|category|sampleType)\b/);
  });
});

describe("el agente en ejecución no puede aprobar su propio conocimiento", () => {
  const adminFunctions = /plusmedik_kb_(create_draft|edit_draft|submit|reject|approve|deactivate|restore)/;

  it("solo el cliente de administración (src/knowledge/admin.ts) nombra las funciones de escritura; nada en src/ ni en api/ lo importa", () => {
    for (const path of [...outsideKnowledge, ...knowledgeRead, ...apiFiles]) {
      expect(source(path), rel(path)).not.toMatch(adminFunctions);
      expect(importsOf(path).some((imported) => /knowledge\/admin|\.\/admin\.js/.test(imported)), `${rel(path)} importa admin`).toBe(false);
    }
    expect(source(join(root, "src/knowledge/admin.ts"))).toMatch(adminFunctions);
  });

  it("el índice de lectura no exporta la administración", () => {
    expect(source(join(root, "src/knowledge/index.ts"))).not.toMatch(/export[^\n]*admin\.js/i);
  });
});

describe("G3.1A: dónde puede aparecer el conocimiento y que sigue apagado", () => {
  it("solo el manejador de texto, la capa de respuestas, el productor de turnos (rastro), la auditoría (rastro) y el cableado de Vercel lo mencionan; el resto del webhook y del motor no", () => {
    // G4.2: el apéndice de cotización lee conocimiento clínico aprobado, pero no conoce su administración.
    // API web de médicos: lee solo la preparación aprobada y vigente (misma lectura que el apéndice de WhatsApp); no conoce la administración.
    const allowed = new Set(["src/text-handler.ts", "src/knowledge-answers.ts", "src/quote-preparation.ts", "src/turns.ts", "src/audit.ts", "api/kapso/webhook.ts", "src/web-quote.ts", "src/web-quote-runtime.ts"]);
    for (const path of [...outsideKnowledge, ...apiFiles]) {
      // G4.1: el módulo de datos por estudio reutiliza tipos y reglas del conocimiento (y lo dice); su propia frontera se prueba en study-facts-boundaries.test.ts
      if (allowed.has(rel(path)) || rel(path).startsWith("src/study-facts/")) continue;
      expect(source(path), rel(path)).not.toMatch(/knowledge/i);
    }
  });

  it("la capa de respuestas solo importa la lectura del conocimiento, la normalización de texto y los tipos del catálogo: ni administración ni motor de recetas", () => {
    const imports = importsOf(join(root, "src/knowledge-answers.ts")).sort();
    // G4.1 agrega la lectura de los datos por estudio (también sin administración)
    expect(imports).toEqual(["./knowledge/index.js", "./study-facts/index.js", "./text-normalize.js", "./types.js"]);
  });

  it("el cableado de Vercel solo construye el servicio de conocimiento si PLUSMEDIK_KNOWLEDGE_ANSWERS vale 'on' (y si no, `knowledge` queda indefinido); el servicio se crea de forma perezosa", () => {
    const api = source(join(root, "api/kapso/webhook.ts"));
    expect(api).toMatch(/const knowledgeAnswersEnabled = on\("PLUSMEDIK_KNOWLEDGE_ANSWERS"\);/);
    expect(api).toMatch(/knowledge: knowledgeAnswersEnabled\s*\?[\s\S]*lazyKnowledge\([\s\S]*:\s*undefined/);
    expect(api).toContain('on("PLUSMEDIK_TEXT_HANDLER")');
  });

  it(".env.example define UNA sola variable nueva de conocimiento y está en blanco (apagada)", () => {
    const example = source(join(root, ".env.example"));
    expect([...example.matchAll(/^([A-Z_]*(?:KNOWLEDGE|PLUSMEDIK_KB)[A-Z_]*)=(.*)$/gm)].map((match) => [match[1], match[2]!.trim()])).toEqual([["PLUSMEDIK_KNOWLEDGE_ANSWERS", ""]]);
    for (const name of ["PLUSMEDIK_TURNS", "PLUSMEDIK_TEXT_HANDLER", "PLUSMEDIK_HUMAN_CONTROL", "REQUIRE_AUDIT_GUARD"]) expect(example).toMatch(new RegExp(`^${name}=\s*$`, "m"));
  });

  it("el webhook, los turnos de imagen y el motor de recetas no cambiaron de contrato: sigue habiendo un único claim/reserva/envío (guarded-turn no conoce el conocimiento)", () => {
    for (const name of ["guarded-turn", "kapso-webhook", "human-control", "audit-recovery", "whatsapp-quote"]) expect(source(join(root, "src", `${name}.ts`)), name).not.toMatch(/knowledge/i);
  });
});
