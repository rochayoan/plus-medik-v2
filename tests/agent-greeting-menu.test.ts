import { describe, expect, it, vi } from "vitest";
import type { AgentModel } from "../src/agent/contracts.js";
import { greetingMenu, isMenuMessage, MENU_OPTIONS, menuChoiceOf, menuNumberOf, resolveGreetingWaitMs, shouldShowGreetingMenu } from "../src/greeting-menu.js";
import { createAgentPilot } from "../src/agent/pilot.js";
import { isGreetingOnly } from "../src/agent/shadow.js";
import { verifyReply } from "../src/agent/verify.js";
import type { AuditRepository } from "../src/audit.js";
import { routeResultsMessage } from "../src/results-silence.js";
import { processTurns, type IncomingTurn } from "../src/turns.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";
import { CONTACT_KEY, FIXTURE_CATALOG, fixtureAnswer, NOW, PHONE } from "../scripts/g7/lib/agent-scenarios.js";

// Menú de intención del saludo: texto fijo del sistema, elección por número SOLO justo después del menú, y cada opción por su camino de siempre.

const MENU = greetingMenu(new Date(NOW));
const said = (text: string) => ({ topic: "SOCIAL" as const, text });

describe("el menú fijo", () => {
  it("trae las cinco opciones numeradas y pasa el verificador (sin cifras inventadas)", () => {
    for (const option of MENU_OPTIONS) expect(MENU).toContain(option.label);
    expect(isMenuMessage(MENU)).toBe(true);
    expect(verifyReply({ text: MENU, facts: [] })).toEqual([]);
  });
  it("una lista de estudios con precios NO es el menú", () => {
    expect(isMenuMessage("Tengo estas opciones:\n1. Lactato en sangre — Bs 160\n2. Gasometría — Bs 330")).toBe(false);
  });
});

describe("¿solo saluda?", () => {
  it.each(["hola", "Buenas tardes", "buenos días doctora", "Hola, buenas noches"])("saludo puro: %s", (text) => {
    expect(isGreetingOnly([said(text)])).toBe(true);
  });
  it.each(["gracias", "ok", "hola, ¿cuánto cuesta un hemograma?", "buenas, necesito laboratorio"])("no abre el menú: %s", (text) => {
    expect(isGreetingOnly([{ topic: "OTHER", text }])).toBe(false);
  });
  it("con conversación en las últimas 24 h un «hola» es retomar: sin menú", () => {
    expect(shouldShowGreetingMenu(isGreetingOnly([said("hola")]), [])).toBe(true);
    expect(shouldShowGreetingMenu(isGreetingOnly([said("hola")]), [{ from: "ASSISTANT", text: "Con gusto te ayudo" }])).toBe(false);
  });
});

describe("elección por número", () => {
  it.each([["2", 2], ["2️⃣", 2], ["opción 3", 3], ["la 4", 4], ["el 1", 1], ["5.", 5], ["2 por favor", 2]] as const)("«%s» es el número %d", (text, number) => {
    expect(menuNumberOf(text)).toBe(number);
  });
  it.each(["12", "2 hemogramas", "hemograma", "84", "1234567"])("«%s» no es una elección", (text) => {
    expect(menuNumberOf(text)).toBeUndefined();
  });
  it("solo vale si el ÚLTIMO mensaje del asistente fue el menú", () => {
    expect(menuChoiceOf("2", [{ from: "ASSISTANT", text: MENU }])?.code).toBe("RESULTS");
    expect(menuChoiceOf("5", [{ from: "ASSISTANT", text: MENU }])?.code).toBe("HUMAN");
    // tras una lista de estudios, «1» es la elección de esa lista
    expect(menuChoiceOf("1", [{ from: "ASSISTANT", text: MENU }, { from: "PATIENT", text: "glucosa" }, { from: "ASSISTANT", text: "Tengo estas opciones:\n1. Glucosa en ayunas — Bs 30\n2. Glucosa postprandial — Bs 35" }])).toBeUndefined();
    // si la recepción habló después del menú, el número no es del menú
    expect(menuChoiceOf("2", [{ from: "ASSISTANT", text: MENU }, { from: "STAFF", text: "buenos días" }])).toBeUndefined();
    // un número fuera del menú no se traduce (lo atiende el agente, que pregunta)
    expect(menuChoiceOf("7", [{ from: "ASSISTANT", text: MENU }])).toBeUndefined();
  });
  it("las frases canónicas siguen su camino: «resultados» va a recepción, el resto no se calla", () => {
    expect(routeResultsMessage(MENU_OPTIONS.find((o) => o.code === "RESULTS")!.canonical)).toBe("READY_CHECK");
    for (const code of ["QUOTE", "LOCATION", "HOME_VISIT", "HUMAN"] as const) expect(routeResultsMessage(MENU_OPTIONS.find((o) => o.code === code)!.canonical)).toBe("NORMAL");
  });
});

