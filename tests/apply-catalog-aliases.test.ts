import { describe, expect, it, vi } from "vitest";
import {
  APPROVED_ALIASES,
  EXPECTED_EXISTING_ALIASES,
  PROPOSED_ROWS,
  checkPreconditions,
  run,
  toInsertPayload,
  verifyInserted,
  type Connection,
  type Snapshot
} from "../scripts/apply-catalog-aliases.js";
import { normalizeStudyKey } from "../src/consensus.js";

const activeTests = APPROVED_ALIASES.map(({ labTestId, alias }, index) => ({
  id: labTestId,
  code: String(100 + index),
  name: `Estudio ${alias}`,
  normalized_name: `estudio ${index}`,
  active: true
}));

// 13 aliases previos (los que existen hoy en Supabase).
const baseSnapshot = (): Snapshot => ({
  tests: [...activeTests],
  aliases: Array.from({ length: EXPECTED_EXISTING_ALIASES }, (_, i) => ({
    id: `old-${i}`,
    lab_test_id: "otro",
    alias: `Viejo ${i}`,
    normalized_alias: `viejo ${i}`
  }))
});

describe("alias aprobados", () => {
  it("son exactamente los 7 aprobados y excluyen Orina Completa, TSH y Perfil Tiroideo", () => {
    expect(PROPOSED_ROWS.map((row) => row.alias)).toEqual([
      "Hemograma Completo",
      "DHEA-S",
      "FSH",
      "LH",
      "Progesterona [dia 21 del ciclo]",
      "Prolactina [PRL]",
      "Estradiol [E2]"
    ]);
    expect(PROPOSED_ROWS.map((row) => row.normalized_alias)).toEqual([
      "hemograma completo",
      "dhea s",
      "fsh",
      "lh",
      "progesterona dia 21 del ciclo",
      "prolactina prl",
      "estradiol e2"
    ]);
    const excluded = ["orina completa", "tsh", "perfil tiroideo"];
    expect(PROPOSED_ROWS.some((row) => excluded.includes(row.normalized_alias))).toBe(false);
  });

  it("el payload del INSERT lleva solo lab_test_id y alias (normalized_alias es columna generada)", () => {
    const payload = toInsertPayload(PROPOSED_ROWS);
    expect(payload).toHaveLength(7);
    for (const row of payload) expect(Object.keys(row).sort()).toEqual(["alias", "lab_test_id"]);
  });
});

describe("checkPreconditions", () => {
  it("pasa cuando todo está limpio", () => {
    expect(checkPreconditions(baseSnapshot()).every((check) => check.problems.length === 0)).toBe(true);
  });

  it("falla si un UUID está inactivo o no existe", () => {
    const snapshot = baseSnapshot();
    snapshot.tests[0] = { ...snapshot.tests[0]!, active: false };
    snapshot.tests.splice(1, 1);
    const checks = checkPreconditions(snapshot);
    expect(checks[0]!.problems).toContain("el lab_test no está activo");
    expect(checks[1]!.problems).toContain("el UUID no existe en lab_tests");
  });

  it("falla si el normalized_alias ya existe", () => {
    const snapshot = baseSnapshot();
    snapshot.aliases.push({ id: "old-x", lab_test_id: "x", alias: "fsh", normalized_alias: "fsh" });
    expect(checkPreconditions(snapshot)[2]!.problems).toContain("el normalized_alias ya existe en lab_test_aliases");
  });

  it("falla si choca con el normalized_name de un lab_test activo, pero no con uno inactivo", () => {
    const active = baseSnapshot();
    active.tests.push({ id: "z", code: null, name: "LH", normalized_name: "lh", active: true });
    expect(checkPreconditions(active)[3]!.problems).toContain("choca con el normalized_name de un lab_test activo");

    const inactive = baseSnapshot();
    inactive.tests.push({ id: "z", code: null, name: "LH", normalized_name: "lh", active: false });
    expect(checkPreconditions(inactive)[3]!.problems).toEqual([]);
  });
});

