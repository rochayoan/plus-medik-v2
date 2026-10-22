import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildEvidencePayload, catalogFingerprint, createSupabaseAuditRepository } from "../src/audit.js";
import type { AnalysisResult } from "../src/analyze.js";
import { cachedAiCall, recordAiUsage, withAiCallObserver, type AiCallEvent } from "../src/cache.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";

// Pruebas contra un PostgreSQL REAL y efímero (clúster temporal, solo 127.0.0.1, destruido al terminar): las migraciones desde cero, la función
// transaccional, los privilegios y los triggers. Si no hay PostgreSQL instalado se omiten con un aviso; NO se sustituyen por pruebas de texto.

const bin = findPostgresBin();
if (!bin) console.warn("[audit-db] PostgreSQL no disponible: se omiten las pruebas de base de datos reales (defina PLUSMEDIK_PG_BIN para ejecutarlas).");

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });

const migrationsDir = join(__dirname, "..", "supabase", "migrations");
const M1 = join(migrationsDir, "20261020000000_plusmedik_persistent_audit.sql");
const M2 = join(migrationsDir, "20261021000000_plusmedik_audit_telemetry.sql");
const M3 = join(migrationsDir, "20261022000000_plusmedik_audit_transactional.sql");
const M4 = join(migrationsDir, "20261023000000_plusmedik_audit_leases.sql");
const M5 = join(migrationsDir, "20261024000000_plusmedik_human_control.sql");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sentinel = "SENTINELA_CLINICA_9";

type Json = Record<string, any>;

const validPayload = (): Json => ({
  contract: 1,
  run: {
    analysis_decision: "HUMAN_REVIEW",
    analysis_outcome: "AUTO_PARTIAL",
    review_required: true,
    recipe_stops: [],
    document_summary: { type: "MARK_DEPENDENT_FORM", complete: true, issueKinds: [], zoneKinds: [] },
    catalog_hash: "a".repeat(64),
    catalog_size: 3,
    config_hash: "b".repeat(64)
  },
  studies: [
    { study_index: 0, decision: "AUTO", blockers: [], catalog_match_status: "MATCHED", quoted_lines: [{ labTestId: "11111111-1111-1111-1111-111111111111", code: "108", priceBs: 45, basis: ["EXACT_CONFIRMED"] }], candidate_codes: [], risk_class: "CLEAR" },
    { study_index: 1, decision: "HUMAN_REVIEW", blockers: ["catalog_unmatched"], catalog_match_status: "UNMATCHED", quoted_lines: [], candidate_codes: [{ id: "22222222-2222-2222-2222-222222222222", code: "209", priceBs: 30 }], risk_class: null },
    { study_index: 2, decision: "HUMAN_REVIEW", blockers: ["non_high_certainty_study", "visual_disputes_unresolved"], catalog_match_status: null, quoted_lines: [], candidate_codes: [], risk_class: "UNKNOWN" }
  ],
  model_calls: [
    { stage: "openai-reader", provider: "openai", model: "gpt-6.1-sol", outcome: "OK", cache_hit: false, input_tokens: 100, output_tokens: 20, reasoning_tokens: 5, cost_usd: null, cost_status: "TOKENS_ONLY", safe_reading: { kind: "READER", requestedCount: 3, uncertainCount: 0, evidence: ["check"], confidence: ["high"] }, call_seq: 1, completion_seq: 2, attempt: 1, started_at: "2026-10-21T20:00:00.000Z", duration_ms: 1200, reasoning_effort: "high", params_hash: "c".repeat(64), error_kind: null },
    { stage: "gemini-openrouter", provider: "openrouter", model: "google/gemini-3.8-flash", outcome: "OK", cache_hit: false, input_tokens: 80, output_tokens: 30, reasoning_tokens: 12, cost_usd: 0.001234567891, cost_status: "PROVIDER_REPORTED", safe_reading: { kind: "READER", requestedCount: 3, uncertainCount: 1, evidence: ["check"], confidence: ["high", "low"] }, call_seq: 2, completion_seq: 1, attempt: 1, started_at: "2026-10-21T20:00:00.010Z", duration_ms: 900, reasoning_effort: "medium", params_hash: "d".repeat(64), error_kind: null },
    { stage: "openai-document-signal", provider: "openai", model: "gpt-6.1-sol", outcome: "FAILED", cache_hit: false, input_tokens: null, output_tokens: null, reasoning_tokens: null, cost_usd: null, cost_status: "UNAVAILABLE", safe_reading: {}, call_seq: 3, completion_seq: 3, attempt: 1, started_at: "2026-10-21T20:00:00.020Z", duration_ms: 50, reasoning_effort: "medium", params_hash: "e".repeat(64), error_kind: "TIMEOUT" }
  ],
  checks: [
    { check_kind: "DOCUMENT", check_status: "PASS", summary: { type: "MARK_DEPENDENT_FORM", complete: true } },
    { check_kind: "JUDGE", check_status: "PASS", summary: { confirmed: 0, rejected: 0, unresolved: 0 } },
    { check_kind: "CATALOG", check_status: "REVIEW", summary: { quotedCount: 1, pendingCount: 2, recipeStops: [] } }
  ]
});

