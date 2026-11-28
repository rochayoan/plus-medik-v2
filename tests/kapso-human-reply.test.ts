import { describe, expect, it, vi } from "vitest";
import type { AuditRepository } from "../src/audit.js";
import { createHumanReplyCheck, humanReplyIn } from "../src/kapso-human-reply.js";
import { processTurns, type IncomingTurn } from "../src/turns.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";

// Caso real (21-nov, 01:18 La Paz): el paciente escribe a las 01:17:41, la Dra le responde desde WhatsApp Business a las 01:18:07, su eco pausa al contacto a las 01:18:09 y la respuesta del agente sale en
// ese mismo segundo: el paciente recibió las dos. Antes de la comprobación final se le pregunta a Kapso por la respuesta humana que se cruzó.
const patient = "59160931404";
const patientAt = 1_795_242_000; // hora del mensaje del paciente (segundos)
const human = (over: Record<string, unknown> = {}) => ({ id: "wamid.HUMANO1", to: patient, timestamp: String(patientAt + 26), kapso: { direction: "outbound", origin: "business_app" }, ...over });

describe("humanReplyIn: qué cuenta como respuesta de una persona que se cruzó", () => {
  it("un saliente de WhatsApp Business a este paciente, posterior a su mensaje", () => {
    expect(humanReplyIn([human()], patient, patientAt)).toEqual({ messageId: "wamid.HUMANO1", occurredAt: new Date((patientAt + 26) * 1000).toISOString() });
    // El número puede venir con «+» o en kapso.phone_number.
    expect(humanReplyIn([human({ to: undefined, kapso: { direction: "outbound", origin: "business_app", phone_number: `+${patient}` } })], patient, patientAt)?.messageId).toBe("wamid.HUMANO1");
  });
  it("no cuenta: las respuestas del propio agente (cloud_api), otro paciente, un mensaje anterior al del paciente, un entrante o sin id", () => {
    expect(humanReplyIn([human({ kapso: { direction: "outbound", origin: "cloud_api" } })], patient, patientAt)).toBeUndefined();
    expect(humanReplyIn([human({ to: "59170000000" })], patient, patientAt)).toBeUndefined();
    expect(humanReplyIn([human({ timestamp: String(patientAt - 5) })], patient, patientAt)).toBeUndefined();
    expect(humanReplyIn([human({ timestamp: String(patientAt) })], patient, patientAt)).toBeUndefined();
    expect(humanReplyIn([human({ kapso: { direction: "inbound", origin: "business_app" } })], patient, patientAt)).toBeUndefined();
    expect(humanReplyIn([human({ id: undefined })], patient, patientAt)).toBeUndefined();
    expect(humanReplyIn([null, "x", 3], patient, patientAt)).toBeUndefined();
  });
  it("con varias, se toma la primera (la que pausa)", () => {
    expect(humanReplyIn([human({ id: "wamid.B", timestamp: String(patientAt + 40) }), human({ id: "wamid.A", timestamp: String(patientAt + 10) })], patient, patientAt)?.messageId).toBe("wamid.A");
  });
});

describe("createHumanReplyCheck", () => {
  const setup = (query: ReturnType<typeof vi.fn>, register = vi.fn(async () => ({ outcome: "PAUSED" as const, revision: 2, blockedRuns: 1, lateReservedRuns: 0, repliedAfterEventRuns: 0 }))) => {
    const log = vi.fn();
    const check = createHumanReplyCheck({ query: query as never, phoneNumberId: () => "lab-phone", attention: { registerHumanMessage: register }, timeoutMs: 50, log });
    return { check, register, log };
  };

  it("hay respuesta humana: registra la pausa con la MISMA clave que el webhook (el eco posterior será un duplicado)", async () => {
    const query = vi.fn(async () => ({ data: [human()] }));
    const { check, register } = setup(query);
    expect(await check({ from: patient, contactKey: "k".repeat(64), afterSeconds: patientAt })).toBe("PAUSED");
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: "lab-phone", direction: "outbound", since: new Date(patientAt * 1000).toISOString() }));
    expect(register).toHaveBeenCalledWith({ eventKey: "human_business_app:wamid.HUMANO1", contactKey: "k".repeat(64), occurredAt: new Date((patientAt + 26) * 1000).toISOString() });
  });
  it("sin respuesta humana: no registra nada", async () => {
    const { check, register } = setup(vi.fn(async () => ({ data: [human({ kapso: { direction: "outbound", origin: "cloud_api" } })] })));
    expect(await check({ from: patient, contactKey: "k".repeat(64), afterSeconds: patientAt })).toBe("NONE");
    expect(register).not.toHaveBeenCalled();
  });
  it("Kapso falla, tarda o el registro falla: nunca lanza y el envío sigue como antes", async () => {
    expect(await setup(vi.fn(async () => { throw new Error("kapso caído"); })).check({ from: patient, contactKey: "k".repeat(64), afterSeconds: patientAt })).toBe("UNKNOWN");
    expect(await setup(vi.fn(() => new Promise(() => undefined))).check({ from: patient, contactKey: "k".repeat(64), afterSeconds: patientAt })).toBe("UNKNOWN");
    const failing = setup(vi.fn(async () => ({ data: [human()] })), vi.fn(async () => { throw new Error("base caída"); }));
    expect(await failing.check({ from: patient, contactKey: "k".repeat(64), afterSeconds: patientAt })).toBe("UNKNOWN");
  });
  it("el registro solo lleva hora, origen y destinatario: nunca el texto", async () => {
    const query = vi.fn(async () => ({ data: [] }));
    await setup(query).check({ from: patient, contactKey: "k".repeat(64), afterSeconds: patientAt });
    expect((query.mock.calls[0] as unknown as [{ fields: string }])[0].fields).not.toMatch(/text|body/);
  });
});

