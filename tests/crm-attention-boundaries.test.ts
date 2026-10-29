import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// FRONTERAS DEL CÓDIGO del control de atención desde el CRM (Fase 1, análisis estático): el token es exclusivo, la pausa manual no simula mensajes de WhatsApp, la migración es aditiva y de
// acceso restringido, el registro solo lleva códigos y todo sigue apagado por defecto.

const root = join(__dirname, "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
const source = (path: string) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");
const code = (path: string) => source(path).split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*|--)/.test(line)).map((line) => line.replace(/\s\/\/.*$/, "")).join("\n");
const rel = (path: string) => relative(root, path).replaceAll("\\", "/");
const importsOf = (path: string) => [...source(path).matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((match) => match[1]!);
const files = [...walk(join(root, "src")), ...walk(join(root, "api"))].filter((path) => path.endsWith(".ts"));
const MENTION = /crm-attention|createCrmAttention|handleCrmAttention|resolveCrmAttention|PLUSMEDIK_AGENT_CONTROL(?:_TOKEN)?\b|plusmedik_attention_crm_action/;
const MIGRATION = join(root, "supabase/migrations/20261103000000_plusmedik_crm_attention_control.sql");
// Fase 2.3 (control acotado): el webhook usa UNA sola función del módulo, para saber a qué contactos cubre la lista autorizada. Todo lo demás del control del CRM sigue sin existir allí.
const SCOPED_IMPORT = 'import { resolveScopedContactControl } from "../../src/crm-attention.js";';
const webhookWithoutScopedUse = () => code(join(root, "api/kapso/webhook.ts")).replace(SCOPED_IMPORT, "").replace("resolveScopedContactControl(process.env)", "");

describe("Fase 1: dónde puede aparecer el control de atención del CRM", () => {
  it("solo el módulo propio y las dos rutas de Vercel lo nombran: el control humano, la auditoría y el motor no lo conocen (el webhook solo importa el resolutor del modo acotado)", () => {
    const allowed = new Set(["src/crm-attention.ts", "api/internal/crm/attention/status.ts", "api/internal/crm/attention/action.ts", "api/kapso/webhook.ts"]);
    for (const path of files) {
      if (allowed.has(rel(path))) continue;
      expect(source(path), rel(path)).not.toMatch(MENTION);
    }
    const webhook = source(join(root, "api/kapso/webhook.ts"));
    expect(importsOf(join(root, "api/kapso/webhook.ts")).filter((path) => path.includes("crm-attention"))).toEqual(["../../src/crm-attention.js"]);
    expect(webhook).toContain(SCOPED_IMPORT);
    expect(webhookWithoutScopedUse()).not.toMatch(MENTION);
  });

  it("existen exactamente las dos rutas del contrato y cada una exporta POST", () => {
    const routes = files.filter((path) => rel(path).startsWith("api/internal/crm/")).map(rel).sort();
    expect(routes).toEqual(["api/internal/crm/attention/action.ts", "api/internal/crm/attention/status.ts"]);
    expect(source(join(root, "api/internal/crm/attention/status.ts"))).toMatch(/createCrmAttentionRoute\("status"\)[\s\S]*export const POST = handler;/);
    expect(source(join(root, "api/internal/crm/attention/action.ts"))).toMatch(/createCrmAttentionRoute\("action"\)[\s\S]*export const POST = handler;/);
  });

  it("el módulo solo importa criptografía de Node, el cliente RPC de la auditoría y el control de atención humana", () => {
    expect(importsOf(join(root, "src/crm-attention.ts")).sort()).toEqual(["./audit.js", "./human-control.js", "node:crypto"]);
  });
});

describe("Fase 1: el token es exclusivo y se compara en tiempo constante", () => {
  const module = code(join(root, "src/crm-attention.ts"));
  it("se compara con timingSafeEqual sobre hashes; nunca con ===, ==, includes ni startsWith", () => {
    expect(module).toMatch(/timingSafeEqual\(digest\(provided\), digest\(expected\)\)/);
    expect(module).not.toMatch(/\b(provided|token|header)\s*(===|!==|==|!=)/);
    expect(module).not.toMatch(/\.(includes|startsWith|endsWith|localeCompare)\(\s*(config\.)?token/);
  });
  it("no se reutiliza la llave de servicio, la clave de la cola al CRM ni credenciales de Kapso: el único secreto ajeno que lee es la clave HMAC de contactos", () => {
    const envNames = [...module.matchAll(/env\.([A-Z_]+)/g)].map((match) => match[1]);
    expect([...new Set(envNames)].sort()).toEqual(["KAPSO_PHONE_NUMBER_ID", "PLUSMEDIK_AGENT_CONTROL", "PLUSMEDIK_AGENT_CONTROL_PHONES", "PLUSMEDIK_AGENT_CONTROL_TOKEN", "PLUSMEDIK_CONTACT_HMAC_KEY", "PLUSMEDIK_HUMAN_CONTROL"]);
    expect(module).not.toMatch(/SERVICE_ROLE|OUTBOX_KEY|CRM_REVIEW_TOKEN|KAPSO_API_KEY|WEBHOOK_SECRET|CRON_SECRET/);
  });
  it("las cabeceras impiden cacheo y se rechazan llamadas de navegador y HTTP plano (salvo localhost)", () => {
    expect(module).toContain('"cache-control": "no-store"');
    expect(module).toMatch(/request\.headers\.has\("origin"\) \|\| request\.headers\.has\("sec-fetch-site"\) \|\| request\.headers\.has\("sec-fetch-mode"\)/);
    expect(module).toMatch(/proto !== "https" && !isLocalHost\(url\.hostname\)/);
  });
  it("la autenticación ocurre ANTES de leer el cuerpo y antes de cualquier consulta a la base", () => {
    const handler = module.slice(module.indexOf("export async function handleCrmAttention"));
    expect(handler.indexOf("tokenMatches(provided, config.token)")).toBeGreaterThan(-1);
    expect(handler.indexOf("tokenMatches(provided, config.token)")).toBeLessThan(handler.indexOf("await request.text()"));
    expect(handler.indexOf("await request.text()")).toBeLessThan(handler.indexOf("deps.repository()"));
    expect(handler.indexOf("if (!config)")).toBeLessThan(handler.indexOf("tokenMatches("));
  });
});

describe("Fase 1: la pausa manual es real, no un mensaje de WhatsApp simulado", () => {
  it("ni el módulo del agente ni la migración llaman a register_human_message ni usan el tipo HUMAN_BUSINESS_APP para la pausa del CRM", () => {
    expect(code(join(root, "src/crm-attention.ts"))).not.toMatch(/registerHumanMessage|register_human_message|HUMAN_BUSINESS_APP|business_app/);
    const sql = code(MIGRATION);
    expect(sql).not.toMatch(/plusmedik_attention_register_human_message\s*\(/);
    expect(sql.replace(/'HUMAN_BUSINESS_APP',\s*'UNKNOWN_ORIGIN'/g, "")).not.toMatch(/'HUMAN_BUSINESS_APP'/);
    expect(sql).toContain("pause_source = 'crm_server'");
    expect(sql).toMatch(/v_key := 'crm:' \|\| p_operation_id;/);
  });
  it("el motivo y la acción se validan como códigos cerrados: el texto libre del CRM no entra", () => {
    const sql = code(MIGRATION);
    expect(sql).toMatch(/p_reason is distinct from \(case p_action when 'pause' then 'CRM_MANUAL_PAUSE' else 'CRM_MANUAL_RESUME' end\)/);
    expect(sql).toMatch(/p_actor !~ '\^crm:\[A-Za-z0-9_-\]\{1,59\}\$'/);
    const module = code(join(root, "src/crm-attention.ts"));
    expect(module).toMatch(/const STATUS_KEYS = \["contactPhone", "phoneNumberId"\];/);
    expect(module).toMatch(/const ACTION_KEYS = \["action", "actor", "contactPhone", "operationId", "phoneNumberId", "reasonCode"\];/);
  });
  it("una confirmación solo se construye con un resultado definitivo de la base: confirmed:true aparece una sola vez, tras repository.act", () => {
    const module = code(join(root, "src/crm-attention.ts"));
    expect([...module.matchAll(/confirmed: true/g)]).toHaveLength(1);
    expect(module.indexOf("await repository.act(")).toBeLessThan(module.indexOf("confirmed: true"));
    expect(module).toMatch(/throw new AuditWriteError\("REJECTED"\);/);
  });
});

describe("Fase 1: la migración 15 es aditiva y de acceso restringido", () => {
  const sql = code(MIGRATION);
  it("es la última, no borra ni vacía nada, no toca el esquema crm ni las tablas de otras capas", () => {
    expect(readdirSync(join(root, "supabase/migrations")).filter((name) => name.endsWith(".sql")).sort().at(-1)).toBe("20261103000000_plusmedik_crm_attention_control.sql");
    expect(sql).not.toMatch(/\b(drop table|drop function|delete from|truncate|drop schema|alter table public\.plusmedik_audit_runs)\b/i);
    expect(sql).not.toMatch(/\bcrm\./i);
    expect(sql).not.toMatch(/\blab_tests\b/);
  });
  it("la función es SECURITY DEFINER con search_path vacío, sin acceso público y solo para service_role", () => {
    expect(sql).toMatch(/create or replace function public\.plusmedik_attention_crm_action\(p_operation_id text, p_action text, p_contact_key text, p_reason text, p_actor text\)[\s\S]*security definer\s+set search_path = ''/);
    expect(sql).toContain("revoke all on function public.plusmedik_attention_crm_action(text, text, text, text, text) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function public.plusmedik_attention_crm_action(text, text, text, text, text) to service_role;");
    expect(sql).not.toMatch(/grant [^;]* to (anon|authenticated|public|crm_app)/i);
  });
  it("no guarda teléfonos ni texto libre: el detalle del evento solo lleva acción, motivo codificado, fuente y actor técnico", () => {
    expect(sql).toMatch(/jsonb_build_object\('action', p_action, 'reason', p_reason, 'source', 'crm_server', 'actor', p_actor\)/);
    expect(sql).not.toMatch(/phone|telefono/i);
  });
});

describe("Fase 1: el registro solo lleva códigos", () => {
  it("las llamadas a log no incluyen teléfono, contact_key, operationId, actor, motivo ni el error", () => {
    const module = code(join(root, "src/crm-attention.ts"));
    const calls = [...module.matchAll(/deps\.log\("crm_attention"[^;]*;/g)].map((match) => match[0]);
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const call of calls) expect(call, call).not.toMatch(/phone|contactKey|operationId|actor|reason|error\b(?!:)|message|body|token|key\b/i);
  });
});

describe("Fase 1: apagado por defecto", () => {
  it("la bandera exige el valor exacto «on»; sin ella (o sin token válido) las rutas responden 503 antes de mirar la petición", () => {
    const module = code(join(root, "src/crm-attention.ts"));
    expect(module).toMatch(/PLUSMEDIK_AGENT_CONTROL\?\.trim\(\)\.toLowerCase\(\) !== "on"\) return \{ enabled: false \};/);
    expect(module).toMatch(/if \(!config\) return json\(503, \{ ok: false, available: false, error: "not_configured" \}\);/);
  });
  it(".env.example define las variables nuevas y están en blanco", () => {
    const example = source(join(root, ".env.example"));
    for (const name of ["PLUSMEDIK_AGENT_CONTROL", "PLUSMEDIK_AGENT_CONTROL_TOKEN", "PLUSMEDIK_AGENT_CONTROL_PHONES"]) {
      expect([...example.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))].map((match) => match[1]!.trim()), name).toEqual([""]);
    }
  });
  it("no cambia las banderas del motor de recetas ni agrega nada al webhook", () => {
    const webhook = source(join(root, "api/kapso/webhook.ts"));
    expect(webhook).toContain('const ENGINE_FLAGS = { semanticPrimary: true, semanticAuto: true, partialAuto: true, handwrittenAuto: "on" } as const;');
    expect(webhookWithoutScopedUse()).not.toMatch(MENTION);
  });
});

