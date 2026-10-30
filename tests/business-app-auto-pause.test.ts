import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuoteDeps } from "../src/whatsapp-quote.js";

const spy = vi.hoisted(() => ({ turns: vi.fn(async (_turns: unknown, _deps: unknown) => []) }));
vi.mock("../src/turns.js", async (original) => ({
  ...await original<typeof import("../src/turns.js")>(),
  processTurns: spy.turns
}));
import { handleKapsoWebhook } from "../src/kapso-webhook.js";

const SECRET = "example-only";
const PILOT = "59170000000";
const EXTRA = "59170000001";
const OUTSIDE = "59170000002";
const LAB = "123456";
const textMessage = (phone: string, id: string) => ({
  phone_number_id: LAB,
  conversation: { phone_number: phone },
  message: { id, from: phone, timestamp: String(Math.floor(Date.now() / 1000)),
    type: "text", text: { body: "quiero cotizar" }, kapso: { direction: "inbound", origin: "cloud_api" } }
});
const humanMessage = (phone: string, id: string, origin = "business_app") => ({
  phone_number_id: LAB,
  conversation: { phone_number: phone },
  message: { id, to: phone, timestamp: String(Math.floor(Date.now() / 1000)),
    type: "text", kapso: { direction: "outbound", origin, status: "sent" } }
});
function signed(value: unknown, event: string): Request {
  const body = JSON.stringify(value);
  return new Request("https://example.test/api/kapso/webhook", {
    method: "POST", body, headers: {
      "x-webhook-event": event,
      "x-webhook-signature": createHmac("sha256", SECRET).update(body).digest("hex")
    }
  });
}

function setup() {
  const scheduled: Promise<unknown>[] = [];
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const registerHumanMessage = vi.fn(async () => ({
    outcome: "PAUSED" as const, revision: 1, blockedRuns: 0,
    lateReservedRuns: 0, repliedAfterEventRuns: 0
  }));
  const resumeIfIdle = vi.fn(async () => "NOT_DUE" as const);
  const quote = { turns: { handlers: { text: vi.fn() } } } as unknown as QuoteDeps;
  const deps = {
    secret: SECRET, allowedPhones: [PILOT, EXTRA, OUTSIDE].join(","),
    quote, textPilotPhone: PILOT, textPilotExtraPhones: [EXTRA],
    schedule: (task: Promise<unknown>) => { scheduled.push(task); },
    humanControl: {
      labPhoneNumberId: LAB, contactKeyFor: (_phone: string) => "a".repeat(64),
      covers: (phone: string) => phone === PILOT || phone === EXTRA,
      resumeIdleOnInbound: true,
      attention: {
        registerHumanMessage, resumeIfIdle,
        recordEvent: vi.fn(async () => "RECORDED" as const),
        resume: vi.fn(async () => "ALREADY_ACTIVE" as const),
        status: vi.fn(async () => ({ state: "ACTIVE" as const, revision: 0, exists: false }))
      }
    },
    log: (event: string, data: Record<string, unknown>) => { events.push({ event, data }); }
  };
  return { deps, scheduled, registerHumanMessage, resumeIfIdle, events };
}

beforeEach(() => { spy.turns.mockClear(); });

describe("pausa automática por WhatsApp Business del celular", () => {
  it("la intervención humana afecta al piloto, no a otros contactos", async () => {
    const d = setup();
    expect((await handleKapsoWebhook(signed(humanMessage(EXTRA, "wamid.human"), "whatsapp.message.sent"), d.deps)).status).toBe(200);
    expect(d.registerHumanMessage).toHaveBeenCalledTimes(1);
    expect(d.events.some((x) => x.event === "human_event")).toBe(true);
    expect((await handleKapsoWebhook(signed(humanMessage(OUTSIDE, "wamid.outside"), "whatsapp.message.sent"), d.deps)).status).toBe(200);
    expect(d.registerHumanMessage).toHaveBeenCalledTimes(1);
  });

  it("el propio bot no causa pausa", async () => {
    const d = setup();
    await handleKapsoWebhook(signed(humanMessage(EXTRA, "wamid.bot", "cloud_api"), "whatsapp.message.sent"), d.deps);
    expect(d.registerHumanMessage).not.toHaveBeenCalled();
  });

  it("el mensaje entrante comprueba la expiración antes de procesarse", async () => {
    const d = setup();
    const response = await handleKapsoWebhook(signed(textMessage(EXTRA, "wamid.t"), "whatsapp.message.received"), d.deps);
    expect(await response.text()).toBe("ok");
    await Promise.all(d.scheduled);
    expect(d.resumeIfIdle).toHaveBeenCalledTimes(1);
    expect(spy.turns).toHaveBeenCalledTimes(1);
  });

  it("falla cerrado si Supabase no confirma el vencimiento", async () => {
    const d = setup();
    d.resumeIfIdle.mockRejectedValueOnce(new Error("db_unavailable"));
    const response = await handleKapsoWebhook(signed(textMessage(EXTRA, "wamid.failure"), "whatsapp.message.received"), d.deps);
    expect(response.status).toBe(200);
    await Promise.all(d.scheduled);
    expect(spy.turns).not.toHaveBeenCalled();
    expect(d.events.some((x) => x.event === "human_idle_resume_failed")).toBe(true);
  });

  it("la SQL protege la pausa CRM y serializa la reactivación", () => {
    const sql = readFileSync(join(__dirname, "..", "supabase", "pending-migrations", "20261105000000_plusmedik_human_idle_resume.sql"), "utf8");
    expect(sql).toContain("for update");
    expect(sql).toContain("pause_source is distinct from 'kapso_business_app'");
    expect(sql).toContain("interval '10 minutes'");
    expect(sql).toContain("last_human_event_at");
    expect(sql).toContain("grant execute on function public.plusmedik_attention_resume_if_idle(text) to service_role");
  });
});