describe("espera del saludo (variable)", () => {
  it("20 s por defecto; 0/off la quita; valores fuera de rango vuelven al defecto", () => {
    expect(resolveGreetingWaitMs({})).toBe(20_000);
    expect(resolveGreetingWaitMs({ PLUSMEDIK_GREETING_WAIT_SECONDS: "off" })).toBe(0);
    expect(resolveGreetingWaitMs({ PLUSMEDIK_GREETING_WAIT_SECONDS: "30" })).toBe(30_000);
    expect(resolveGreetingWaitMs({ PLUSMEDIK_GREETING_WAIT_SECONDS: "999" })).toBe(20_000);
  });
});

describe("el piloto responde el menú SIN modelo", () => {
  const model: AgentModel & { calls: number } = { calls: 0, async plan() { model.calls += 1; return { toolCalls: [] }; }, async respond() { model.calls += 1; return { text: "x" }; } };
  const pilot = (recent: Array<{ from: "PATIENT" | "ASSISTANT" | "STAFF"; text: string }>) => createAgentPilot({
    model, modelName: "m", phones: new Set([PHONE]), switch: { enabled: async () => true },
    context: { loadCatalog: async () => FIXTURE_CATALOG, answer: fixtureAnswer, contactKeyFor: () => CONTACT_KEY, recent: async () => recent },
    log: () => undefined, now: () => NOW
  });
  it("solo «hola» sin conversación: el menú fijo, marcado como menú, y el modelo no se llama", async () => {
    const reply = await pilot([]).produce({ from: PHONE, turns: [{ messageId: "g1", kind: "TEXT", text: "hola" }] });
    expect(reply?.menu).toBe(true);
    expect(reply?.signature).toBe("AGENT:MENU");
    expect(isMenuMessage(reply!.body)).toBe(true);
    expect(model.calls).toBe(0);
  });
  it("«hola» con conversación previa: lo atiende el modelo (sin menú)", async () => {
    const reply = await pilot([{ from: "ASSISTANT", text: "Con gusto te ayudo" }]).produce({ from: PHONE, turns: [{ messageId: "g2", kind: "TEXT", text: "hola" }] });
    expect(reply?.menu).toBeUndefined();
    expect(model.calls).toBeGreaterThan(0);
  });
});