describe("turnos: una respuesta de la Dra que se cruzó impide la del agente", () => {
  const lease = { owner: "owner", fence: 1 };
  const build = (opts: { humanReplied: boolean; withCheck?: boolean }) => {
    let paused = false;
    const audit = {
      claim: vi.fn(async () => ({ kind: "claimed" as const, runId: "run-h", lease })),
      renewLease: vi.fn(async () => true),
      recordIgnored: vi.fn(async () => undefined),
      recordFailure: vi.fn(async () => undefined),
      recordReply: vi.fn(async () => undefined),
      reserveSend: vi.fn(async () => "reserved" as const),
      // La comprobación final real: si el contacto quedó pausado, libera la reserva y no se envía.
      confirmSend: vi.fn(async () => (paused ? ("blocked" as const) : ("proceed" as const)))
    } as unknown as AuditRepository;
    const sendText = vi.fn(async () => undefined);
    const humanReplyCheck = vi.fn(async () => {
      if (opts.humanReplied) paused = true;
      return opts.humanReplied ? "PAUSED" : "NONE";
    });
    const deps = {
      audit, sendText, loadCatalog: vi.fn(async () => []), analyze: vi.fn(),
      downloadImage: vi.fn(async () => ({ bytes: new Uint8Array() })),
      log: vi.fn(),
      ...(opts.withCheck === false ? {} : { humanReplyCheck }),
      turns: { handlers: { text: vi.fn(async () => ({ body: "Buenas noches. ¿Qué pedido quisieras hacer?" })) }, contactKeyFor: () => "a".repeat(64) } as unknown as NonNullable<QuoteDeps["turns"]>
    } as unknown as QuoteDeps;
    return { deps, sendText, humanReplyCheck, audit };
  };
  const msg: IncomingTurn = { kind: "TEXT", text: "De don Zarco?", from: patient, messageId: "in-1", timestamp: patientAt };

  it("la Dra escribió mientras se preparaba la respuesta: el agente NO envía", async () => {
    const { deps, sendText, humanReplyCheck, audit } = build({ humanReplied: true });
    await processTurns([msg], deps);
    expect(humanReplyCheck).toHaveBeenCalledWith({ from: patient, contactKey: "a".repeat(64), afterSeconds: patientAt });
    // Se consulta ANTES de la comprobación final, que es la que corta el envío.
    expect(humanReplyCheck.mock.invocationCallOrder[0]!).toBeLessThan((audit.confirmSend as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!);
    expect(sendText).not.toHaveBeenCalled();
  });
  it("nadie escribió: responde como siempre", async () => {
    const { deps, sendText } = build({ humanReplied: false });
    await processTurns([msg], deps);
    expect(sendText).toHaveBeenCalledTimes(1);
  });
  it("sin la comprobación (control humano apagado) o sin la hora del mensaje: exactamente como antes", async () => {
    const off = build({ humanReplied: true, withCheck: false });
    await processTurns([msg], off.deps);
    expect(off.sendText).toHaveBeenCalledTimes(1);
    const noTime = build({ humanReplied: true });
    await processTurns([{ ...msg, timestamp: undefined }], noTime.deps);
    expect(noTime.humanReplyCheck).not.toHaveBeenCalled();
    expect(noTime.sendText).toHaveBeenCalledTimes(1);
  });
});
