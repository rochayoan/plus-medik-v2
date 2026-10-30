import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuoteDeps } from "../src/whatsapp-quote.js";

const spies = vi.hoisted(() => ({
  turns: vi.fn(async (_turns: unknown, _deps: unknown) => []),
  image: vi.fn(async (_image: unknown, _deps: unknown) => "sent")
}));
vi.mock("../src/turns.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/turns.js")>(),
  processTurns: spies.turns
}));
vi.mock("../src/whatsapp-quote.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/whatsapp-quote.js")>(),
  handleImageMessage: spies.image
}));
import { handleKapsoWebhook } from "../src/kapso-webhook.js";

const PILOT = "59170000000";
const OTHER = "59170000001";
const SECRET = "synthetic-webhook-secret";
const stamp = () => String(Math.floor(Date.now() / 1000));
const incoming = (phone: string, kind: "text" | "image", id: string) => ({
  message: {
    id, from: phone, type: kind, timestamp: stamp(),
    kapso: { direction: "inbound", origin: "cloud_api" },
    ...(kind === "text" ? { text: { body: "cotiza hemograma" } } : { image: { id: "media-" + id } })
  },
  phone_number_id: "123"
});
function signed(data: unknown, batch = false): Request {
  const body = JSON.stringify(data);
  return new Request("https://test.example/api/kapso/webhook", {
    method: "POST", body,
    headers: {
      "content-type": "application/json",
      "x-webhook-event": "whatsapp.message.received",
      ...(batch ? { "x-webhook-batch": "true" } : {}),
      "x-webhook-signature": createHmac("sha256", SECRET).update(body).digest("hex")
    }
  });
}

function deps(allowedPhones?: string) {
  const scheduled: Promise<unknown>[] = [];
  const quote = {
    turns: { handlers: { text: async () => ({ body: "texto de prueba" }) } },
    requireAuditGuard: true,
    log: vi.fn()
  } as unknown as QuoteDeps;
  const legacy = { ...quote, turns: undefined, requireAuditGuard: false } as QuoteDeps;
  return {
    scheduled, quote, legacy,
    input: {
      secret: SECRET, allowedPhones, quote,
      textPilotPhone: PILOT,
      legacyQuote: legacy,
      schedule: (task: Promise<unknown>) => { scheduled.push(task); },
      log: vi.fn()
    }
  };
}
beforeEach(() => {
  spies.turns.mockClear();
  spies.image.mockClear();
});

describe("piloto de texto por contacto: fotografías heredadas intactas", () => {
  it("un texto de otro paciente se ignora, aunque las banderas globales estén encendidas", async () => {
    const d = deps();
    const res = await handleKapsoWebhook(signed(incoming(OTHER, "text", "t-other")), d.input);
    expect(await res.text()).toBe("ignored");
    expect(d.scheduled).toHaveLength(0);
    expect(spies.turns).not.toHaveBeenCalled();
    expect(spies.image).not.toHaveBeenCalled();
  });
  it("un texto del piloto entra al modo turnos", async () => {
    const d = deps();
    const res = await handleKapsoWebhook(signed(incoming(PILOT, "text", "t-pilot")), d.input);
    expect(await res.text()).toBe("ok");
    await Promise.all(d.scheduled);
    expect(spies.turns).toHaveBeenCalledTimes(1);
    expect(spies.turns.mock.calls[0]![0]).toMatchObject([{ from: PILOT, kind: "TEXT" }]);
    expect(spies.image).not.toHaveBeenCalled();
  });
  it("una fotografía de otro paciente conserva auditoría y ruta previas", async () => {
    const d = deps();
    const res = await handleKapsoWebhook(signed(incoming(OTHER, "image", "im-other")), d.input);
    expect(await res.text()).toBe("ok");
    await Promise.all(d.scheduled);
    expect(spies.image).toHaveBeenCalledTimes(1);
    expect(spies.image.mock.calls[0]![1]).toBe(d.legacy);
    expect(d.legacy.requireAuditGuard).toBe(false);
    expect(d.legacy.turns).toBeUndefined();
    expect(spies.turns).not.toHaveBeenCalled();
  });
  it("un lote mixto aísla el piloto sin perder ni duplicar fotografías", async () => {
    const d = deps();
    const data = { batch: true, data: [
      incoming(PILOT, "text", "t-pilot"),
      incoming(OTHER, "text", "t-other"),
      incoming(OTHER, "image", "im-other"),
      incoming(PILOT, "image", "im-pilot")
    ] };
    const res = await handleKapsoWebhook(signed(data, true), d.input);
    expect(await res.text()).toBe("ok");
    await Promise.all(d.scheduled);
    expect(spies.turns).toHaveBeenCalledTimes(1);
    expect(spies.turns.mock.calls[0]![0]).toHaveLength(2);
    expect(spies.image).toHaveBeenCalledTimes(1);
    expect(spies.image.mock.calls[0]![0]).toMatchObject({ from: OTHER, messageId: "im-other" });
  });
  it("ALLOWED_PHONES permanece independiente y puede incluir varios pacientes", async () => {
    const d = deps("59170000000,59170000001");
    const res = await handleKapsoWebhook(signed(incoming(OTHER, "image", "im-other")), d.input);
    expect(await res.text()).toBe("ok");
    await Promise.all(d.scheduled);
    expect(spies.image).toHaveBeenCalledTimes(1);
  });
});
