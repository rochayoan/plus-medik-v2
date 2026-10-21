import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createTestDb, ids } from "./harness";

let db: PGlite;

type QuoteResult = { id: string; folio: number; total_bs: number; valid_until: string; tariff_name: string };

async function createQuote(userId: string, labTestIds: string[], extra: { patient?: string; source?: string; photoJobId?: string } = {}): Promise<QuoteResult> {
  return asUser(db, userId, async () => {
    const { rows } = await db.query<{ q: QuoteResult }>(
      "select public.create_quote($1::uuid[], $2, $3, $4::uuid) as q",
      [labTestIds, extra.patient ?? null, extra.source ?? "manual", extra.photoJobId ?? null]
    );
    return rows[0]!.q;
  });
}

const visibleQuoteIds = (userId: string | null) =>
  asUser(db, userId, async () => (await db.query<{ id: string }>("select id from public.quotes order by folio")).rows.map((row) => row.id));

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

describe("create_quote", () => {
  it("cobra con la tarifa de la organización y cae al precio Paciente si el estudio no tiene precio de tarifa", async () => {
    const quote = await createQuote(ids.userA, [ids.hemograma, ids.glicemia]);
    // hemograma 40 (tarifa A) + glicemia 20 (Paciente)
    expect(Number(quote.total_bs)).toBe(60);
    expect(quote.tariff_name).toBe("Convenio A");
    const { rows } = await db.query<{ lab_test_id: string; price_bs: string; position: number }>(
      "select lab_test_id, price_bs, position from public.quote_items where quote_id = $1 order by position", [quote.id]
    );
    expect(rows.map((row) => [row.lab_test_id, Number(row.price_bs)])).toEqual([[ids.hemograma, 40], [ids.glicemia, 20]]);
  });

  it("sin tarifa usa el precio Paciente", async () => {
    const quote = await createQuote(ids.userB, [ids.hemograma, ids.tsh]);
    expect(Number(quote.total_bs)).toBe(130);
    expect(quote.tariff_name).toBe("Paciente");
  });

  it("deduplica por UUID y conserva el orden del carrito", async () => {
    const quote = await createQuote(ids.userB, [ids.tsh, ids.hemograma, ids.tsh]);
    const { rows } = await db.query<{ lab_test_id: string }>("select lab_test_id from public.quote_items where quote_id = $1 order by position", [quote.id]);
    expect(rows.map((row) => row.lab_test_id)).toEqual([ids.tsh, ids.hemograma]);
    expect(Number(quote.total_bs)).toBe(130);
  });

  it("guarda copia de nombre y precio: cambiar el catálogo después no altera la cotización", async () => {
    const quote = await createQuote(ids.userB, [ids.glicemia]);
    await db.exec(`update public.lab_tests set price_bs = 999, name = 'Otro' where id = '${ids.glicemia}'`);
    const { rows } = await db.query<{ name: string; price_bs: string }>("select name, price_bs from public.quote_items where quote_id = $1", [quote.id]);
    expect(rows[0]).toMatchObject({ name: "Glicemia" });
    expect(Number(rows[0]!.price_bs)).toBe(20);
    await db.exec(`update public.lab_tests set price_bs = 20, name = 'Glicemia' where id = '${ids.glicemia}'`);
  });

  it("rechaza estudios inactivos o inexistentes, carritos vacíos y orígenes inválidos", async () => {
    await expect(createQuote(ids.userA, [ids.inactivo])).rejects.toThrow(/no existe o no está activo/);
    await expect(createQuote(ids.userA, ["99999999-0000-4000-8000-000000000000"])).rejects.toThrow(/no existe o no está activo/);
    await expect(createQuote(ids.userA, [])).rejects.toThrow(/vacía/);
    await expect(createQuote(ids.userA, [ids.tsh], { source: "hack" })).rejects.toThrow(/origen inválido/);
  });

  it("rechaza usuarios inactivos, organizaciones inactivas y peticiones anónimas", async () => {
    await expect(createQuote(ids.inactiveUser, [ids.tsh])).rejects.toThrow(/usuario inactivo/);
    await expect(createQuote(ids.userInactiveOrg, [ids.tsh])).rejects.toThrow(/organización inactiva/);
    await expect(asUser(db, null, () => db.query("select public.create_quote($1::uuid[])", [[ids.tsh]]))).rejects.toThrow(/permission denied/);
  });

  it("no acepta una foto de otro usuario", async () => {
    const { rows } = await db.query<{ id: string }>(`insert into public.photo_jobs (user_id, organization_id) values ('${ids.userB}', '${ids.orgB}') returning id`);
    await expect(createQuote(ids.userA, [ids.tsh], { source: "photo", photoJobId: rows[0]!.id })).rejects.toThrow(/foto inválida/);
    const own = await createQuote(ids.userB, [ids.tsh], { source: "photo", photoJobId: rows[0]!.id });
    expect(Number(own.total_bs)).toBe(80);
  });

  it("los usuarios no pueden insertar cotizaciones ni ítems directamente (solo vía create_quote)", async () => {
    await expect(asUser(db, ids.userA, () => db.query(
      `insert into public.quotes (organization_id, created_by, tariff_name, total_bs, source, valid_until) values ('${ids.orgA}', '${ids.userA}', 'x', 1, 'manual', current_date)`
    ))).rejects.toThrow(/row-level security/);
  });
});

