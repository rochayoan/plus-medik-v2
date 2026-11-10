import { describe, expect, it, vi } from "vitest";
import { classifyKapsoEvent } from "../src/human-control.js";
import { createMessageHistory, HistoryCipherError, type HistoryStore } from "../src/message-history.js";

// Falla del cifrado en tiempo de ejecución: el historial no escribe nada (jamás texto en claro), no lanza y deja solo un código. El cifrado se simula roto para esta prueba.
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return { ...real, createCipheriv: vi.fn(() => { throw new Error("falla simulada del cifrado con TEXTO_CLINICO_SENTINELA_9902"); }) };
});

const KEY = "clave-de-historial-solo-para-pruebas-0123456789";
const PHONE = "59170001234";
const CONTACT = "a".repeat(64);

describe("fallas del cifrado", () => {
  const store = (): HistoryStore & { record: ReturnType<typeof vi.fn> } => ({
    record: vi.fn(async () => "RECORDED" as const), attachText: vi.fn(async () => "UPDATED" as const), delivery: vi.fn(async () => "UPDATED" as const),
    exportPage: vi.fn(async () => ({ rows: [] })), erase: vi.fn(async () => 0), purge: vi.fn(async () => 0), gaps: vi.fn(async () => ({ inbound: [], outbound: [] }))
  });

  it("si el cifrado falla no se escribe NADA (ni en claro), no se lanza y solo queda un código en el registro", async () => {
    const s = store();
    const logs: Array<[string, Record<string, unknown>]> = [];
    const history = createMessageHistory({ store: s, secret: KEY, accountId: "123", contactKeyFor: () => CONTACT, log: (event, data) => { logs.push([event, data]); } });
    const raw = { message: { id: "wamid.T1", timestamp: "1767225600", type: "text", from: PHONE, text: { body: "me duele TEXTO_CLINICO_SENTINELA_9902" }, kapso: { direction: "inbound", origin: "cloud_api" } }, conversation: { phone_number: PHONE, phone_number_id: "123" }, phone_number_id: "123" };
    await expect(history.observe({ raws: [raw], classified: [classifyKapsoEvent(raw, "whatsapp.message.received")], inScope: () => true })).resolves.toBeUndefined();
    await expect(history.recordAgentReply({ to: PHONE, messageId: "wamid.O1", replyTo: "wamid.T1", text: "respuesta", state: "ACCEPTED" })).resolves.toBeUndefined();
    await expect(history.recordTranscript({ from: PHONE, messageId: "wamid.A1", text: "transcripción" })).resolves.toBeUndefined();
    expect(s.record).not.toHaveBeenCalled();
    expect(s.attachText).not.toHaveBeenCalled();
    expect(logs.filter(([event]) => event === "message_history_write_failed").map(([, data]) => data.op).sort()).toEqual(["OBSERVE", "OUT", "TRANSCRIPT"]);
    expect(JSON.stringify(logs)).not.toMatch(/SENTINELA|me duele|falla simulada|5917|wamid/);
  });

  it("una clave ausente o demasiado corta ni siquiera permite crear el historial (la configuración lo deja apagado antes)", () => {
    expect(() => createMessageHistory({ store: store(), secret: "corta", accountId: "123", contactKeyFor: () => CONTACT, log: () => undefined })).toThrow(HistoryCipherError);
  });
});