describe("verifyInserted", () => {
  const afterOk = (): Snapshot => {
    const before = baseSnapshot();
    return {
      tests: before.tests,
      aliases: [...before.aliases, ...PROPOSED_ROWS.map((row, i) => ({ id: `new-${i}`, ...row }))]
    };
  };

  it("acepta exactamente 7 filas nuevas con el UUID correcto y el normalized_alias esperado", () => {
    expect(verifyInserted(baseSnapshot(), afterOk()).ok).toBe(true);
  });

  it("detecta filas faltantes, de más o con UUID equivocado", () => {
    const missing = afterOk();
    missing.aliases.pop();
    expect(verifyInserted(baseSnapshot(), missing).ok).toBe(false);

    const extra = afterOk();
    extra.aliases.push({ id: "extra", lab_test_id: "q", alias: "otro", normalized_alias: "otro" });
    expect(verifyInserted(baseSnapshot(), extra).ok).toBe(false);

    const wrong = afterOk();
    wrong.aliases[EXPECTED_EXISTING_ALIASES + 1] = { ...wrong.aliases[EXPECTED_EXISTING_ALIASES + 1]!, lab_test_id: "uuid-equivocado" };
    expect(verifyInserted(baseSnapshot(), wrong).problems.join()).toContain("apunta a uuid-equivocado");
  });

  it("detecta si el normalized_alias generado por la base difiere del calculado localmente", () => {
    const drift = afterOk();
    drift.aliases[EXPECTED_EXISTING_ALIASES] = { ...drift.aliases[EXPECTED_EXISTING_ALIASES]!, normalized_alias: "otra cosa" };
    const result = verifyInserted(baseSnapshot(), drift);
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain("normalized_alias generado por la base");
  });
});

// Base falsa en memoria que imita Supabase: normalized_alias es columna generada.
function fakeDatabase(initial: Snapshot, options: { postBehavior?: "ok" | "drop-one" | "wrong-generated" } = {}) {
  const state = { tests: [...initial.tests], aliases: [...initial.aliases] };
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: path, body });
    if (method === "POST") {
      if ((body as Array<Record<string, unknown>>).some((row) => "normalized_alias" in row)) {
        return new Response(JSON.stringify({ message: 'Column "normalized_alias" is a generated column.' }), { status: 400 });
      }
      const rows = (options.postBehavior === "drop-one" ? body.slice(1) : body) as Array<{ lab_test_id: string; alias: string }>;
      const created = rows.map((row, i) => ({
        id: `new-${state.aliases.length + i}`,
        ...row,
        normalized_alias: options.postBehavior === "wrong-generated" ? "mal" : normalizeStudyKey(row.alias)
      }));
      state.aliases.push(...created);
      return new Response(JSON.stringify(created), { status: 201 });
    }
    return new Response(JSON.stringify(path.includes("lab_test_aliases") ? state.aliases : state.tests), { status: 200 });
  }) as unknown as typeof fetch;
  const connection: Connection = { baseUrl: "https://example.test", serviceKey: "super-secret-key", fetchFn };
  return { connection, calls, state };
}

