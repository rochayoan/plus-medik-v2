import { describe, expect, it, vi } from "vitest";
import type { Produced, TurnContext } from "../src/guarded-turn.js";
import { looksLikeIdentification } from "../src/results-silence.js";
import { createAwaitingPersonCheck } from "../src/results-follow-up.js";
import { createNewerTurnCheck, DEFAULT_PHOTO_CONTEXT_WAIT_SECONDS, resolvePhotoContextWaitMs, withPhotoContextWait } from "../src/photo-context-wait.js";

const KEY = "b".repeat(64);
const ctx = (seq: number | undefined = 3): TurnContext => ({ guarded: true, persist: async () => true, ...(seq !== undefined ? { seq } : {}) });
const noQuote: Produced = { kind: "reply", body: "No pude identificar con certeza algunos estudios", result: "no_quote", processingStatus: "COMPLETED" };
const options = (newerTurn: (key: string, seq: number) => Promise<boolean>, waitMs = 45_000) => {
  const sleeps: number[] = [];
  return { sleeps, opts: { waitMs, pollMs: 15_000, contactKeyFor: () => KEY, newerTurn, sleep: async (ms: number) => { sleeps.push(ms); } } };
};

describe("espera de contexto de una foto dudosa", () => {
  it("si el paciente escribe dentro del plazo, la respuesta de la foto se descarta (quiet)", async () => {
    const calls: number[] = [];
    const { opts, sleeps } = options(async () => { calls.push(1); return calls.length >= 2; });
    const produced = await withPhotoContextWait(async () => noQuote, "591", opts)(ctx());
    expect(produced).toMatchObject({ kind: "reply", quiet: true, result: "no_quote" });
    expect(sleeps).toEqual([15_000, 15_000]);
  });
  it("si no escribe nada, espera TODO el plazo y la foto responde como siempre", async () => {
    const { opts, sleeps } = options(async () => false);
    const produced = await withPhotoContextWait(async () => noQuote, "591", opts)(ctx());
    expect(produced).toEqual(noQuote);
    expect(sleeps).toEqual([15_000, 15_000, 15_000]);
  });
  it("una cotización, un silencio, un aviso técnico o la falta de número de turno NO esperan", async () => {
    const newerTurn = vi.fn(async () => false);
    const { opts, sleeps } = options(newerTurn);
    const quoted: Produced = { kind: "reply", body: "cotizacion", result: "quoted", processingStatus: "COMPLETED" };
    const quiet: Produced = { ...noQuote, quiet: true };
    const technical: Produced = { kind: "reply", body: "tecnico", result: "technical_issue", processingStatus: "FAILED", quiet: true };
    for (const produced of [quoted, quiet, technical, { kind: "none" } as Produced]) expect(await withPhotoContextWait(async () => produced, "591", opts)(ctx())).toEqual(produced);
    const withoutSeq: TurnContext = { guarded: true, persist: async () => true };
    expect(await withPhotoContextWait(async () => noQuote, "591", opts)(withoutSeq)).toEqual(noQuote);
    expect(sleeps).toEqual([]);
    expect(newerTurn).not.toHaveBeenCalled();
  });
  it("sin plazo (0) responde de inmediato", async () => {
    const { opts, sleeps } = options(async () => true, 0);
    expect(await withPhotoContextWait(async () => noQuote, "591", opts)(ctx())).toEqual(noQuote);
    expect(sleeps).toEqual([]);
  });
  it("la configuración: 45 s por defecto, número válido, apagado con off", () => {
    expect(resolvePhotoContextWaitMs({})).toBe(DEFAULT_PHOTO_CONTEXT_WAIT_SECONDS * 1000);
    expect(resolvePhotoContextWaitMs({ PLUSMEDIK_PHOTO_CONTEXT_WAIT_SECONDS: "60" })).toBe(60_000);
    expect(resolvePhotoContextWaitMs({ PLUSMEDIK_PHOTO_CONTEXT_WAIT_SECONDS: "off" })).toBe(0);
    expect(resolvePhotoContextWaitMs({ PLUSMEDIK_PHOTO_CONTEXT_WAIT_SECONDS: "999" })).toBe(45_000);
  });
});

describe("lectura del último turno del contacto", () => {
  const check = (body: unknown, ok = true, throws = false) => createNewerTurnCheck({ baseUrl: "https://x.supabase.co", serviceKey: "k", fetchFn: (async () => { if (throws) throw new Error("red"); return new Response(JSON.stringify(body), { status: ok ? 200 : 500 }); }) as unknown as typeof fetch });
  it("hay turno más nuevo solo si last_seq supera el de la foto; ante cualquier duda dice no", async () => {
    expect(await check([{ last_seq: 5 }])(KEY, 3)).toBe(true);
    expect(await check([{ last_seq: 3 }])(KEY, 3)).toBe(false);
    expect(await check([])(KEY, 3)).toBe(false);
    expect(await check({}, false)(KEY, 3)).toBe(false);
    expect(await check([], true, true)(KEY, 3)).toBe(false);
    expect(await check([{ last_seq: 9 }])("clave-invalida", 3)).toBe(false);
  });
});

describe("el dato que llega tras pedir nombre/comprobante de un resultado", () => {
  const check = (rows: unknown, ok = true, throws = false) => createAwaitingPersonCheck({ baseUrl: "https://x.supabase.co", serviceKey: "k", now: () => Date.parse("2026-11-11T22:00:00Z"), fetchFn: (async (url: string) => { if (throws) throw new Error("red"); (check as unknown as { last?: string }).last = url; return new Response(JSON.stringify(rows), { status: ok ? 200 : 500 }); }) as unknown as typeof fetch });
  it("espera a una persona solo si hay una marca RESULTS_READY_CHECK de las últimas 6 h; ante cualquier duda, no", async () => {
    expect(await check([{ run_id: "r" }])(KEY)).toBe(true);
    expect((check as unknown as { last: string }).last).toContain("signature=eq.RESULTS_READY_CHECK");
    expect((check as unknown as { last: string }).last).toContain(encodeURIComponent("2026-11-11T16:00:00.000Z"));
    expect(await check([])(KEY)).toBe(false);
    expect(await check({}, false)(KEY)).toBe(false);
    expect(await check([], true, true)(KEY)).toBe(false);
    expect(await check([{ run_id: "r" }])("clave-invalida")).toBe(false);
  });
  it("solo lo que parece el dato pedido se calla: un nombre sí; una pregunta o un pedido propio, no", () => {
    for (const text of ["Porfidio López Rivero", "María Lenny Cuellar Rojas", "Orden 29150", "Jonh Emmanuel Ramirez Choque 4 años"]) expect(looksLikeIdentification(text)).toBe(true);
    for (const text of ["¿Y cuánto tarda?", "Quiero cotizar un hemograma", "Necesito hablar con una persona", "Hacen estudios a domicilio", "Cuál es la dirección", "Este es el nombre del paciente que necesito para el resultado de la semana pasada urgente", ""]) expect(looksLikeIdentification(text)).toBe(false);
  });
});
