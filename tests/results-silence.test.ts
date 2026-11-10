import { describe, expect, it, vi } from "vitest";
import { isResultsOnlyRequest } from "../src/results-silence.js";
import { processTurns, type IncomingTurn } from "../src/turns.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";
import type { AuditRepository } from "../src/audit.js";

const from = "59170000000";
const turn = (text: string, id: string): IncomingTurn => ({ kind: "TEXT", text, from, messageId: id });
const lease = { owner: "owner", fence: 1 };

describe("resultados: silencio determinista sin IA ni mensajes", () => {
  it.each([
    "¿Ya están mis resultados?",
    "Me pueden enviar los resultados por favor",
    "Quiero el link para descargar mis resultados",
    "¿Ya salió el hemograma?",
    "¿Cuándo me entregan el resultado?",
    "Necesito la contraseña de mis resultados"
  ])("calla para una consulta exclusiva: %s", (message) => {
    expect(isResultsOnlyRequest(message)).toBe(true);
  });
  it.each([
    "Quiero cotizar un hemograma y saber mis resultados",
    "¿Qué significan mis resultados?",
    "¿Mi resultado positivo significa una enfermedad?",
    "Mis resultados y los horarios de atención",
    "Estoy hospitalizado, necesito resultados urgente",
    "Quiero hablar con una persona por mis resultados",
    "El enlace de mis resultados no funciona",
    "¿Cuánto cuesta la prueba para mis resultados?",
    "hemograma listo",
    "¿Cuánto demora el resultado de glucosa?",
    "¿Cuánto tiempo tardan los resultados?"
  ])("no silencia una petición adicional, sensible o ambigua: %s", (message) => {
    expect(isResultsOnlyRequest(message)).toBe(false);
  });

  it("todo un lote de resultados se audita como NO_REPLY; ningún modelo, catálogo ni Kapso se llama", async () => {
    const handler = vi.fn(async () => ({ body: "NO DEBE SALIR" }));
    const recordIgnored = vi.fn(async () => undefined);
    const audit = {
      claim: vi.fn(async () => ({ kind: "claimed" as const, runId: "run-1", lease })),
      renewLease: vi.fn(async () => true),
      recordIgnored,
      recordFailure: vi.fn(async () => undefined),
      recordReply: vi.fn(async () => undefined),
      reserveSend: vi.fn(async () => "reserved" as const),
      confirmSend: vi.fn(async () => "proceed" as const)
    } as unknown as AuditRepository;
    const sendText = vi.fn(async () => undefined);
    const loadCatalog = vi.fn(async () => []);
    const analyze = vi.fn(async () => { throw new Error("NO DEBE EJECUTARSE"); });
    const deps: QuoteDeps = {
      audit, sendText, loadCatalog, analyze,
      downloadImage: vi.fn(async () => ({ bytes: new Uint8Array() })),
      log: vi.fn(),
      turns: { handlers: { text: handler }, contactKeyFor: () => "a".repeat(64) } as NonNullable<QuoteDeps["turns"]>
    };
    await processTurns([turn("¿Ya están mis resultados?", "r1"), turn("Me pasan el link por favor", "r2")], deps);
    expect(recordIgnored).toHaveBeenCalledTimes(2);
    expect(recordIgnored).toHaveBeenCalledWith("run-1", "NO_REPLY", lease);
    expect(handler).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(loadCatalog).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
    expect(audit.reserveSend).not.toHaveBeenCalled();
  });
});
