import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// FRONTERAS DEL CÓDIGO de la derivación al CRM (G5.0, análisis estático): el motor de recetas no la conoce, solo un cliente habla por red, el token y el teléfono no se registran,
// no se escribe nunca en el CRM por otra vía que su contrato público, y todo sigue apagado por defecto.

const root = join(__dirname, "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
const source = (path: string) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");
const code = (path: string) => source(path).split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).map((line) => line.replace(/\s\/\/.*$/, "")).join("\n");
const rel = (path: string) => relative(root, path).replaceAll("\\", "/");
const importsOf = (path: string) => [...source(path).matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((match) => match[1]!);
const files = [...walk(join(root, "src")), ...walk(join(root, "api"))].filter((path) => path.endsWith(".ts"));
const OUTBOX_FILES = walk(join(root, "src/crm-outbox")).filter((path) => path.endsWith(".ts"));
const MENTION = /crm-outbox|crmHandoff|CrmHandoff|CrmOutbox|createCrmHandoffSink|resolveCrmOutbox|plusmedik_crm_outbox|PLUSMEDIK_CRM_|PLUSMEDIK_OUTBOX_KEY/;

describe("G5.0: dónde puede aparecer la derivación al CRM", () => {
  it("el motor de recetas, los lectores, el juez, el catálogo y la cotización de siempre NO la conocen (el flujo de recetas queda intacto)", () => {
    const recipe = ["analyze", "partial-auto", "quote-completion", "whatsapp-quote", "catalog", "catalog-shadow", "catalog-semantic-resolver", "supabase-catalog", "ai", "judge", "consensus", "line-groups", "document-signal", "document-function", "study-impact", "visual-risk", "uncertainty", "safety", "pipeline", "image", "cache", "offline", "kapso-webhook", "human-control"];
    for (const name of recipe) expect(source(join(root, "src", `${name}.ts`)), name).not.toMatch(MENTION);
  });

  it("solo la cola, los turnos, el manejador de texto, las sesiones y el cableado de Vercel la nombran", () => {
    const allowed = new Set(["src/turns.ts", "src/guarded-turn.ts", "src/text-handler.ts", "src/quote-session.ts", "src/quote-session-turns.ts", "src/batch-execution.ts", "api/kapso/webhook.ts", "api/outbox/drain.ts"]);
    for (const path of files) {
      if (allowed.has(rel(path)) || rel(path).startsWith("src/crm-outbox/")) continue;
      expect(source(path), rel(path)).not.toMatch(MENTION);
    }
  });

  it("la cola solo importa lo mínimo: criptografía de Node, el RPC de auditoría, y TIPOS de turnos, texto y catálogo (nada de modelos, lectores ni del motor)", () => {
    const allowed = /^(node:crypto|\.\/[a-z-]+\.js|\.\.\/audit\.js|\.\.\/guarded-turn\.js|\.\.\/text-handler\.js|\.\.\/turns\.js|\.\.\/types\.js|\.\.\/\.\.\/src\/crm-outbox\/[a-z-]+\.js)$/;
    for (const path of OUTBOX_FILES) for (const imported of importsOf(path)) expect(imported, `${rel(path)} → ${imported}`).toMatch(allowed);
    // lo que viene de los turnos, del texto y de la cola de guardas es solo TIPOS: no hay dependencia de ejecución (ni ciclos)
    for (const path of OUTBOX_FILES) {
      for (const match of source(path).matchAll(/^import (?!type)[^\n]*from "(\.\.\/(?:guarded-turn|text-handler|turns|types)\.js)";$/gm)) expect.fail(`${rel(path)} importa en tiempo de ejecución ${match[1]}`);
    }
  });

  it("NINGÚN módulo del motor, los lectores o el catálogo es importado desde la cola", () => {
    for (const path of OUTBOX_FILES) expect(importsOf(path).some((imported) => /(^|\/)(analyze|ai|judge|consensus|catalog|pipeline|partial-auto|whatsapp-quote|kapso-[a-z-]+|quote-session[a-z-]*)(\.js)?$/.test(imported)), rel(path)).toBe(false);
  });
});

describe("G5.0: red, secretos y datos personales", () => {
  it("solo client.ts llama a la red, con redirect manual (el token jamás viaja a un destino redirigido), tiempo límite y sin seguir redirecciones", () => {
    for (const path of OUTBOX_FILES) {
      const hasFetch = /\bfetch(Fn)?\s*\(/.test(code(path));
      if (rel(path) === "src/crm-outbox/client.ts") expect(hasFetch).toBe(true);
      else expect(hasFetch, rel(path)).toBe(false);
    }
    const client = code(join(root, "src/crm-outbox/client.ts"));
    expect(client).toContain('redirect: "manual"');
    expect(client).toMatch(/AbortSignal\.timeout\(/);
    expect(client).toMatch(/method: "POST"/);
    expect(client.match(/\bfetchFn\s*\(/g)).toHaveLength(1);
  });

  it("el cliente solo habla con https (o localhost) y exige un token largo sin espacios", () => {
    const client = code(join(root, "src/crm-outbox/client.ts"));
    expect(client).toMatch(/https:/);
    expect(client).toMatch(/localhost|127\.0\.0\.1/);
    expect(client).toMatch(/MIN_TOKEN_LENGTH/);
  });

  it("nada de la cola escribe en consola ni registra el token, la clave, el teléfono o el cuerpo de la petición", () => {
    for (const path of OUTBOX_FILES) {
      const text = code(path);
      expect(text, rel(path)).not.toMatch(/console\.(log|info|warn|error|debug)/);
      expect(text, rel(path)).not.toMatch(/log\w*\([^)]*(token|authorization|OUTBOX_KEY|contactPhone|bodyText|payload_cipher)/i);
    }
    // el cableado solo registra un CÓDIGO de defecto de configuración
    const config = code(join(root, "src/crm-outbox/config.ts"));
    expect(config).toMatch(/log\("crm_handoff_config_invalid", \{ error \}\);/);
    expect(config).not.toMatch(/log\([^)]*(env\[|token|key\b)/i);
  });

  it("el cuerpo enviado al CRM nunca incluye texto literal del paciente: solo códigos, ids y nombres del catálogo", () => {
    const payload = code(join(root, "src/crm-outbox/payload.ts"));
    expect(payload).not.toMatch(/\.text\b|body\.text|messageText|rawText/);
  });

  it("la carga con el teléfono solo se guarda CIFRADA (AES-256-GCM con el eventId como dato asociado) y el servicio nunca la manda sin descifrar la copia guardada", () => {
    const payload = code(join(root, "src/crm-outbox/payload.ts"));
    expect(payload).toContain("aes-256-gcm");
    expect(payload).toMatch(/setAAD\(/);
    const service = code(join(root, "src/crm-outbox/service.ts"));
    expect(service).toMatch(/encryptPayload\(/);
    expect(service).toMatch(/decryptPayload\(/);
  });

  it("no hay ninguna escritura directa en el CRM: ni su esquema, ni sus tablas, ni su clave de servicio (solo su contrato HTTP público)", () => {
    for (const path of [...OUTBOX_FILES, join(root, "supabase/migrations/20261101000000_plusmedik_crm_outbox.sql")]) {
      const text = code(path);
      expect(text, rel(path)).not.toMatch(/\bcrm\.(messages|conversations|contacts|review|agent)|\bfrom\s+crm\.|\binsert\s+into\s+crm\.|schema\(["']crm["']\)/i);
    }
    expect(code(join(root, "src/crm-outbox/client.ts"))).toMatch(/\/api\/internal\/agent\/review-case/);
  });
});

describe("G5.0: apagado por defecto y cableado", () => {
  it("el cableado exige turnos Y manejador de texto, solo crea el destinatario si la cola está completa, y mantiene la derivación bloqueada si no", () => {
    const api = source(join(root, "api/kapso/webhook.ts"));
    expect(api).toMatch(/const crmOutbox = turnsEnabled && textHandlerEnabled \? resolveCrmOutbox\(process\.env, logLine\) : undefined;/);
    expect(api).toMatch(/crmHandoff: crmOutbox/);
    expect(api).toMatch(/handoff: crmOutbox \? createCrmHandoffSink\(\) : BLOCKED_HANDOFF/);
    expect(api).toContain('const ENGINE_FLAGS = { semanticPrimary: true, semanticAuto: true, partialAuto: true, handwrittenAuto: "on" } as const;');
  });

  it("la configuración exige la bandera EXPLÍCITA y todas las credenciales; sin cualquiera de ellas no hay cola", () => {
    const config = code(join(root, "src/crm-outbox/config.ts"));
    expect(config).toMatch(/PLUSMEDIK_CRM_HANDOFF/);
    expect(config).toMatch(/PLUSMEDIK_CRM_REVIEW_URL/);
    expect(config).toMatch(/PLUSMEDIK_CRM_REVIEW_TOKEN/);
    expect(config).toMatch(/PLUSMEDIK_OUTBOX_KEY/);
    expect(config).toMatch(/KAPSO_PHONE_NUMBER_ID/);
  });

  it("la ruta de reintentos es inerte sin configuración y exige el secreto del cron; vercel.json NO programa nada (activarlo es un paso humano explícito)", () => {
    const route = code(join(root, "api/outbox/drain.ts"));
    expect(route).toMatch(/CRON_SECRET/);
    const vercel = JSON.parse(source(join(root, "vercel.json"))) as { crons?: unknown[] };
    expect(vercel.crons ?? []).toEqual([]);
    expect(source(join(root, "vercel.json"))).not.toMatch(/outbox/);
  });

  it(".env.example define una sola bandera, en blanco, y credenciales vacías", () => {
    const example = source(join(root, ".env.example"));
    for (const name of ["PLUSMEDIK_CRM_HANDOFF", "PLUSMEDIK_CRM_REVIEW_URL", "PLUSMEDIK_CRM_REVIEW_TOKEN", "PLUSMEDIK_OUTBOX_KEY"]) {
      expect([...example.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))].map((match) => match[1]!.trim())).toEqual([""]);
    }
  });

  it("la migración revoca todo a los roles públicos, concede solo a service_role y no expone la carga cifrada ni el arrendamiento", () => {
    const sql = source(join(root, "supabase/migrations/20261101000000_plusmedik_crm_outbox.sql"));
    expect(sql).toMatch(/revoke all on .*plusmedik_crm_outbox.* from .*(anon|authenticated|public)/is);
    expect(sql).toMatch(/revoke all on .*plusmedik_crm_outbox.* from service_role/is);
    const grants = [...sql.matchAll(/grant select \(([^)]*)\)\s+on table public\.plusmedik_crm_outbox to service_role/gi)].map((match) => match[1]!);
    expect(grants).toHaveLength(1);
    expect(grants[0]).not.toMatch(/payload_cipher|lease_owner|lease_fence/);
    expect(sql.match(/security definer/gi)!.length).toBeGreaterThanOrEqual(9);
    expect(sql.match(/set search_path\s*=\s*''/gi)!.length).toBeGreaterThanOrEqual(sql.match(/security definer/gi)!.length);
  });
});
