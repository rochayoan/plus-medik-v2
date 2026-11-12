import { describe, expect, it, vi } from "vitest";
import type { AuditRepository } from "../src/audit.js";
import { processTurns, type IncomingTurn } from "../src/turns.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";

// 12-nov: un paciente de prueba llegó al tope de respuestas por día; el agente dejó de contestar SIN avisar a nadie (ni al paciente ni al CRM). Ahora el tope sigue frenando los bucles, pero un paciente
// bloqueado queda visible en el CRM para que una persona lo atienda.
const from = "59170000001";
const lease = { owner: "owner", fence: 1 };
const turn = (text: string, id: string): IncomingTurn => ({ kind: "TEXT", text, from, messageId: id });

function build(options: { reservation: string; submit?: (ctx: unknown, cases: unknown) => Promise<unknown[]> }) {
  const audit = {
    claim: vi.fn(async () => ({ kind: "claimed" as const, runId: "run-cap", lease })),
    renewLease: vi.fn(async () => true),
    recordIgnored: vi.fn(async () => undefined),
    recordFailure: vi.fn(async () => undefined),
    recordReply: vi.fn(async () => undefined),
    reserveSend: vi.fn(async () => options.reservation as never),
    confirmSend: vi.fn(async () => "proceed" as const)
  } as unknown as AuditRepository;
  const sendText = vi.fn(async () => undefined);
  const submit = vi.fn(options.submit ?? (async () => [{ state: "REGISTERED" }]));
  const log = vi.fn();
  const deps = {
    audit, sendText, loadCatalog: vi.fn(async () => []), analyze: vi.fn(async () => { throw new Error("NO DEBE EJECUTARSE"); }),
    downloadImage: vi.fn(async () => ({ bytes: new Uint8Array() })),
    log,
    turns: { handlers: { text: vi.fn(async () => ({ body: "Respuesta" })) }, contactKeyFor: () => "a".repeat(64), crmHandoff: { submit } } as unknown as NonNullable<QuoteDeps["turns"]>
  } as unknown as QuoteDeps;
  return { deps, sendText, submit, log };
}

describe("tope de respuestas: un paciente bloqueado se avisa al CRM", () => {
  it("con el envío limitado no se contesta y se registra UN caso en el CRM con el mensaje del paciente", async () => {
    const { deps, sendText, submit } = build({ reservation: "limited" });
    await processTurns([turn("quiero cotizar hemograma", "m-1")], deps);
    expect(sendText).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(1);
    expect((submit.mock.calls[0] as unknown[])[1]).toEqual([{ kapsoMessageId: "m-1", contactPhone: from, kind: "CONVERSATION", reasons: ["HUMAN_REQUEST"] }]);
  });
  it("si el aviso al CRM falla, no cambia nada: igualmente no se contesta y no se lanza error", async () => {
    const { deps, sendText, submit, log } = build({ reservation: "limited", submit: async () => { throw new Error("CRM caído"); } });
    await expect(processTurns([turn("hola", "m-2")], deps)).resolves.toBeDefined();
    expect(sendText).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("reply_withheld_handoff", { state: "FAILED" });
  });
  it("sin tope alcanzado se contesta normal y no se crea ningún caso", async () => {
    const { deps, sendText, submit } = build({ reservation: "reserved" });
    await processTurns([turn("hola", "m-3")], deps);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });
  it("otros motivos (pausa humana, carrera) no crean casos: solo el límite", async () => {
    for (const reservation of ["blocked", "superseded", "lost"]) {
      const { deps, submit } = build({ reservation });
      await processTurns([turn("hola", `m-${reservation}`)], deps);
      expect(submit, reservation).not.toHaveBeenCalled();
    }
  });
});
