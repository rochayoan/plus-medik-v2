import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";

// Migración 24 (plusmedik_conversation_events): la tabla de eventos de la memoria estructurada (Fase 1 del plan G7, en sombra). Se prueba contra las 23 anteriores en un PostgreSQL REAL y efímero. NO se
// aplica a ningún Supabase remoto. Lo central: la base IMPONE que no entre texto de pacientes ni precios, es idempotente, solo se accede por funciones y la lectura es de solo lectura.

const bin = findPostgresBin();
if (!bin) console.warn("[conversation-state-db] PostgreSQL no disponible: se omiten las pruebas de la migración 24 contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const FILE = "20261112000000_plusmedik_conversation_events.sql";
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
type Json = Record<string, any>;

describe("migración 24 (plusmedik_conversation_events): forma estática", () => {
  const raw = readFileSync(join(dir, FILE), "utf8").replaceAll("\r\n", "\n");
  const code = raw.split("\n").filter((line) => !/^\s*--/.test(line)).join("\n");

  it("es la penúltima de la cadena (la última es la del piloto del agente), posterior a las del historial de mensajes", () => {
    expect(MIGRATIONS.at(-2)).toBe(FILE);
    expect(MIGRATIONS.at(-3)).toBe("20261111000000_plusmedik_message_history_phone.sql");
  });

  it("es ADITIVA: crea su tabla y sus funciones, y no toca el CRM, el catálogo ni lo existente", () => {
    expect([...code.matchAll(/create table if not exists public\.([a-z_0-9]+)/g)].map((m) => m[1])).toEqual(["plusmedik_conv_events"]);
    expect([...code.matchAll(/create or replace function public\.([a-z_0-9]+)/g)].map((m) => m[1])).toEqual([
      "plusmedik_conv_payload_ok", "plusmedik_conv_append", "plusmedik_conv_events_read", "plusmedik_conv_contacts_since", "plusmedik_conv_erase", "plusmedik_conv_purge"
    ]);
    expect(code).not.toMatch(/\bdrop\s+(table|function|index|column|constraint|schema)\b|\btruncate\b/i);
    expect(code).not.toMatch(/\bcrm\./i);
    expect(code).not.toMatch(/\blab_tests\b/i);
  });

  it("la tabla no admite acceso directo: RLS activo y ningún privilegio; las funciones, SECURITY DEFINER con search_path vacío y solo para service_role", () => {
    expect(code).toMatch(/alter table public\.plusmedik_conv_events enable row level security;/);
    expect(code).toMatch(/revoke all on table public\.plusmedik_conv_events from public, anon, authenticated, service_role;/);
    expect(code).not.toMatch(/grant\s+(select|insert|update|delete|all)\b/i);
    expect(code).not.toMatch(/\bto\s+(anon|authenticated|public)\b/i);
    for (const name of ["append", "events_read", "contacts_since", "erase", "purge"]) expect(code, name).toMatch(new RegExp(`grant execute on function public\\.plusmedik_conv_${name}\\(`));
    expect((code.match(/security definer\s+set search_path = ''/g) ?? []).length).toBe(5);
  });

  it("las lecturas son STABLE (la base impide que escriban o bloqueen filas)", () => {
    expect(code).toMatch(/plusmedik_conv_events_read\(p_contact_key text, p_since timestamptz, p_limit integer\)\s+returns jsonb\s+language plpgsql\s+stable/);
    expect(code).toMatch(/plusmedik_conv_contacts_since\(p_since timestamptz, p_limit integer\)\s+returns jsonb\s+language plpgsql\s+stable/);
  });
});

describe.skipIf(!bin)("migración 24 (plusmedik_conversation_events) contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("conversation_events");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
  });
  afterAll(async () => {
    await server?.stop();
  });

  const asService = (sql: string) => `set role service_role; ${sql}`;
  const first = (out: string) => JSON.parse(out.split("\n").filter(Boolean).at(-1)!) as Json;
  const call = async (sql: string): Promise<Json> => first(await db.ok(asService(sql)));
  const json = (value: unknown) => `$q$${JSON.stringify(value)}$q$::jsonb`;
  const newContact = () => (++counter).toString(16).padStart(64, "0");
  const NOW = () => new Date().toISOString();
  const ev = (key: string, kind: string, payload: Json = {}, at = NOW()) => ({ event_key: key, kind, payload, occurred_at: at });
  const append = (contact: string, events: Json[], days = 30) => call(`select public.plusmedik_conv_append('${contact}', ${json(events)}, ${days});`);
  const read = (contact: string, since = "2000-01-01T00:00:00Z", limit = 100) => call(`select public.plusmedik_conv_events_read('${contact}', '${since}'::timestamptz, ${limit});`);
  const count = async (contact: string) => Number(await db.ok(`select count(*) from public.plusmedik_conv_events where contact_key = '${contact}'`));

  it("guarda eventos con ids y códigos, los lee en orden y devuelve la forma esperada", async () => {
    const contact = newContact();
    const t0 = Date.parse("2026-11-01T10:00:00Z");
    const result = await append(contact, [
      ev("batch:b", "PATIENT_BATCH", { items: [{ m: "wamid.2", t: "QUOTE_REQUEST", g: "QUOTE" }] }, new Date(t0 + 1000).toISOString()),
      ev("batch:a", "PATIENT_BATCH", { items: [{ m: "wamid.1", t: "GREETING" }] }, new Date(t0).toISOString()),
      ev("artifact:1", "ARTIFACT", { kind: "RECIPE", studyIds: ["00000000-0000-4000-8000-000000000001"], unrecognized: 2, ok: true }, new Date(t0 + 2000).toISOString())
    ]);
    expect(result).toEqual({ recorded: 3, duplicate: 0 });
    const events = (await read(contact)).events as Json[];
    expect(events.map((e) => e.key)).toEqual(["batch:a", "batch:b", "artifact:1"]);
    expect(events[0]).toMatchObject({ kind: "PATIENT_BATCH", payload: { items: [{ m: "wamid.1", t: "GREETING" }] } });
    expect(new Date(events[0]!.at).getTime()).toBe(t0);
  });

  it("es idempotente por (contacto, clave): repetir no cambia nada y lo dice; otro contacto con la misma clave sí guarda", async () => {
    const contact = newContact();
    const other = newContact();
    const events = [ev("k1", "HUMAN_MESSAGE"), ev("k2", "HUMAN_RESUME")];
    expect(await append(contact, events)).toEqual({ recorded: 2, duplicate: 0 });
    expect(await append(contact, events)).toEqual({ recorded: 0, duplicate: 2 });
    expect(await append(contact, [ev("k1", "DROP", { reason: "OTHER" }), ev("k3", "DROP")])).toEqual({ recorded: 1, duplicate: 1 });
    expect(await count(contact)).toBe(3);
    expect(await append(other, [ev("k1", "HUMAN_MESSAGE")])).toEqual({ recorded: 1, duplicate: 0 });
  });

  it("la base RECHAZA texto: frases, nombres, teléfonos con espacios, cadenas largas, claves raras, anidados y payloads grandes (y no queda nada a medias)", async () => {
    const contact = newContact();
    const bad: Array<[string, Json]> = [
      ["frase", { note: "necesito un hemograma urgente" }],
      ["frase anidada", { items: [{ m: "wamid.1", t: "hola, soy Maria Perez" }] }],
      ["espacio", { q: "dos palabras" }],
      ["acento", { q: "análisis" }],
      ["arroba", { q: "paciente@correo.com" }],
      ["larga", { q: "a".repeat(129) }],
      ["vacía", { q: "" }],
      ["clave con espacio", { "texto libre": 1 }],
      ["clave anidada rara", { items: [{ "mensaje del paciente": "x" }] }],
      ["clave larga", { ["k".repeat(33)]: 1 }],
      ["clave que empieza por número", { "1a": 1 }]
    ];
    for (const [name, payload] of bad) {
      const error = await db.fails(asService(`select public.plusmedik_conv_append('${contact}', ${json([ev(`bad:${name.replaceAll(" ", "_")}`, "PATIENT_BATCH", payload)])}, 30);`));
      expect(error, name).toContain("PT422");
    }
    const big = { items: Array.from({ length: 400 }, (_, i) => ({ m: `wamid.${i}`, t: "QUOTE_REQUEST" })) };
    expect(await db.fails(asService(`select public.plusmedik_conv_append('${contact}', ${json([ev("big", "PATIENT_BATCH", big)])}, 30);`))).toContain("PT422");
    // un evento malo en el lote aborta todo el lote
    expect(await db.fails(asService(`select public.plusmedik_conv_append('${contact}', ${json([ev("fine", "DROP"), ev("bad", "DROP", { q: "hola que tal" })])}, 30);`))).toContain("PT422");
    expect(await count(contact)).toBe(0);
  });

  it("la restricción de la tabla es la última defensa: ni el propietario puede insertar un payload con texto", async () => {
    const contact = newContact();
    const error = await db.fails(`insert into public.plusmedik_conv_events (contact_key, event_key, kind, payload, occurred_at) values ('${contact}', 'direct', 'DROP', '{"q":"esto es una frase"}', now());`);
    expect(error).toContain("plusmedik_conv_events_payload");
    expect(await db.fails(`insert into public.plusmedik_conv_events (contact_key, event_key, kind, payload, occurred_at) values ('${contact}', 'direct2', 'DROP', '[1,2]', now());`)).toContain("plusmedik_conv_events_payload");
    await db.ok(`insert into public.plusmedik_conv_events (contact_key, event_key, kind, payload, occurred_at) values ('${contact}', 'direct3', 'DROP', '{"n":3,"ok":true,"none":null,"list":["A_1","b.2"]}', now());`);
  });

  it("valida contacto, clave, tipo, fecha, cantidad y retención", async () => {
    const contact = newContact();
    const reject = async (sql: string) => expect(await db.fails(asService(sql))).toContain("PT422");
    await reject(`select public.plusmedik_conv_append('not-a-hash', ${json([ev("k", "DROP")])}, 30);`);
    await reject(`select public.plusmedik_conv_append('${contact.toUpperCase().replace(/^0+/, "A")}', ${json([ev("k", "DROP")])}, 30);`);
    await reject(`select public.plusmedik_conv_append('${contact}', ${json([ev("con espacio", "DROP")])}, 30);`);
    await reject(`select public.plusmedik_conv_append('${contact}', ${json([ev("k", "OTHER_KIND")])}, 30);`);
    await reject(`select public.plusmedik_conv_append('${contact}', ${json([{ event_key: "k", kind: "DROP", occurred_at: "mañana" }])}, 30);`);
    await reject(`select public.plusmedik_conv_append('${contact}', ${json([])}, 30);`);
    await reject(`select public.plusmedik_conv_append('${contact}', ${json(Array.from({ length: 51 }, (_, i) => ev(`k${i}`, "DROP")))}, 30);`);
    await reject(`select public.plusmedik_conv_append('${contact}', ${json([ev("k", "DROP")])}, 0);`);
    await reject(`select public.plusmedik_conv_append('${contact}', ${json([ev("k", "DROP")])}, 366);`);
    await reject(`select public.plusmedik_conv_append('${contact}', '{"a":1}'::jsonb, 30);`);
    expect(await count(contact)).toBe(0);
    expect(await append(contact, Array.from({ length: 50 }, (_, i) => ev(`k${i}`, "DROP")), 365)).toEqual({ recorded: 50, duplicate: 0 });
  });

  it("una fecha futura se acota a «ahora» (no puede quedar por delante de la conversación real)", async () => {
    const contact = newContact();
    await append(contact, [ev("future", "HUMAN_MESSAGE", {}, "2099-01-01T00:00:00Z")]);
    const stored = await db.ok(`select occurred_at <= clock_timestamp() from public.plusmedik_conv_events where contact_key = '${contact}'`);
    expect(stored).toBe("t");
  });

  it("solo se leen eventos vigentes y desde p_since; una lectura acota por límite y contactos", async () => {
    const contact = newContact();
    const old = Date.now() - 10 * 86_400_000;
    await append(contact, [ev("old", "DROP", {}, new Date(old).toISOString())], 365);
    await append(contact, [ev("new", "DROP")], 365);
    expect(((await read(contact, new Date(Date.now() - 86_400_000).toISOString())).events as Json[]).map((e) => e.key)).toEqual(["new"]);
    expect(((await read(contact, "2000-01-01T00:00:00Z", 1)).events as Json[]).map((e) => e.key)).toEqual(["old"]);
    expect(await db.fails(asService(`select public.plusmedik_conv_events_read('${contact}', now(), 0);`))).toContain("PT422");
    expect(await db.fails(asService(`select public.plusmedik_conv_events_read('${contact}', now(), 2001);`))).toContain("PT422");
    const contacts = (await call(`select public.plusmedik_conv_contacts_since(now() - interval '1 day', 1000);`)).contacts as Json[];
    expect(contacts.map((c) => c.contact_key)).toContain(contact);
    expect(contacts.every((c) => /^[0-9a-f]{64}$/.test(c.contact_key))).toBe(true);
  });

  it("la retención: lo vencido deja de leerse y se purga de forma acotada (en cada escritura y a demanda)", async () => {
    const contact = newContact();
    // vence en el pasado reciente: se escribe con retención mínima y se envejece a mano (como lo haría el paso del tiempo)
    await append(contact, Array.from({ length: 25 }, (_, i) => ev(`exp${i}`, "DROP", {}, new Date(Date.now() - 60_000 - i).toISOString())), 1);
    await db.ok(`update public.plusmedik_conv_events set expires_at = occurred_at + interval '1 second' where contact_key = '${contact}'`);
    expect(((await read(contact)).events as Json[]).length).toBe(0);
    expect(await count(contact)).toBe(25);
    await append(newContact(), [ev("trigger", "DROP")]);
    expect(await count(contact)).toBe(5); // la escritura purga a lo sumo 20
    expect(Number((await db.ok(asService(`select public.plusmedik_conv_purge(3);`))).split("\n").at(-1))).toBe(3);
    expect(await count(contact)).toBe(2);
    expect(await db.fails(asService(`select public.plusmedik_conv_purge(0);`))).toContain("PT422");
  });

  it("la supresión borra todo lo de un contacto, exige un motivo y deja un rastro sin contenido", async () => {
    const contact = newContact();
    const keep = newContact();
    await append(contact, [ev("a", "DROP"), ev("b", "DROP")]);
    await append(keep, [ev("a", "DROP")]);
    expect(await db.fails(asService(`select public.plusmedik_conv_erase('${contact}', 'corto');`))).toContain("PT422");
    expect(await count(contact)).toBe(2);
    expect(Number((await db.ok(asService(`select public.plusmedik_conv_erase('${contact}', 'solicitud de supresión del titular');`))).split("\n").at(-1))).toBe(2);
    expect(await count(contact)).toBe(0);
    expect(await count(keep)).toBe(1);
    expect(await db.ok(`select operation || ':' || row_count from public.plusmedik_message_history_access where contact_key = '${contact}' and operation = 'ERASE'`)).toBe("ERASE:2");
  });

  it("acceso solo por funciones: ni service_role, ni anon, ni authenticated tocan la tabla; anon y authenticated tampoco ejecutan las funciones", async () => {
    const contact = newContact();
    await append(contact, [ev("a", "DROP")]);
    for (const role of ["service_role", "anon", "authenticated"]) {
      expect(await db.fails(`set role ${role}; select count(*) from public.plusmedik_conv_events;`), role).toContain("permission denied");
      expect(await db.fails(`set role ${role}; insert into public.plusmedik_conv_events (contact_key, event_key, kind, occurred_at) values ('${contact}', 'x', 'DROP', now());`), role).toContain("permission denied");
      expect(await db.fails(`set role ${role}; delete from public.plusmedik_conv_events;`), role).toContain("permission denied");
    }
    for (const role of ["anon", "authenticated"]) {
      expect(await db.fails(`set role ${role}; select public.plusmedik_conv_append('${contact}', '[]'::jsonb, 30);`), role).toContain("permission denied");
      expect(await db.fails(`set role ${role}; select public.plusmedik_conv_events_read('${contact}', now(), 10);`), role).toContain("permission denied");
      expect(await db.fails(`set role ${role}; select public.plusmedik_conv_erase('${contact}', 'motivo de prueba');`), role).toContain("permission denied");
    }
  });

  it("las lecturas son de solo lectura de verdad: dentro de una transacción de solo lectura funcionan y no cambian la tabla", async () => {
    const contact = newContact();
    await append(contact, [ev("a", "DROP")]);
    const before = await db.ok(`select count(*) || ':' || coalesce(max(seq), 0) from public.plusmedik_conv_events`);
    await db.ok(asService(`begin read only; select public.plusmedik_conv_events_read('${contact}', now() - interval '1 day', 10); select public.plusmedik_conv_contacts_since(now() - interval '1 day', 10); rollback;`));
    expect(await db.ok(`select count(*) || ':' || coalesce(max(seq), 0) from public.plusmedik_conv_events`)).toBe(before);
    expect(await db.ok(`select p.provolatile from pg_proc p where p.proname in ('plusmedik_conv_events_read', 'plusmedik_conv_contacts_since') group by p.provolatile`)).toBe("s");
  });

  it("aplicar la migración dos veces no falla ni cambia el estado (reintento tras un corte)", async () => {
    const contact = newContact();
    await append(contact, [ev("a", "DROP")]);
    const raw = readFileSync(join(dir, FILE), "utf8");
    await db.ok(raw);
    expect(await count(contact)).toBe(1);
  });
});