describe("RLS de cotizaciones", () => {
  it("un member ve solo sus cotizaciones; org_admin ve las de su organización; admin ve todo", async () => {
    const a1 = await createQuote(ids.userA, [ids.tsh], { patient: "Paciente de A" });
    const a2 = await createQuote(ids.userA2, [ids.tsh]);
    const b = await createQuote(ids.userB, [ids.tsh]);

    const seenByA = await visibleQuoteIds(ids.userA);
    expect(seenByA).toContain(a1.id);
    expect(seenByA).not.toContain(a2.id);
    expect(seenByA).not.toContain(b.id);

    const seenByOrgAdmin = await visibleQuoteIds(ids.orgAdminA);
    expect(seenByOrgAdmin).toEqual(expect.arrayContaining([a1.id, a2.id]));
    expect(seenByOrgAdmin).not.toContain(b.id);

    expect(await visibleQuoteIds(ids.admin)).toEqual(expect.arrayContaining([a1.id, a2.id, b.id]));
    expect(await visibleQuoteIds(null)).toEqual([]);
  });

  it("los ítems siguen la visibilidad de su cotización", async () => {
    const b = await createQuote(ids.userB, [ids.glicemia]);
    const itemsSeenByA = await asUser(db, ids.userA, async () =>
      (await db.query("select * from public.quote_items where quote_id = $1", [b.id])).rows);
    expect(itemsSeenByA).toEqual([]);
    const itemsSeenByB = await asUser(db, ids.userB, async () =>
      (await db.query("select * from public.quote_items where quote_id = $1", [b.id])).rows);
    expect(itemsSeenByB).toHaveLength(1);
  });

  it("un usuario desactivado deja de ver incluso sus cotizaciones", async () => {
    await db.exec(`update public.profiles set active = true where user_id = '${ids.inactiveUser}'`);
    const own = await createQuote(ids.inactiveUser, [ids.tsh]);
    await db.exec(`update public.profiles set active = false where user_id = '${ids.inactiveUser}'`);
    expect(await visibleQuoteIds(ids.inactiveUser)).not.toContain(own.id);
  });

  it("un usuario no puede modificar ni borrar cotizaciones", async () => {
    const a = await createQuote(ids.userA, [ids.tsh]);
    await asUser(db, ids.userA, async () => {
      await db.query("update public.quotes set total_bs = 0 where id = $1", [a.id]);
      await db.query("delete from public.quotes where id = $1", [a.id]);
    });
    const { rows } = await db.query<{ total_bs: string }>("select total_bs from public.quotes where id = $1", [a.id]);
    expect(Number(rows[0]!.total_bs)).toBe(80);
  });
});

describe("RLS de catálogo, tarifas y perfiles", () => {
  it("los precios de tarifa no son legibles por usuarios (solo llegan por /api/catalog)", async () => {
    const rows = await asUser(db, ids.userA, async () => (await db.query("select * from public.tariff_prices")).rows);
    expect(rows).toEqual([]);
  });

  it("cada usuario ve su organización y su tarifa, no las de otros", async () => {
    const orgs = await asUser(db, ids.userA, async () => (await db.query<{ id: string }>("select id from public.organizations")).rows.map((row) => row.id));
    expect(orgs).toEqual([ids.orgA]);
    const tariffs = await asUser(db, ids.userB, async () => (await db.query("select id from public.tariffs")).rows);
    expect(tariffs).toEqual([]);
  });

  it("un usuario no puede cambiarse el rol ni la organización", async () => {
    await asUser(db, ids.userA, () => db.query(`update public.profiles set role = 'admin', organization_id = '${ids.orgB}' where user_id = '${ids.userA}'`));
    const { rows } = await db.query<{ role: string; organization_id: string }>("select role, organization_id from public.profiles where user_id = $1", [ids.userA]);
    expect(rows[0]).toEqual({ role: "member", organization_id: ids.orgA });
  });

  it("mark_password_changed solo afecta al propio perfil", async () => {
    await asUser(db, ids.userA, () => db.query("select public.mark_password_changed()"));
    const { rows } = await db.query<{ user_id: string; must_change_password: boolean }>(
      "select user_id, must_change_password from public.profiles where user_id in ($1, $2)", [ids.userA, ids.userA2]
    );
    const byUser = Object.fromEntries(rows.map((row) => [row.user_id, row.must_change_password]));
    expect(byUser).toEqual({ [ids.userA]: false, [ids.userA2]: true });
  });
});

