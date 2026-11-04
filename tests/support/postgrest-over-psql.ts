import type { PgDatabase } from "./ephemeral-postgres.js";

// Adaptador de PRUEBAS: traduce cada llamada RPC de PostgREST (POST /rest/v1/rpc/<función> con un cuerpo JSON de argumentos con nombre) a la función SQL real de la
// base efímera, ejecutándola como service_role mediante psql. Así los repositorios REALES de producción (src/audit.ts, src/human-control.ts) se prueban contra
// PostgreSQL real sin red. Un SQLSTATE de la forma PT### se devuelve como HTTP ###, igual que hace PostgREST.

export const PARAM_TYPES: Record<string, string> = {
  // historial de mensajes (migración 21)
  p_account_id: "text", p_contact_phone: "text", p_body: "text", p_direction: "text", p_origin: "text", p_content_kind: "text", p_message_type: "text", p_body_cipher: "text", p_key_id: "text", p_media_ref: "text", p_delivery_state: "text",
  p_audit_run_id: "uuid", p_reply_to: "text", p_retention_days: "integer", p_state: "text", p_at: "timestamptz", p_from: "timestamptz", p_to: "timestamptz", p_after_seq: "bigint", p_since: "timestamptz",
  p_run_id: "uuid", p_payload: "jsonb", p_owner: "text", p_fence: "bigint", p_close: "jsonb", p_kind: "text", p_lease_seconds: "integer", p_reply: "jsonb", p_message_id: "text", p_media_id: "text",
  p_schema_version: "integer", p_engine_version: "text", p_flags: "jsonb", p_max_attempts: "integer", p_reserved_grace_seconds: "integer", p_abandon_grace_seconds: "integer", p_limit: "integer",
  p_refs: "jsonb", p_key: "text", p_actor_id: "text", p_actor_type: "text", p_actor_role: "text", p_source_ref: "text", p_valid_from: "timestamptz", p_valid_until: "timestamptz", p_version_id: "uuid", p_status: "text",
  p_reason: "text", p_turn_kind: "text", p_stale_policy: "text", p_contact_key: "text", p_event_key: "text", p_occurred_at: "timestamptz", p_source: "text", p_actor: "text", p_detail: "jsonb", p_guard: "jsonb", p_cap: "jsonb",
  p_image_hash: "text", p_result: "jsonb", p_ttl_seconds: "integer", p_max_items: "integer", p_session_id: "uuid", p_outcome: "text", p_lines: "jsonb", p_total: "numeric", p_reasons: "text[]", p_catalog_fingerprint: "text",
  p_recent_seconds: "integer", p_fact_id: "uuid", p_lab_test_id: "uuid", p_max_age_seconds: "integer", p_operation_id: "text", p_action: "text",
  p_origin_run_id: "uuid", p_kapso_message_id: "text", p_cipher: "text", p_hash: "text", p_evidence: "jsonb", p_outbox_id: "uuid", p_force: "boolean", p_http_status: "integer", p_duration_ms: "integer", p_event_ids: "text[]"
};

const literal = (key: string, value: unknown): string => {
  const type = PARAM_TYPES[key];
  if (!type) throw new Error(`parámetro desconocido: ${key}`);
  if (value === null || value === undefined) return `null::${type}`;
  if (type === "text[]") return `array[${(value as string[]).map((item) => `$t$${item}$t$`).join(", ")}]::text[]`;
  if (type === "jsonb") return `$j$${JSON.stringify(value)}$j$::jsonb`;
  if (type === "text" || type === "uuid" || type === "timestamptz") return `$t$${String(value)}$t$::${type}`;
  if (type === "boolean") return `${value === true}::boolean`;
  return `${Number(value)}::${type}`;
};

// Estado de la "red" hacia Supabase: se puede cortar por completo o por función.
export interface Network {
  down: boolean;
  downFor: Set<string>;
  calls: string[];
}
export const newNetwork = (): Network => ({ down: false, downFor: new Set(), calls: [] });

export function postgrestOverPsql(db: PgDatabase, network: Network): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const name = String(input).split("/rest/v1/rpc/")[1];
    if (!name || !/^plusmedik_(audit|attention|turn|kb|reply_guard|quote|study|facts|crm|history)_[a-z_]+$/.test(name)) throw new Error("solo RPC de auditoría o atención");
    network.calls.push(name);
    if (network.down || network.downFor.has(name)) throw new TypeError("fetch failed");
    const args = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const sql = `set role service_role; select public.${name}(${Object.entries(args).map(([key, value]) => `${key} => ${literal(key, value)}`).join(", ")});`;
    const result = await db.psql(sql);
    if (result.code === 0) return new Response(result.stdout.split("\n")[0] || "{}", { status: 200 });
    const code = /ERROR:\s+(PT\d{3}|[0-9A-Z]{5}):/.exec(result.stderr)?.[1] ?? "";
    return new Response("{}", { status: code.startsWith("PT") ? Number(code.slice(2)) : 500 });
  }) as typeof fetch;
}