describe("Fase 2.3: el control acotado no amplía la exigencia ni el alcance del webhook", () => {
  const webhook = code(join(root, "api/kapso/webhook.ts"));
  it("solo se activa SIN el control humano global (que ya cubre a todos) y se entrega al flujo de fotos y de turnos como una dependencia aparte", () => {
    expect(webhook).toContain("const scopedContactControl = humanControlEnabled ? undefined : resolveScopedContactControl(process.env);");
    expect(webhook).toContain("scopedControl: scopedContactControl ? { contactKeyFor, covers: scopedContactControl.covers } : undefined,");
  });
  it("no cambia la guarda obligatoria ni la pausa automática: requireAuditGuard y humanControl dependen solo de sus banderas de siempre", () => {
    expect(webhook).toContain('requireAuditGuard: humanControlEnabled || turnsEnabled || on("REQUIRE_AUDIT_GUARD"),');
    expect(webhook).toContain("humanControl: humanControlEnabled ? { contactKeyFor } : undefined,");
    expect(webhook).toContain("humanControl: humanControlEnabled ? { labPhoneNumberId: process.env.KAPSO_PHONE_NUMBER_ID, contactKeyFor, attention: attentionProxy } : undefined,");
    expect(webhook).not.toMatch(/requireAuditGuard:.*scoped/i);
  });
  it("ALLOWED_PHONES sigue leyéndose igual y el control acotado no la usa ni la modifica", () => {
    expect(webhook).toContain("allowedPhones: process.env.ALLOWED_PHONES,");
    expect(code(join(root, "src/crm-attention.ts"))).not.toMatch(/ALLOWED_PHONES|isAllowedPhone/);
  });
  it("en el flujo común, el modo acotado solo se considera sin control humano y sin turnos, y solo para los contactos cubiertos", () => {
    const guarded = code(join(root, "src/guarded-turn.ts"));
    expect(guarded).toContain("const scoped = !deps.humanControl && !deps.turns && deps.scopedControl?.covers(ref.from) ? deps.scopedControl : undefined;");
    expect(guarded).toContain("const keySource = deps.turns ?? deps.humanControl ?? scoped;");
    expect(guarded).toContain("if (deps.requireAuditGuard || deps.humanControl || deps.turns || scoped) {");
  });
  it("la documentación exige reactivar antes de retirar un número de la lista y describe la combinación con turnos", () => {
    for (const path of ["docs/integracion-crm/02-fase2-3-control-acotado.md", ".env.example"]) {
      expect(source(join(root, path)), path).toMatch(/reactiv/i);
    }
    const doc = source(join(root, "docs/integracion-crm/02-fase2-3-control-acotado.md"));
    expect(doc).toMatch(/EXIGE reactivación previa/);
    expect(doc).toMatch(/PLUSMEDIK_TURNS=on.*soportada, sin bypass/);
  });
  it("la lista se rechaza antes de calcular la clave del contacto y de crear el repositorio", () => {
    const handler = code(join(root, "src/crm-attention.ts"));
    const body = handler.slice(handler.indexOf("export async function handleCrmAttention"));
    expect(body.indexOf("config.scope && !config.scope.has(")).toBeGreaterThan(body.indexOf("tokenMatches(provided, config.token)"));
    expect(body.indexOf("config.scope && !config.scope.has(")).toBeLessThan(body.indexOf("contactKeyOf("));
    expect(body.indexOf("config.scope && !config.scope.has(")).toBeLessThan(body.indexOf("deps.repository()"));
  });
});