describe.skipIf(!bin)("auditoría contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("audit");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of [M1, M2, M3, M4, M5]) await db.applyFile(file);
  });
  afterAll(async () => {
    await server?.stop();
  });

  // Reclamo del mensaje tal como lo hace la API: INSERT con las columnas permitidas, como service_role.
  async function newRun(): Promise<string> {
    counter++;
    return db.ok(`set role service_role;
      insert into public.plusmedik_audit_runs (kapso_message_id, kapso_media_id, processing_status, audit_schema_version, engine_version, flags)
      values ('wamid.test-${counter}-${Date.now()}', 'media-${counter}', 'PROCESSING', 2, 'abc1234', '{"semanticPrimary":true}') returning id;`);
  }
  const recordSql = (runId: string, payload: unknown, role = "service_role") =>
    `set role ${role}; select public.plusmedik_audit_record_evidence('${runId}'::uuid, $json$${typeof payload === "string" ? payload : JSON.stringify(payload)}$json$::jsonb);`;
  const record = async (runId: string, payload: unknown): Promise<Json> => JSON.parse((await db.ok(recordSql(runId, payload))).split("\n")[0]!);
  const counts = (runId: string) =>
    db.ok(`select (select count(*) from public.plusmedik_audit_studies where run_id='${runId}') || ',' || (select count(*) from public.plusmedik_audit_model_calls where run_id='${runId}') || ',' || (select count(*) from public.plusmedik_audit_checks where run_id='${runId}');`);
  const runRow = async (runId: string): Promise<Json> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_audit_runs r where id='${runId}';`));

  it("las cinco migraciones se aplican desde cero y se pueden volver a ejecutar en orden (F1.2 sobre el esquema final)", async () => {
    await db.applyFile(M2);
    await db.applyFile(M3);
    await db.applyFile(M4);
    await db.applyFile(M5);
    expect(await db.ok("select count(*) from pg_proc where proname like 'plusmedik_audit_%'")).toBe("23");
  });

  describe("escritura atómica de evidencias", () => {
    it("confirma resumen, estudios, llamadas y verificaciones juntos y deja la corrida registrada", async () => {
      const runId = await newRun();
      expect(await record(runId, validPayload())).toEqual({ status: "recorded", studies: 3, model_calls: 3, checks: 3 });
      expect(await counts(runId)).toBe("3,3,3");
      const row = await runRow(runId);
      expect(row).toMatchObject({ processing_status: "ANALYZED", analysis_decision: "HUMAN_REVIEW", analysis_outcome: "AUTO_PARTIAL", review_required: true, catalog_size: 3, config_hash: "b".repeat(64) });
      expect(row.evidence_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.evidence_recorded_at).toBeTruthy();
      expect(await db.ok(`select cost_usd from public.plusmedik_audit_model_calls where run_id='${runId}' and stage='gemini-openrouter'`)).toBe("0.001234568");
    });

    it("no inventa lo ausente: una corrida con solo llamadas de IA (análisis fallido) no toca el estado ni crea estudios", async () => {
      const runId = await newRun();
      const payload = validPayload();
      payload.run = { config_hash: "b".repeat(64) };
      payload.studies = [];
      payload.checks = [];
      expect(await record(runId, payload)).toMatchObject({ status: "recorded", studies: 0, model_calls: 3, checks: 0 });
      expect(await runRow(runId)).toMatchObject({ processing_status: "PROCESSING", analysis_decision: null, analysis_outcome: null, review_required: null, catalog_hash: null, config_hash: "b".repeat(64) });
      expect(await counts(runId)).toBe("0,3,0");
    });

    const failures: Array<[string, (payload: Json) => void, string]> = [
      ["falla al insertar el segundo estudio", (p) => { p.studies[1].decision = "BOGUS"; }, "23514"],
      ["falla al insertar una llamada de IA (ya hay estudios insertados)", (p) => { p.model_calls[2].outcome = "BOGUS"; }, "23514"],
      ["falla al insertar una verificación (ya hay estudios y llamadas insertados)", (p) => { p.checks[2].check_kind = "BOGUS"; }, "23514"],
      ["falla al actualizar el resumen de la corrida (ya se insertó todo lo demás)", (p) => { p.run.analysis_outcome = "BOGUS"; }, "23514"]
    ];
    it.each(failures)("revierte todo si %s", async (_name, mutate, sqlstate) => {
      const runId = await newRun();
      const payload = validPayload();
      mutate(payload);
      const error = await db.fails(recordSql(runId, payload));
      expect(error).toContain("PT422");
      expect(error).toContain(`sqlstate=${sqlstate}`);
      expect(error).not.toContain("BOGUS"); // el error no devuelve el valor recibido
      expect(await counts(runId)).toBe("0,0,0");
      expect(await runRow(runId)).toMatchObject({ processing_status: "PROCESSING", evidence_hash: null, evidence_recorded_at: null, analysis_decision: null, config_hash: null });
    });

    it("tras un fallo la misma corrida puede registrarse con un contenido correcto", async () => {
      const runId = await newRun();
      const bad = validPayload();
      bad.checks[1].check_status = "ok";
      bad.checks[0].check_kind = "BOGUS";
      await db.fails(recordSql(runId, bad));
      expect(await record(runId, validPayload())).toMatchObject({ status: "recorded" });
      expect(await counts(runId)).toBe("3,3,3");
    });
  });

  describe("idempotencia y concurrencia", () => {
    it("repetir el mismo contenido (p. ej. tras un timeout) no duplica nada: 'already_recorded'", async () => {
      const runId = await newRun();
      const payload = validPayload();
      expect((await record(runId, payload)).status).toBe("recorded");
      const before = await runRow(runId);
      expect(await record(runId, payload)).toEqual({ status: "already_recorded" });
      expect(await record(runId, payload)).toEqual({ status: "already_recorded" });
      expect(await counts(runId)).toBe("3,3,3");
      expect(await runRow(runId)).toMatchObject({ evidence_hash: before.evidence_hash, evidence_recorded_at: before.evidence_recorded_at });
    });

    it("el mismo contenido con otro orden de claves se reconoce como el mismo (hash canónico)", async () => {
      const runId = await newRun();
      const payload = validPayload();
      await record(runId, payload);
      const reordered = JSON.stringify({ checks: payload.checks, studies: [...payload.studies].map((s: Json) => Object.fromEntries(Object.entries(s).reverse())), model_calls: payload.model_calls, run: payload.run, contract: 1 });
      expect(await record(runId, reordered)).toEqual({ status: "already_recorded" });
      expect(await counts(runId)).toBe("3,3,3");
    });

    it("un contenido DISTINTO sobre una corrida ya registrada se rechaza y lo confirmado no cambia", async () => {
      const runId = await newRun();
      await record(runId, validPayload());
      const before = await runRow(runId);
      const different = validPayload();
      different.studies.pop();
      const error = await db.fails(recordSql(runId, different));
      expect(error).toContain("PT409");
      expect(await counts(runId)).toBe("3,3,3");
      expect((await runRow(runId)).evidence_hash).toBe(before.evidence_hash);
    });

    it("dos escrituras concurrentes del mismo análisis producen UN solo conjunto de evidencias", async () => {
      const runId = await newRun();
      const payload = validPayload();
      const slow = db.psql(`set role service_role; begin; select public.plusmedik_audit_record_evidence('${runId}'::uuid, $json$${JSON.stringify(payload)}$json$::jsonb); select pg_sleep(1.5); commit;`);
      await sleep(500);
      const fast = db.psql(recordSql(runId, payload));
      const [a, b] = await Promise.all([slow, fast]);
      expect(a.code).toBe(0);
      expect(b.code).toBe(0);
      const statuses = [JSON.parse(a.stdout.split("\n")[0]!).status, JSON.parse(b.stdout.split("\n")[0]!).status].sort();
      expect(statuses).toEqual(["already_recorded", "recorded"]);
      expect(await counts(runId)).toBe("3,3,3");
    });

    it("dos escrituras concurrentes con contenido distinto: gana una y la otra se rechaza sin mezclar nada", async () => {
      const runId = await newRun();
      const first = validPayload();
      const second = validPayload();
      second.studies = second.studies.slice(0, 2);
      second.model_calls = second.model_calls.slice(0, 1);
      const slow = db.psql(`set role service_role; begin; select public.plusmedik_audit_record_evidence('${runId}'::uuid, $json$${JSON.stringify(first)}$json$::jsonb); select pg_sleep(1.5); commit;`);
      await sleep(500);
      const fast = db.psql(recordSql(runId, second));
      const [a, b] = await Promise.all([slow, fast]);
      expect(a.code).toBe(0);
      expect(b.code).not.toBe(0);
      expect(b.stderr).toContain("PT409");
      expect(await counts(runId)).toBe("3,3,3");
    });

    it("un bloqueo que expira (resultado desconocido para quien llamó) no deja datos a medias y el reintento idéntico funciona", async () => {
      const runId = await newRun();
      const holder = db.psql(`begin; select id from public.plusmedik_audit_runs where id='${runId}' for update; select pg_sleep(1.5); commit;`);
      await sleep(500);
      const blocked = await db.psql(`set lock_timeout = '300ms'; ${recordSql(runId, validPayload())}`);
      expect(blocked.code).not.toBe(0);
      expect(blocked.stderr).toContain("55P03");
      await holder;
      expect(await counts(runId)).toBe("0,0,0");
      expect((await record(runId, validPayload())).status).toBe("recorded");
      expect(await counts(runId)).toBe("3,3,3");
    });
  });

  describe("validación previa y mensajes sin datos", () => {
    const bad = (mutate: (p: Json) => void) => () => { const p = validPayload(); mutate(p); return p; };
    const rejected: Array<[string, () => unknown]> = [
      ["clave desconocida en el nivel superior", bad((p) => { p.extra = 1; })],
      ["contrato no soportado", bad((p) => { p.contract = 2; })],
      ["run_id dentro de una fila (lo fija la función)", bad((p) => { p.studies[0].run_id = "x"; })],
      ["clave desconocida en una llamada de IA", bad((p) => { p.model_calls[0].prompt = "hola"; })],
      ["texto libre con espacios en safe_reading", bad((p) => { p.model_calls[0].safe_reading = { kind: "READER", notes: `${sentinel} con espacios` }; })],
      ["texto libre en el resumen del documento", bad((p) => { p.run.document_summary = { type: `${sentinel} libre` }; })],
      ["bloqueo que no es un código", bad((p) => { p.studies[1].blockers = [`${sentinel} motivo libre`]; })],
      ["cadena demasiado larga", bad((p) => { p.checks[0].summary = { type: sentinel.repeat(20) }; })],
      ["clave de objeto no permitida", bad((p) => { p.checks[0].summary = { "mala clave": "x" }; })],
      ["profundidad excesiva", bad((p) => { p.checks[0].summary = { a: { b: { c: { d: { e: { f: 1 } } } } } }; })],
      ["índice de estudio negativo", bad((p) => { p.studies[0].study_index = -1; })],
      ["índice de estudio como texto", bad((p) => { p.studies[0].study_index = "0"; })],
      ["fecha de inicio inválida", bad((p) => { p.model_calls[0].started_at = "ayer"; })],
      ["hash que no es hexadecimal", bad((p) => { p.model_calls[0].params_hash = "xyz"; })],
      ["tokens negativos", bad((p) => { p.model_calls[0].input_tokens = -1; })],
      ["costo con texto", bad((p) => { p.model_calls[0].cost_usd = "0.1"; })],
      ["línea cotizada con clave desconocida", bad((p) => { p.studies[0].quoted_lines[0].nombre = "Juan"; })],
      ["código con caracteres de control", bad((p) => { p.studies[0].quoted_lines[0].code = "A\u0001B"; })],
      ["falta un campo obligatorio de la llamada", bad((p) => { delete p.model_calls[0].stage; })],
      ["demasiados estudios", bad((p) => { p.studies = Array.from({ length: 201 }, (_v, i) => ({ study_index: i, decision: "AUTO" })); })],
      ["colección que no es un arreglo", bad((p) => { p.studies = { study_index: 0 }; })],
      ["resumen de la corrida con clave desconocida", bad((p) => { p.run.recipe = []; })]
    ];
    it.each(rejected)("rechaza: %s", async (_name, build) => {
      const runId = await newRun();
      const error = await db.fails(recordSql(runId, build()));
      expect(error).toContain("PT422");
      expect(error).not.toContain(sentinel);
      expect(await counts(runId)).toBe("0,0,0");
      expect((await runRow(runId)).evidence_recorded_at).toBeNull();
    });

    it("rechaza un contenido que no es un objeto, uno nulo y una corrida inexistente, sin valores en el mensaje", async () => {
      const runId = await newRun();
      expect(await db.fails(recordSql(runId, "[1,2]"))).toContain("PT422");
      expect(await db.fails(`set role service_role; select public.plusmedik_audit_record_evidence('${runId}'::uuid, null);`)).toContain("PT422");
      expect(await db.fails(recordSql("00000000-0000-0000-0000-000000000000", validPayload()))).toContain("PT404");
    });

    it("acepta un precio inválido (negativo) y un código con espacios: la auditoría registra lo que el motor vio", async () => {
      const runId = await newRun();
      const payload = validPayload();
      payload.studies[1].candidate_codes = [{ id: "33333333-3333-3333-3333-333333333333", code: "COD 12/B", priceBs: -5 }];
      expect((await record(runId, payload)).status).toBe("recorded");
    });
  });

  describe("privilegios de la función y de las tablas", () => {
    it.each(["anon", "authenticated", "unprivileged"])("%s no puede ejecutar las funciones de auditoría", async (role) => {
      const runId = await newRun();
      expect(await db.fails(recordSql(runId, validPayload(), role))).toContain("42501");
      expect(await db.fails(`set role ${role}; select public.plusmedik_audit_record_reply('${runId}'::uuid, '{}'::jsonb);`)).toContain("42501");
      expect(await db.fails(`set role ${role}; select public.plusmedik_audit_token_json_ok('{}'::jsonb);`)).toContain("42501");
      expect(await counts(runId)).toBe("0,0,0");
    });

    it("las funciones públicas son SECURITY DEFINER con search_path vacío y solo service_role puede ejecutarlas", async () => {
      expect(await db.ok(`select prosecdef::text || '|' || coalesce(array_to_string(proconfig, ','), '') from pg_proc where proname = 'plusmedik_audit_record_evidence'`)).toBe('true|search_path=""');
      expect(await db.ok(`select prosecdef::text || '|' || coalesce(array_to_string(proconfig, ','), '') from pg_proc where proname = 'plusmedik_audit_record_reply'`)).toBe('true|search_path=""');
      expect(await db.ok(`select count(*) from pg_proc where proname like 'plusmedik_audit_%' and proconfig is null`)).toBe("0");
      expect(await db.ok(`select has_function_privilege('service_role', 'public.plusmedik_audit_record_evidence(uuid, jsonb)', 'execute')::text`)).toBe("true");
      expect(await db.ok(`select has_function_privilege('public', 'public.plusmedik_audit_record_evidence(uuid, jsonb)', 'execute')::text`)).toBe("false");
    });

    it("service_role solo LEE las evidencias: no inserta, no actualiza, no borra ni vacía", async () => {
      const runId = await newRun();
      await record(runId, validPayload());
      for (const table of ["plusmedik_audit_studies", "plusmedik_audit_model_calls", "plusmedik_audit_checks"]) {
        expect(await db.ok(`set role service_role; select count(*) from public.${table} where run_id='${runId}';`)).not.toBe("0");
        expect(await db.fails(`set role service_role; update public.${table} set created_at = now();`)).toContain("42501");
        expect(await db.fails(`set role service_role; delete from public.${table};`)).toContain("42501");
        expect(await db.fails(`set role service_role; truncate public.${table};`)).toContain("42501");
      }
      expect(await db.fails(`set role service_role; insert into public.plusmedik_audit_studies (run_id, study_index, decision) values ('${runId}', 99, 'AUTO');`)).toContain("42501");
      expect(await db.fails(`set role service_role; insert into public.plusmedik_audit_checks (run_id, check_kind, check_status) values ('${runId}', 'JUDGE', 'PASS');`)).toContain("42501");
      expect(await db.fails(`set role service_role; insert into public.plusmedik_audit_model_calls (run_id, stage, provider, model, outcome, cost_status) values ('${runId}', 's', 'p', 'm', 'OK', 'UNAVAILABLE');`)).toContain("42501");
      expect(await counts(runId)).toBe("3,3,3");
    });

    it("service_role no puede escribir columnas de evidencia ni de identidad de runs, ni borrar corridas", async () => {
      const runId = await newRun();
      for (const column of ["analysis_decision = 'AUTO_SAFE'", "config_hash = repeat('a', 64)", "evidence_hash = repeat('a', 64)", "evidence_recorded_at = now()", "kapso_message_id = 'otro'", "engine_version = 'zzz'", "detail_expires_at = now()", "recipe_stops = '[]'::jsonb"]) {
        expect(await db.fails(`set role service_role; update public.plusmedik_audit_runs set ${column} where id='${runId}';`), column).toContain("42501");
      }
      expect(await db.fails(`set role service_role; insert into public.plusmedik_audit_runs (kapso_message_id, processing_status, analysis_decision) values ('wamid.x-${Date.now()}', 'PROCESSING', 'AUTO_SAFE');`)).toContain("42501");
      expect(await db.fails(`set role service_role; delete from public.plusmedik_audit_runs where id='${runId}';`)).toContain("42501");
      expect(await db.fails(`set role anon; select count(*) from public.plusmedik_audit_runs;`)).toContain("42501");
    });

    it("el claim es idempotente por mensaje: un WAMID repetido no inserta y no devuelve fila", async () => {
      const wamid = `wamid.dup-${Date.now()}`;
      const insert = `set role service_role; insert into public.plusmedik_audit_runs (kapso_message_id, processing_status) values ('${wamid}', 'PROCESSING') on conflict (kapso_message_id) do nothing returning id;`;
      expect(await db.ok(insert)).toMatch(/^[0-9a-f-]{36}$/);
      expect(await db.ok(insert)).toBe("");
    });
  });

  describe("inmutabilidad de las evidencias históricas", () => {
    it("ni el propietario puede modificar, borrar ni vaciar estudios, llamadas, verificaciones o corridas", async () => {
      const runId = await newRun();
      await record(runId, validPayload());
      for (const table of ["plusmedik_audit_studies", "plusmedik_audit_model_calls", "plusmedik_audit_checks"]) {
        expect(await db.fails(`update public.${table} set created_at = now() where run_id='${runId}';`)).toContain("PT409");
        expect(await db.fails(`delete from public.${table} where run_id='${runId}';`)).toContain("PT409");
        expect(await db.fails(`truncate public.${table} cascade;`)).toContain("PT409");
      }
      expect(await db.fails(`update public.plusmedik_audit_studies set decision = 'AUTO' where run_id='${runId}' and study_index = 1;`)).toContain("PT409");
      expect(await db.fails(`delete from public.plusmedik_audit_runs where id='${runId}';`)).toContain("PT409");
      expect(await db.fails(`truncate public.plusmedik_audit_runs cascade;`)).toContain("PT409");
      expect(await counts(runId)).toBe("3,3,3");
      expect(await db.ok(`select decision from public.plusmedik_audit_studies where run_id='${runId}' and study_index = 1`)).toBe("HUMAN_REVIEW");
    });

    it("las columnas de evidencia de runs no cambian una vez registradas, ni siquiera por el propietario; la identidad tampoco", async () => {
      const runId = await newRun();
      await record(runId, validPayload());
      for (const change of ["analysis_decision = 'AUTO_SAFE'", "analysis_outcome = 'AUTO_COMPLETE'", "review_required = false", "recipe_stops = '[\"x\"]'::jsonb", "document_summary = '{}'::jsonb", "catalog_hash = repeat('f', 64)", "config_hash = repeat('f', 64)", "evidence_hash = repeat('f', 64)", "evidence_recorded_at = null"]) {
        expect(await db.fails(`update public.plusmedik_audit_runs set ${change} where id='${runId}';`), change).toContain("PT409");
      }
      for (const change of ["kapso_message_id = 'otro'", "kapso_media_id = 'otro'", "received_at = now()", "started_at = now()", "engine_version = 'fff1234'", "audit_schema_version = 9", "flags = '{}'::jsonb", "detail_expires_at = now()", "metrics_expires_at = now()"]) {
        expect(await db.fails(`update public.plusmedik_audit_runs set ${change} where id='${runId}';`), change).toContain("PT409");
      }
    });

    it("las columnas de evidencia tampoco se pueden fijar por separado: solo junto con evidence_recorded_at", async () => {
      const runId = await newRun();
      expect(await db.fails(`update public.plusmedik_audit_runs set analysis_decision = 'AUTO_SAFE' where id='${runId}';`)).toContain("PT409");
      expect(await db.fails(`update public.plusmedik_audit_runs set evidence_hash = repeat('a', 64) where id='${runId}';`)).toContain("PT409");
    });
  });

  describe("ciclo de vida operativo de runs (sí es modificable)", () => {
    const setStatus = (runId: string, status: string, extra = "") => `set role service_role; update public.plusmedik_audit_runs set processing_status = '${status}'${extra} where id='${runId}';`;

    it("cierra legítimamente un procesamiento: PROCESSING -> ANALYZED -> COMPLETED, y actualiza updated_at", async () => {
      const runId = await newRun();
      const before = new Date((await runRow(runId)).updated_at).getTime();
      await sleep(20);
      await record(runId, validPayload());
      expect((await runRow(runId)).processing_status).toBe("ANALYZED");
      await db.ok(setStatus(runId, "COMPLETED", ", completed_at = now()"));
      const row = await runRow(runId);
      expect(row).toMatchObject({ processing_status: "COMPLETED" });
      expect(row.completed_at).toBeTruthy();
      expect(new Date(row.updated_at).getTime()).toBeGreaterThan(before);
    });

    it("permite los cierres del flujo real: fallo, imagen ignorada que luego recibe respuesta, y cierre sin evidencia", async () => {
      const failed = await newRun();
      await db.ok(setStatus(failed, "FAILED", ", error_code = 'AI_PROCESSING_FAILED', completed_at = now()"));
      expect(await runRow(failed)).toMatchObject({ processing_status: "FAILED", error_code: "AI_PROCESSING_FAILED" });
      const ignored = await newRun();
      await db.ok(setStatus(ignored, "IGNORED", ", error_code = 'IMAGE_TYPE', completed_at = now()"));
      await db.ok(setStatus(ignored, "COMPLETED", ", completed_at = now()"));
      expect((await runRow(ignored)).processing_status).toBe("COMPLETED");
      const noEvidence = await newRun();
      await db.ok(setStatus(noEvidence, "COMPLETED", ", completed_at = now()"));
      expect(await runRow(noEvidence)).toMatchObject({ processing_status: "COMPLETED", evidence_recorded_at: null }); // brecha de auditoría observable
    });

    it("rechaza transiciones inválidas y no deja borrar el resultado ya registrado", async () => {
      const runId = await newRun();
      await db.ok(setStatus(runId, "FAILED", ", error_code = 'AI_PROCESSING_FAILED', completed_at = now()"));
      expect(await db.fails(setStatus(runId, "COMPLETED"))).toContain("PT409");
      expect(await db.fails(setStatus(runId, "PROCESSING"))).toContain("PT409");
      expect(await db.fails(`set role service_role; update public.plusmedik_audit_runs set error_code = 'OTRO' where id='${runId}';`)).toContain("PT409");
      expect(await db.fails(`set role service_role; update public.plusmedik_audit_runs set completed_at = null where id='${runId}';`)).toContain("PT409");
      expect(await db.ok(setStatus(runId, "FAILED"))).toBe(""); // mismo estado: sin cambio
    });

    it("el envío se registra una sola vez (RPC): estado de la corrida + verificación REPLY en una transacción", async () => {
      const runId = await newRun();
      await record(runId, validPayload());
      const reply = (state: string, result = "quoted", extra = "") => `set role service_role; select public.plusmedik_audit_record_reply('${runId}'::uuid, '{"state":"${state}","result":"${result}","processing_status":"COMPLETED"${extra}}'::jsonb);`;
      expect(JSON.parse(await db.ok(reply("ACCEPTED", "quoted", ',"provider_message_id":"wamid.HBgLtest=="')))).toEqual({ status: "recorded" });
      expect(await runRow(runId)).toMatchObject({ processing_status: "COMPLETED", reply_state: "ACCEPTED", reply_kind: "quoted", kapso_outbound_message_id: "wamid.HBgLtest==" });
      expect(await db.ok(`select check_status || ':' || summary::text from public.plusmedik_audit_checks where run_id='${runId}' and check_kind='REPLY'`)).toBe('ACCEPTED:{"result": "quoted", "providerAccepted": true}');
      expect(JSON.parse(await db.ok(reply("ACCEPTED", "quoted", ',"provider_message_id":"wamid.HBgLtest=="')))).toEqual({ status: "already_recorded" });
      expect(await db.fails(reply("UNKNOWN"))).toContain("PT409");
      expect(await db.ok(`select count(*) from public.plusmedik_audit_checks where run_id='${runId}' and check_kind='REPLY'`)).toBe("1");
    });

    it("el registro del envío es atómico: si la verificación REPLY ya existe, el estado de la corrida tampoco cambia", async () => {
      const runId = await newRun();
      await db.ok(`insert into public.plusmedik_audit_checks (run_id, check_kind, check_status) values ('${runId}', 'REPLY', 'ACCEPTED');`);
      const error = await db.fails(`set role service_role; select public.plusmedik_audit_record_reply('${runId}'::uuid, '{"state":"ACCEPTED","result":"quoted","processing_status":"COMPLETED"}'::jsonb);`);
      expect(error).toContain("PT422");
      expect(await runRow(runId)).toMatchObject({ reply_state: "NOT_ATTEMPTED", processing_status: "PROCESSING", completed_at: null });
    });

    it("rechaza respuestas mal formadas y corridas inexistentes sin devolver valores", async () => {
      const runId = await newRun();
      const call = (reply: string) => `set role service_role; select public.plusmedik_audit_record_reply('${runId}'::uuid, '${reply}'::jsonb);`;
      for (const reply of [`{"state":"MAYBE","result":"quoted","processing_status":"COMPLETED"}`, `{"state":"ACCEPTED","result":"${sentinel}","processing_status":"COMPLETED"}`, `{"state":"ACCEPTED","result":"quoted","processing_status":"PROCESSING"}`, `{"state":"ACCEPTED","result":"quoted","processing_status":"COMPLETED","extra":1}`, `{"state":"ACCEPTED","result":"quoted","processing_status":"COMPLETED","provider_message_id":"con espacios"}`]) {
        const error = await db.fails(call(reply));
        expect(error).toContain("PT422");
        expect(error).not.toContain(sentinel);
      }
      expect(await db.fails(`set role service_role; select public.plusmedik_audit_record_reply('00000000-0000-0000-0000-000000000000'::uuid, '{"state":"ACCEPTED","result":"quoted","processing_status":"COMPLETED"}'::jsonb);`)).toContain("PT404");
      expect((await runRow(runId)).reply_state).toBe("NOT_ATTEMPTED");
    });
  });

  describe("contrato TypeScript <-> SQL", () => {
    const analysis = {
      decision: "HUMAN_REVIEW", reasons: ["catalog_unmatched"], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [],
      unmatched: [], ambiguous: [], modelSuggested: [], outcome: "AUTO_PARTIAL",
      matches: [{ status: "MATCHED" }, { status: "UNMATCHED" }],
      internal: {
        outcome: "AUTO_PARTIAL", recipeComplete: false, reviewRequired: true,
        quoted: { lines: [{ id: "lab-1", code: `COD\n108 ${"x".repeat(80)}`, name: "NOMBRE CLÍNICO SENTINELA", priceBs: 45, basis: ["EXACT_CONFIRMED"], texts: [sentinel] }], subtotalBs: 45 },
        studies: [
          { key: "uno", text: sentinel, decision: "AUTO", blockers: [], uncertainty: [], lineIds: ["lab-1"], risk: { class: "CLEAR" } },
          { key: "dos", text: sentinel, decision: "HUMAN_REVIEW", blockers: ["catalog_unmatched"], uncertainty: ["IDENTITY"], lineIds: [] }
        ],
        pending: [{ key: "dos", kind: "STUDY", text: sentinel, blockers: ["catalog_unmatched"], uncertainty: ["IDENTITY"], candidates: [{ id: "lab-9", code: "9 / B", name: "OTRO", priceBs: -3 }] }],
        recipeStops: [],
        document: { type: "MARK_DEPENDENT_FORM", complete: true, issueKinds: [], problems: [`${sentinel} problema libre`], unseenRegion: false, zones: [], impactCheck: { needed: false, candidates: [] } },
        advisories: [`${sentinel} aviso libre`], revision: "r", history: []
      }
    } as unknown as AnalysisResult;

    async function realEvents(): Promise<AiCallEvent[]> {
      const events: AiCallEvent[] = [];
      vi.stubEnv("AI_CACHE", "off");
      vi.stubEnv("AI_CACHE_DIR", join(tmpdir(), "plusmedik-audit-db-usage"));
      const parse = (raw: unknown) => raw as { ok: true };
      const params = { model: "m", reasoning: { effort: "high" }, schema: { type: "object" } };
      await withAiCallObserver((event) => events.push(event), async () => {
        await Promise.all([
          cachedAiCall({ label: "openai-reader", provider: "openai", model: "gpt-6.1-sol", imageBase64: "i", config: { prompt: sentinel, params }, parse, call: async () => ({ value: { ok: true as const }, usage: { inputTokens: 7, outputTokens: 3, reasoningTokens: 1, costUsd: 0.000000123456789 } }) }),
          cachedAiCall({ label: "gemini-openrouter", provider: "openrouter", model: "google/gemini-3.8-flash", imageBase64: "i", config: { prompt: sentinel, params }, parse, call: async () => { await recordAiUsage({ label: "gemini-openrouter", provider: "openrouter", model: "google/gemini-3.8-flash", usage: { inputTokens: 5 }, invalid: true, reasoningEffort: "medium" }); return { value: { ok: true as const }, reasoningEffort: "low" }; } }),
          cachedAiCall({ label: "openai-judge", provider: "openai", model: "gpt-6-astra", imageBase64: "i", config: { prompt: sentinel, params }, parse, call: async () => { throw Object.assign(new Error(`${sentinel} secret=sk-x`), { status: 503 }); } }).catch(() => undefined)
        ]);
      });
      vi.unstubAllEnvs();
      return events;
    }

    it("el contenido que construye el repositorio lo acepta la función real, sin texto clínico, y los datos llegan tal cual", async () => {
      const events = await realEvents();
      const catalog = catalogFingerprint([{ id: "lab-1", code: "1", name: "X", normalizedName: "x", normalizedAliases: [], priceBs: 45, active: true }]);
      const payload = buildEvidencePayload({ analysis, aiCalls: events, catalog }, { engineVersion: "abc1234", flags: { semanticPrimary: true } });
      expect(JSON.stringify(payload)).not.toContain(sentinel);
      const runId = await newRun();
      const text = JSON.stringify(payload);
      expect(await record(runId, text)).toMatchObject({ status: "recorded", studies: 2, model_calls: events.length, checks: 3 });
      expect(await runRow(runId)).toMatchObject({ processing_status: "ANALYZED", analysis_outcome: "AUTO_PARTIAL", catalog_hash: catalog.hash, catalog_size: 1 });
      expect(await db.ok(`select quoted_lines->0->>'code' from public.plusmedik_audit_studies where run_id='${runId}' and study_index=0`)).toBe(`COD 108 ${"x".repeat(80)}`.slice(0, 64));
      expect(await db.ok(`select candidate_codes->0->>'priceBs' from public.plusmedik_audit_studies where run_id='${runId}' and study_index=1`)).toBe("-3");
      expect(await db.ok(`select string_agg(call_seq || '/' || attempt || '/' || outcome || '/' || coalesce(error_kind, '-') || '/' || coalesce(reasoning_effort, '-'), ' ' order by call_seq, attempt) from public.plusmedik_audit_model_calls where run_id='${runId}'`)).toBe("1/1/OK/-/high 2/1/INVALID/-/medium 2/2/OK/-/low 3/1/FAILED/HTTP_SERVER/high");
      expect(await db.ok(`select count(*) from public.plusmedik_audit_model_calls where run_id='${runId}' and duration_ms is not null and started_at is not null and params_hash is not null`)).toBe(String(events.length));
      expect(await record(runId, text)).toEqual({ status: "already_recorded" });
      // todo lo persistido, volcado a texto: ni el centinela clínico ni secretos
      const dump = await db.ok(`select (select coalesce(string_agg(to_json(s)::text, ''), '') from public.plusmedik_audit_studies s where run_id='${runId}') || (select string_agg(to_json(m)::text, '') from public.plusmedik_audit_model_calls m where run_id='${runId}') || (select string_agg(to_json(c)::text, '') from public.plusmedik_audit_checks c where run_id='${runId}') || (select to_json(r)::text from public.plusmedik_audit_runs r where id='${runId}')`);
      expect(dump).not.toContain(sentinel);
      expect(dump).not.toContain("sk-x");
    });

    it("el contenido del análisis fallido (solo llamadas de IA) y el del envío también los acepta la función real", async () => {
      const events = await realEvents();
      const runId = await newRun();
      const failed = buildEvidencePayload({ aiCalls: events }, { engineVersion: null, flags: {} })!;
      expect(failed).toMatchObject({ studies: [], checks: [] });
      expect(await record(runId, failed)).toMatchObject({ status: "recorded", studies: 0, checks: 0 });
      expect(await runRow(runId)).toMatchObject({ processing_status: "PROCESSING", analysis_decision: null });

      const requests: Array<{ path: string; body: Json }> = [];
      const repository = createSupabaseAuditRepository({
        baseUrl: "https://example.supabase.co", serviceKey: "k", retryDelayMs: 0,
        fetchFn: async (input, init) => { requests.push({ path: String(input).replace("https://example.supabase.co/rest/v1/", ""), body: JSON.parse(String(init?.body)) }); return new Response('{"status":"recorded"}', { status: 200 }); }
      });
      await repository.recordReply(runId, { state: "ACCEPTED", result: "quoted", processingStatus: "COMPLETED", providerMessageId: "wamid.HBgLabc123==" }, { owner: "owner-0000001", fence: 1 });
      const reply = requests.find((request) => request.path === "rpc/plusmedik_audit_fenced_record_reply")!.body;
      expect(reply.p_run_id).toBe(runId);
      expect(JSON.parse(await db.ok(`set role service_role; select public.plusmedik_audit_record_reply('${runId}'::uuid, $json$${JSON.stringify(reply.p_reply)}$json$::jsonb);`))).toEqual({ status: "recorded" });
      expect(await runRow(runId)).toMatchObject({ processing_status: "COMPLETED", reply_state: "ACCEPTED", kapso_outbound_message_id: "wamid.HBgLabc123==" });
    });
  });

  describe("compatibilidad con registros anteriores (Fase 6 y telemetría)", () => {
    it("migrar encima de datos existentes los conserva, no los hace inmutables por error y no permite re-registrarlos", async () => {
      const legacy = await server.createDatabase("legacy");
      await legacy.ok(SUPABASE_BOOTSTRAP_SQL);
      await legacy.applyFile(M1);
      await legacy.applyFile(M2);
      // Filas con el contrato de la Fase 6 / F1.1: columnas nuevas NULL, sin telemetría.
      await legacy.ok(`
        insert into public.plusmedik_audit_runs (id, kapso_message_id, processing_status, analysis_decision, analysis_outcome, review_required, reply_state, reply_kind, completed_at)
          values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'wamid.legacy-1', 'COMPLETED', 'AUTO_SAFE', 'AUTO_COMPLETE', false, 'ACCEPTED', 'quoted', now()),
                 ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'wamid.legacy-2', 'PROCESSING', null, null, null, 'NOT_ATTEMPTED', null, null);
        insert into public.plusmedik_audit_studies (run_id, study_index, decision) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 0, 'AUTO');
        insert into public.plusmedik_audit_model_calls (run_id, stage, provider, model, outcome, cost_status) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'openai-reader', 'openai', 'm', 'OK', 'UNAVAILABLE');
        insert into public.plusmedik_audit_checks (run_id, check_kind, check_status) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'DOCUMENT', 'PASS'), ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'REPLY', 'ACCEPTED');`);
      await legacy.applyFile(M3);
      await legacy.applyFile(M3); // re-ejecutable también sobre datos

      expect(await legacy.ok(`select (select count(*) from public.plusmedik_audit_runs) || ',' || (select count(*) from public.plusmedik_audit_studies) || ',' || (select count(*) from public.plusmedik_audit_model_calls) || ',' || (select count(*) from public.plusmedik_audit_checks)`)).toBe("2,1,1,2");
      expect(await legacy.ok(`select audit_schema_version is null and evidence_hash is null and evidence_recorded_at is null and call_seq is null from public.plusmedik_audit_runs r, public.plusmedik_audit_model_calls m where r.id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'`)).toBe("t");
      // lo operativo de una corrida anterior sigue siendo modificable
      await legacy.ok(`set role service_role; update public.plusmedik_audit_runs set processing_status = 'FAILED', error_code = 'AI_PROCESSING_FAILED', completed_at = now() where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';`);
      // pero su evidencia no se reescribe: ni por la función (choca con lo existente y se revierte) ni a mano
      const error = await legacy.fails(`set role service_role; select public.plusmedik_audit_record_evidence('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, $json$${JSON.stringify(validPayload())}$json$::jsonb);`);
      expect(error).toContain("PT422");
      expect(await legacy.fails(`update public.plusmedik_audit_runs set analysis_decision = 'HUMAN_REVIEW' where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';`)).toContain("PT409");
      expect(await legacy.ok(`select (select count(*) from public.plusmedik_audit_studies) || ',' || (select count(*) from public.plusmedik_audit_model_calls) || ',' || (select count(*) from public.plusmedik_audit_checks)`)).toBe("1,1,2");
    });
  });
});