describe("run", () => {
  it("dry-run (sin --apply) no escribe: solo GET", async () => {
    const db = fakeDatabase(baseSnapshot());
    const lines: string[] = [];
    const result = await run(db.connection, { apply: false }, (line) => lines.push(line));
    expect(result).toEqual({ exitCode: 0, wrote: false });
    expect(db.calls.every((call) => call.method === "GET")).toBe(true);
    const output = lines.join("\n");
    expect(output).toContain("DRY-RUN");
    expect(output).toContain(`Conteo de aliases OK: ${EXPECTED_EXISTING_ALIASES}`);
    expect(output).toContain("normalized_alias esperado: 'dhea s'");
    expect(output).not.toContain("super-secret-key");
  });

  it("--apply inserta los 7 en un solo POST con solo lab_test_id y alias, y verifica por GET", async () => {
    const db = fakeDatabase(baseSnapshot());
    const result = await run(db.connection, { apply: true }, () => {});
    expect(result).toEqual({ exitCode: 0, wrote: true });
    const posts = db.calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toContain("/lab_test_aliases");
    expect(posts[0]!.body).toEqual(toInsertPayload(PROPOSED_ROWS));
    expect(posts[0]!.body.every((row: Record<string, unknown>) => !("normalized_alias" in row))).toBe(true);
    expect(db.state.aliases).toHaveLength(EXPECTED_EXISTING_ALIASES + 7);
  });

  it("--apply aborta sin escribir si hay más (o menos) de 13 aliases", async () => {
    const withExtra = baseSnapshot();
    withExtra.aliases.push({ id: "partial", lab_test_id: "x", alias: "Intento previo", normalized_alias: "intento previo" });
    const dbExtra = fakeDatabase(withExtra);
    const lines: string[] = [];
    expect(await run(dbExtra.connection, { apply: true }, (line) => lines.push(line))).toEqual({ exitCode: 1, wrote: false });
    expect(dbExtra.calls.some((call) => call.method === "POST")).toBe(false);
    expect(lines.join("\n")).toContain("FALLA conteo de aliases");

    const fewer = baseSnapshot();
    fewer.aliases.pop();
    const dbFewer = fakeDatabase(fewer);
    expect(await run(dbFewer.connection, { apply: true }, () => {})).toEqual({ exitCode: 1, wrote: false });
    expect(dbFewer.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("el dry-run también falla si el conteo no es 13", async () => {
    const snapshot = baseSnapshot();
    snapshot.aliases.pop();
    const db = fakeDatabase(snapshot);
    expect(await run(db.connection, { apply: false }, () => {})).toEqual({ exitCode: 1, wrote: false });
  });

  it("--apply aborta sin escribir si una precondición falla", async () => {
    const snapshot = baseSnapshot();
    snapshot.tests[4] = { ...snapshot.tests[4]!, active: false };
    const db = fakeDatabase(snapshot);
    const result = await run(db.connection, { apply: true }, () => {});
    expect(result).toEqual({ exitCode: 1, wrote: false });
    expect(db.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("--apply segunda vez aborta (el conteo ya no es 13 y los aliases existen)", async () => {
    const db = fakeDatabase(baseSnapshot());
    await run(db.connection, { apply: true }, () => {});
    const postsAfterFirst = db.calls.filter((call) => call.method === "POST").length;
    const second = await run(db.connection, { apply: true }, () => {});
    expect(second).toEqual({ exitCode: 1, wrote: false });
    expect(db.calls.filter((call) => call.method === "POST")).toHaveLength(postsAfterFirst);
  });

  it("falla (exit 1) si la verificación posterior no encuentra las 7 filas", async () => {
    const db = fakeDatabase(baseSnapshot(), { postBehavior: "drop-one" });
    expect(await run(db.connection, { apply: true }, () => {})).toEqual({ exitCode: 1, wrote: true });
  });

  it("falla (exit 1) si la columna generada difiere de la normalización local", async () => {
    const db = fakeDatabase(baseSnapshot(), { postBehavior: "wrong-generated" });
    const lines: string[] = [];
    expect(await run(db.connection, { apply: true }, (line) => lines.push(line))).toEqual({ exitCode: 1, wrote: true });
    expect(lines.join("\n")).toContain("normalized_alias generado por la base");
  });

  it("los errores HTTP no incluyen la clave de servicio", async () => {
    const failing = vi.fn(async () => new Response("denied", { status: 401 })) as unknown as typeof fetch;
    const error = await run({ baseUrl: "https://example.test", serviceKey: "super-secret-key", fetchFn: failing }, { apply: false }, () => {}).catch((e: Error) => e);
    expect((error as Error).message).toContain("HTTP 401");
    expect((error as Error).message).not.toContain("super-secret-key");
  });
});
