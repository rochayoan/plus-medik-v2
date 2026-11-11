import { describe, expect, it, vi } from "vitest";
import type { AuditRepository } from "../src/audit.js";
import { processTurns, type IncomingTurn } from "../src/turns.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";

const from = "59170000001";
const lease = { owner: "owner", fence: 1 };
const turn = (text: string, id: string): IncomingTurn => ({ kind: "TEXT", text, from, messageId: id });

const build = (awaiting: boolean) => {
  const recordIgnored = vi.fn(async () => undefined);
  const audit = {
    claim: vi.fn(async () => ({ kind: "claimed" as const, runId: "run-f", lease })),
    renewLease: vi.fn(async () => true),
    recordIgnored,
    recordFailure: vi.fn(async () => undefined),
    recordReply: vi.fn(async () => undefined),
    reserveSend: vi.fn(async () => "reserved" as const),
    confirmSend: vi.fn(async () => "proceed" as const)
  } as unknown as AuditRepository;
  const sendText = vi.fn(async () => undefined);
  const handler = vi.fn(async () => ({ body: "Respuesta del manejador" }));
  const awaitingPerson = vi.fn(async () => awaiting);
  const deps = {
    audit, sendText, loadCatalog: vi.fn(async () => []), analyze: vi.fn(async () => { throw new Error("NO DEBE EJECUTARSE"); }),
    downloadImage: vi.fn(async () => ({ bytes: new Uint8Array() })),
    log: vi.fn(),
    turns: { handlers: { text: handler }, contactKeyFor: () => "a".repeat(64), awaitingPerson } as unknown as NonNullable<QuoteDeps["turns"]>
  } as unknown as QuoteDeps;
  return { deps, sendText, handler, recordIgnored, awaitingPerson };
};

describe("tras pedir el nombre o comprobante de un resultado, el dato que llega no se contesta", () => {
  it("un nombre completo o una foto: silencio (la persona de recepción lo atiende)", async () => {
    const { deps, sendText, handler, recordIgnored } = build(true);
    await processTurns([turn("Porfidio López Rivero", "n-1")], deps);
    await processTurns([{ kind: "IMAGE", from, messageId: "img-9", mediaId: "m-9" }], deps);
    expect(sendText).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(recordIgnored).toHaveBeenCalledTimes(2);
  });
  it("una pregunta o un pedido propio SÍ se atiende, aunque se espere a una persona", async () => {
    const { deps, sendText, handler } = build(true);
    await processTurns([turn("Quiero cotizar un hemograma", "n-2")], deps);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
  });
  it("si no se espera a nadie, el nombre se atiende como siempre", async () => {
    const { deps, sendText, handler } = build(false);
    await processTurns([turn("Porfidio López Rivero", "n-3")], deps);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
  });
});