describe("en los turnos: «2» después del menú pide los datos del resultado", () => {
  const lease = { owner: "o", fence: 1 };
  const from = "59170000000";
  it("se traduce a la opción y recepción responde con el texto de resultados (caso al CRM)", async () => {
    const audit = {
      claim: vi.fn(async () => ({ kind: "claimed" as const, runId: "run-m", lease })),
      renewLease: vi.fn(async () => true),
      recordIgnored: vi.fn(async () => undefined),
      recordFailure: vi.fn(async () => undefined),
      recordReply: vi.fn(async () => undefined),
      reserveSend: vi.fn(async () => "reserved" as const),
      confirmSend: vi.fn(async () => "proceed" as const)
    } as unknown as AuditRepository;
    const sendText = vi.fn(async () => undefined);
    const submit = vi.fn(async () => [{ state: "REGISTERED" }]);
    const menuChoice = vi.fn(async ({ text }: { text: string }) => menuChoiceOf(text, [{ from: "ASSISTANT", text: MENU }])?.canonical);
    const deps = {
      audit, sendText, loadCatalog: vi.fn(async () => []), analyze: vi.fn(),
      downloadImage: vi.fn(async () => ({ bytes: new Uint8Array() })),
      log: vi.fn(),
      turns: { handlers: { text: vi.fn(async () => ({ body: "NO DEBE SALIR" })) }, contactKeyFor: () => "a".repeat(64), menuChoice, crmHandoff: { submit, submitSessionReview: vi.fn() } }
    } as unknown as QuoteDeps;
    const turn: IncomingTurn = { kind: "TEXT", text: "2", from, messageId: "m-2" };
    await processTurns([turn], deps);
    expect(menuChoice).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect((sendText.mock.calls[0] as unknown as [string, string])[1]).toMatch(/carnet de identidad, o el comprobante de pago/);
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it("un texto que no es un número ni siquiera lee el historial", async () => {
    const menuChoice = vi.fn(async () => undefined);
    const deps = {
      audit: { claim: vi.fn(async () => ({ kind: "duplicate" as const })) } as unknown as AuditRepository,
      sendText: vi.fn(), loadCatalog: vi.fn(async () => []), analyze: vi.fn(), downloadImage: vi.fn(), log: vi.fn(),
      turns: { handlers: { text: vi.fn(async () => undefined) }, contactKeyFor: () => "a".repeat(64), menuChoice }
    } as unknown as QuoteDeps;
    await processTurns([{ kind: "TEXT", text: "cuánto cuesta un hemograma", from, messageId: "m-3" }], deps);
    expect(menuChoice).not.toHaveBeenCalled();
  });
});

describe("en los turnos: espera del saludo antes de enviar el menú", () => {
  const lease = { owner: "o", fence: 1 };
  const from = "59170000000";
  const build = (newer: boolean) => {
    const audit = {
      claim: vi.fn(async () => ({ kind: "claimed" as const, runId: "run-g", lease, seq: 7 })),
      renewLease: vi.fn(async () => true),
      recordIgnored: vi.fn(async () => undefined),
      recordFailure: vi.fn(async () => undefined),
      recordReply: vi.fn(async () => undefined),
      reserveSend: vi.fn(async () => "reserved" as const),
      confirmSend: vi.fn(async () => "proceed" as const)
    } as unknown as AuditRepository;
    const sendText = vi.fn(async () => undefined);
    const newerTurn = vi.fn(async () => newer);
    const agentPilot = { mode: "live" as const, isPilot: () => true, produce: vi.fn(async () => ({ body: MENU, result: "conversation" as const, processingStatus: "COMPLETED" as const, stale: "NEWER_TURN" as const, signature: "AGENT:MENU", quality: "ANSWER" as const, quotedStudyIds: [], menu: true as const })) };
    const deps = {
      audit, sendText, loadCatalog: vi.fn(async () => []), analyze: vi.fn(), downloadImage: vi.fn(), log: vi.fn(),
      turns: { handlers: { text: vi.fn(async () => ({ body: "ruta de siempre" })) }, contactKeyFor: () => "a".repeat(64), agentPilot, greetingWait: { waitMs: 9000, pollMs: 3000, newerTurn, sleep: async () => undefined } }
    } as unknown as QuoteDeps;
    return { deps, sendText, newerTurn };
  };
  it("el paciente sigue escribiendo: el menú NO sale", async () => {
    const { deps, sendText, newerTurn } = build(true);
    await processTurns([{ kind: "TEXT", text: "hola", from, messageId: "h-1" }], deps);
    expect(newerTurn).toHaveBeenCalledTimes(1);
    expect(sendText).not.toHaveBeenCalled();
  });
  it("no escribe nada más: el menú sale una vez, tras esperar", async () => {
    const { deps, sendText, newerTurn } = build(false);
    await processTurns([{ kind: "TEXT", text: "hola", from, messageId: "h-2" }], deps);
    expect(newerTurn).toHaveBeenCalledTimes(3);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect((sendText.mock.calls[0] as unknown as [string, string])[1]).toBe(MENU);
  });
});

describe("tono, domicilio y mapa", async () => {
  const { homeVisitMessage } = await import("../src/agent/pipeline.js");
  const { withMapLink } = await import("../src/agent/pilot.js");
  it("el voseo con tilde se rechaza (se reescribe); el «tú» sin tilde no", () => {
    expect(verifyReply({ text: "¿Querés que te cotice algo? Podés escribirme.", facts: [] }).map((p) => p.code)).toContain("VOSEO");
    expect(verifyReply({ text: "¿Quieres que te cotice algo? Mira, pásame los nombres.", facts: [] })).toEqual([]);
  });
  it("domicilio: el texto fijo pasa el verificador y solo promete a una persona si el caso quedó registrado", () => {
    expect(verifyReply({ text: homeVisitMessage(false), facts: [] })).toEqual([]);
    expect(homeVisitMessage(false)).not.toMatch(/persona del laboratorio/);
    expect(homeVisitMessage(true)).toMatch(/Una persona del laboratorio te confirmará/);
    expect(homeVisitMessage(true)).toMatch(/Nombre completo y edad del paciente/);
  });
  it("si el agente dio la ubicación sin el enlace aprobado, se agrega (y no se duplica)", () => {
    const facts = [{ id: "lab_info:1", source: "LAB_INFO" as const, text: "Sede: Calle X. Mapa: https://maps.app.goo.gl/AbC123", refs: [] }];
    expect(withMapLink("Estamos en la Calle X.", facts)).toBe("Estamos en la Calle X.\n\n📍 Mapa: https://maps.app.goo.gl/AbC123");
    expect(withMapLink("Estamos aquí: https://maps.app.goo.gl/AbC123", facts)).toBe("Estamos aquí: https://maps.app.goo.gl/AbC123");
    expect(withMapLink("Atendemos las 24 horas.", [])).toBe("Atendemos las 24 horas.");
  });
});

describe("medición del menú (migración 26)", async () => {
  const { createMenuEventRecorder } = await import("../src/menu-events.js");
  const KEY = "b".repeat(64);
  it("registra solo códigos; nunca lanza; un aviso por racha de fallos", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const ok = createMenuEventRecorder({ rpc: async (name, args) => { calls.push([name, args]); return {}; } });
    await ok(KEY, { event: "CHOSEN", option: "RESULTS", via: "NUMBER" });
    await ok(KEY, { event: "SHOWN" });
    expect(calls).toEqual([["plusmedik_agent_menu_event", { p_contact_key: KEY, p_event: "CHOSEN", p_option: "RESULTS", p_via: "NUMBER" }], ["plusmedik_agent_menu_event", { p_contact_key: KEY, p_event: "SHOWN", p_option: null, p_via: null }]]);
    const log = vi.fn();
    const broken = createMenuEventRecorder({ rpc: async () => { throw new Error("sin migración"); }, log });
    await expect(broken(KEY, { event: "SHOWN" })).resolves.toBeUndefined();
    await broken(KEY, { event: "SHOWN" });
    expect(log).toHaveBeenCalledTimes(1);
    await ok("no-es-una-clave", { event: "SHOWN" });
    expect(calls).toHaveLength(2);
  });
  it("en los turnos: «2» tras el menú se mide como CHOSEN/RESULTS/NUMBER", async () => {
    const lease = { owner: "o", fence: 1 };
    const menuEvents = vi.fn(async () => undefined);
    const deps = {
      audit: { claim: vi.fn(async () => ({ kind: "claimed" as const, runId: "r", lease })), renewLease: vi.fn(async () => true), recordIgnored: vi.fn(async () => undefined), recordFailure: vi.fn(async () => undefined), recordReply: vi.fn(async () => undefined), reserveSend: vi.fn(async () => "reserved" as const), confirmSend: vi.fn(async () => "proceed" as const) } as unknown as AuditRepository,
      sendText: vi.fn(async () => undefined), loadCatalog: vi.fn(async () => []), analyze: vi.fn(), downloadImage: vi.fn(), log: vi.fn(),
      turns: { handlers: { text: vi.fn(async () => undefined) }, contactKeyFor: () => KEY, menuEvents, menuChoice: async ({ text }: { text: string }) => menuChoiceOf(text, [{ from: "ASSISTANT", text: MENU }])?.canonical, crmHandoff: { submit: vi.fn(async () => [{ state: "REGISTERED" }]), submitSessionReview: vi.fn() } }
    } as unknown as QuoteDeps;
    await processTurns([{ kind: "TEXT", text: "2", from: "59170000000", messageId: "x-1" }], deps);
    expect(menuEvents).toHaveBeenCalledWith(KEY, { event: "CHOSEN", option: "RESULTS", via: "NUMBER" });
  });
  it("en los turnos: el menú que sale se mide como SHOWN; el que no sale, como SKIPPED", async () => {
    for (const newer of [false, true]) {
      const lease = { owner: "o", fence: 1 };
      const menuEvents = vi.fn(async () => undefined);
      const agentPilot = { mode: "live" as const, isPilot: () => true, produce: vi.fn(async () => ({ body: MENU, result: "conversation" as const, processingStatus: "COMPLETED" as const, stale: "NEWER_TURN" as const, signature: "AGENT:MENU", quality: "ANSWER" as const, quotedStudyIds: [], menu: true as const })) };
      const deps = {
        audit: { claim: vi.fn(async () => ({ kind: "claimed" as const, runId: "r", lease, seq: 3 })), renewLease: vi.fn(async () => true), recordIgnored: vi.fn(async () => undefined), recordFailure: vi.fn(async () => undefined), recordReply: vi.fn(async () => undefined), reserveSend: vi.fn(async () => "reserved" as const), confirmSend: vi.fn(async () => "proceed" as const) } as unknown as AuditRepository,
        sendText: vi.fn(async () => undefined), loadCatalog: vi.fn(async () => []), analyze: vi.fn(), downloadImage: vi.fn(), log: vi.fn(),
        turns: { handlers: { text: vi.fn(async () => undefined) }, contactKeyFor: () => KEY, agentPilot, menuEvents, greetingWait: { waitMs: 3000, pollMs: 3000, newerTurn: async () => newer, sleep: async () => undefined } }
      } as unknown as QuoteDeps;
      await processTurns([{ kind: "TEXT", text: "hola", from: "59170000000", messageId: `y-${newer}` }], deps);
      expect(menuEvents).toHaveBeenCalledWith(KEY, { event: newer ? "SKIPPED" : "SHOWN" });
    }
  });
});
