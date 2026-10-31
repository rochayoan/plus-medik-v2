import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuoteDeps } from "../src/whatsapp-quote.js";

// Sin la puerta del piloto, TODOS los contactos (texto y fotografías) usan la misma ruta de turnos; la ruta anterior de fotos ya no se usa. ALLOWED_PHONES sigue siendo un filtro independiente.

const spies = vi.hoisted(() => ({
  turns: vi.fn(async (_turns: unknown, _deps: unknown) => []),
  image: vi.fn(async (_image: unknown, _deps: unknown) => "sent")
}));
vi.mock("../src/turns.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/turns.js")>(), processTurns: spies.turns }));
vi.mock("../src/whatsapp-quote.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/whatsapp-quote.js")>(), handleImageMessage: spies.image }));
import { handleKapsoWebhook } from "../src/kapso-webhook.js";

const SECRET = "synthetic-webhook-secret";
const PHONES = ["59170000001", "59170000002", "59170000003"];
const stamp = () => String(Math.floor(Date.now() / 1000));
const incoming = (phone: string, kind: "text" | "image", id: string) => ({
  message: { id, from: phone, type: kind, timestamp: stamp(), kapso: { direction: "inbound", origin: "cloud_api" }, ...(kind === "text" ? { text: { body: "cotiza hemograma" } } : { image: { id: "media-" + id } }) },
  phone_number_id: "123"
});
function signed(data: unknown, batch = false): Request {
  const body = JSON.stringify(data);
  return new Request("https://test.example/api/kapso/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-webhook-event": "whatsapp.message.received", ...(batch ? { "x-webhook-batch": "true" } : {}), "x-webhook-signature": createHmac("sha256", SECRET).update(body).digest("hex") } });
}
function deps(allowedPhones?: string) {
  const scheduled: Promise<unknown>[] = [];
  const quote = { turns: { handlers: { text: async () => ({ body: "texto de prueba" }) } }, requireAuditGuard: true, log: vi.fn() } as unknown as QuoteDeps;
  // Sin textPilotPhone ni legacyQuote: exactamente la configuración con la puerta del piloto apagada.
  return { scheduled, quote, input: { secret: SECRET, allowedPhones, quote, schedule: (task: Promise<unknown>) => { scheduled.push(task); }, log: vi.fn() } };
}
beforeEach(() => {
  spies.turns.mockClear();
  spies.image.mockClear();
});

describe("todos los contactos por la ruta de turnos", () => {
  it.each(PHONES)("el texto de %s entra a los turnos", async (phone) => {
    const d = deps();
    const res = await handleKapsoWebhook(signed(incoming(phone, "text", "t-" + phone)), d.input);
    expect(await res.text()).toBe("ok");
    expect(spies.turns).toHaveBeenCalledTimes(1);
    expect((spies.turns.mock.calls[0]![0] as Array<{ from: string; kind: string }>).map((turn) => `${turn.from}:${turn.kind}`)).toEqual([`${phone}:TEXT`]);
  });

  it.each(PHONES)("la fotografía de %s entra a los turnos (con el mismo tope) y NO a la ruta anterior", async (phone) => {
    const d = deps();
    await handleKapsoWebhook(signed(incoming(phone, "image", "i-" + phone)), d.input);
    expect((spies.turns.mock.calls[0]![0] as Array<{ from: string; kind: string }>).map((turn) => `${turn.from}:${turn.kind}`)).toEqual([`${phone}:IMAGE`]);
    expect(spies.image).not.toHaveBeenCalled();
  });

  it("un lote mixto de varios pacientes (texto y fotos) va completo por los turnos, sin perder ni duplicar nada", async () => {
    const d = deps();
    const batch = { type: "message.received", batch: true, data: [incoming(PHONES[0]!, "text", "a"), incoming(PHONES[1]!, "image", "b"), incoming(PHONES[2]!, "image", "c"), incoming(PHONES[0]!, "image", "d")] };
    await handleKapsoWebhook(signed(batch, true), d.input);
    expect(spies.turns).toHaveBeenCalledTimes(1);
    expect((spies.turns.mock.calls[0]![0] as Array<{ from: string; kind: string }>).map((turn) => `${turn.from}:${turn.kind}`).sort()).toEqual([`${PHONES[0]}:IMAGE`, `${PHONES[0]}:TEXT`, `${PHONES[1]}:IMAGE`, `${PHONES[2]}:IMAGE`]);
    expect(spies.image).not.toHaveBeenCalled();
  });

  it("todos los turnos se procesan con la misma configuración (la que lleva el tope)", async () => {
    const d = deps();
    await handleKapsoWebhook(signed(incoming(PHONES[0]!, "image", "x")), d.input);
    await handleKapsoWebhook(signed(incoming(PHONES[1]!, "text", "y")), d.input);
    expect(spies.turns.mock.calls.map((call) => call[1])).toEqual([d.quote, d.quote]);
  });

  it("ALLOWED_PHONES sigue filtrando por su cuenta: lo que no está en la lista no se procesa", async () => {
    const d = deps(PHONES[0]);
    expect(await (await handleKapsoWebhook(signed(incoming(PHONES[1]!, "text", "t1")), d.input)).text()).toBe("ignored");
    expect(await (await handleKapsoWebhook(signed(incoming(PHONES[1]!, "image", "i1")), d.input)).text()).toBe("ignored");
    expect(spies.turns).not.toHaveBeenCalled();
    await handleKapsoWebhook(signed(incoming(PHONES[0]!, "image", "i2")), d.input);
    expect(spies.turns).toHaveBeenCalledTimes(1);
  });

  it("una firma inválida no procesa nada", async () => {
    const d = deps();
    const bad = new Request("https://test.example/api/kapso/webhook", { method: "POST", body: JSON.stringify(incoming(PHONES[0]!, "text", "z")), headers: { "x-webhook-signature": "00" } });
    expect((await handleKapsoWebhook(bad, d.input)).status).toBe(401);
    expect(spies.turns).not.toHaveBeenCalled();
  });
});