describe("plantillas y frecuentes", () => {
  it("las plantillas son privadas de su dueño", async () => {
    await asUser(db, ids.userA, () => db.query("insert into public.quote_templates (name, lab_test_ids) values ('Chequeo', $1::uuid[])", [[ids.hemograma, ids.glicemia]]));
    const mine = await asUser(db, ids.userA, async () => (await db.query("select name from public.quote_templates")).rows);
    const others = await asUser(db, ids.userA2, async () => (await db.query("select name from public.quote_templates")).rows);
    expect(mine).toEqual([{ name: "Chequeo" }]);
    expect(others).toEqual([]);
    await expect(asUser(db, ids.userA2, () => db.query(`insert into public.quote_templates (owner_user_id, name, lab_test_ids) values ('${ids.userA}', 'Intruso', $1::uuid[])`, [[ids.tsh]])))
      .rejects.toThrow(/row-level security/);
  });

  it("frequent_studies cuenta solo las cotizaciones del propio usuario", async () => {
    const rows = await asUser(db, ids.userA2, async () =>
      (await db.query<{ lab_test_id: string; uses: number }>("select * from public.frequent_studies(5)")).rows);
    // userA2 solo cotizó TSH (una vez) en esta suite.
    expect(rows.map((row) => [row.lab_test_id, Number(row.uses)])).toEqual([[ids.tsh, 1]]);
  });
});

describe("importación de tarifas (admin_set_tariff_prices)", () => {
  const prices = (rows: Array<[string, number]>) => JSON.stringify(rows.map(([lab_test_id, price_bs]) => ({ lab_test_id, price_bs })));

  it("solo el service role puede ejecutarla", async () => {
    await expect(asUser(db, ids.admin, () => db.query("select public.admin_set_tariff_prices($1, $2::jsonb)", [ids.tarifaA, prices([[ids.tsh, 1]])])))
      .rejects.toThrow(/permission denied/);
  });

  it("actualiza y agrega precios; con reemplazo, borra los que no vienen en el archivo", async () => {
    const asService = async <T>(fn: () => Promise<T>) => {
      await db.exec("set role service_role");
      try { return await fn(); } finally { await db.exec("reset role"); }
    };
    const { rows: tariff } = await db.query<{ id: string }>("insert into public.tariffs (name) values ('Prueba import') returning id");
    const tariffId = tariff[0]!.id;
    const priceMap = async () => Object.fromEntries((await db.query<{ lab_test_id: string; price_bs: string }>(
      "select lab_test_id, price_bs from public.tariff_prices where tariff_id = $1", [tariffId]
    )).rows.map((row) => [row.lab_test_id, Number(row.price_bs)]));

    await asService(() => db.query("select public.admin_set_tariff_prices($1, $2::jsonb)", [tariffId, prices([[ids.hemograma, 30], [ids.tsh, 70]])]));
    expect(await priceMap()).toEqual({ [ids.hemograma]: 30, [ids.tsh]: 70 });

    await asService(() => db.query("select public.admin_set_tariff_prices($1, $2::jsonb)", [tariffId, prices([[ids.glicemia, 15]])]));
    expect(await priceMap()).toEqual({ [ids.hemograma]: 30, [ids.tsh]: 70, [ids.glicemia]: 15 });

    await asService(() => db.query("select public.admin_set_tariff_prices($1, $2::jsonb, true)", [tariffId, prices([[ids.tsh, 75]])]));
    expect(await priceMap()).toEqual({ [ids.tsh]: 75 });
  });
});

describe("fotos y gasto de IA", () => {
  it("cada usuario ve solo sus fotos; el gasto de IA no es visible para usuarios", async () => {
    await db.exec(`insert into public.photo_jobs (user_id, organization_id) values ('${ids.userA}', '${ids.orgA}')`);
    await db.exec(`insert into public.ai_usage (label, provider, model, cost_usd) values ('reader', 'openai', 'm', 0.01)`);
    const jobsSeenByA2 = await asUser(db, ids.userA2, async () => (await db.query("select id from public.photo_jobs")).rows);
    expect(jobsSeenByA2).toEqual([]);
    const jobsSeenByA = await asUser(db, ids.userA, async () => (await db.query("select id from public.photo_jobs")).rows);
    expect(jobsSeenByA.length).toBeGreaterThan(0);
    const usage = await asUser(db, ids.admin, async () => (await db.query("select * from public.ai_usage")).rows);
    expect(usage).toEqual([]);
  });

  it("crea el bucket privado de fotos", async () => {
    const { rows } = await db.query<{ public: boolean }>("select public from storage.buckets where id = 'quote-photos'");
    expect(rows).toEqual([{ public: false }]);
  });
});
