import { describe, expect, it, vi } from "vitest";
import type { AgentModel, PlanOutput } from "../src/agent/contracts.js";
import { createAgentPilot, type PilotSwitch } from "../src/agent/pilot.js";
import { isOpeningText, isQuoteAskText, isUnhelpfulReply, QUOTE_ASK_MESSAGE } from "../src/agent/shadow.js";
import { quoteStudiesTool, sampleAsAdjective } from "../src/agent/tools.js";
import type { AuditRepository } from "../src/audit.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { greetingMenu, MENU_OPTIONS } from "../src/greeting-menu.js";
import { correctionAcked, isCorrectionFollowUp, isResultCorrection, RESULT_CORRECTION_MESSAGE } from "../src/result-correction.js";
import { routeResultsMessage } from "../src/results-silence.js";
import { processTurns, type IncomingTurn } from "../src/turns.js";
import type { CatalogStudy } from "../src/types.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";
import { CONTACT_KEY, FIXTURE_CATALOG, fixtureAnswer, NOW, PHONE } from "../scripts/g7/lib/agent-scenarios.js";

// Revisión de las conversaciones reales del 21-nov (primer día del agente con todos los contactos). Cada bloque es una CLASE de caso, no solo el mensaje que falló.

const study = (id: string, name: string, priceBs: number, turnaroundText: string): CatalogStudy =>
  ({ id, code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: [], priceBs, active: true, category: null, sampleType: null, turnaroundText }) as unknown as CatalogStudy;

describe("la muestra dicha con «de/en + sustantivo» y el catálogo con el adjetivo (frotis de sangre periférica)", () => {
  it.each([
    ["frotis de sangre periferica", "frotis sanguineo"],
    ["frotis periferico", "frotis sanguineo"],
    ["calprotectina en heces", "calprotectina fecal"],
    ["moco en las heces", "moco fecal"],
    ["sedimento de orina", "sedimento urinario"],
    ["grupo de sangre", "grupo sanguineo"],
    ["hemograma", "hemograma"]
  ])("«%s» → «%s»", (written, expected) => {
    expect(sampleAsAdjective(written)).toBe(expected);
  });

  const catalog = [
    study("frotis", "MORFOLOGIA DE FROTIS SANGUINEO (1 LAMINA)", 60, "2 días"),
    study("calpro", "CALPROTECTINA FECAL CUANTITATIVA (FIA Fluorescencia)", 300, "1 día"),
    study("sedi", "SEDIMENTO URINARIO", 35, "2 horas"),
    study("hemo", "HEMOGRAMA COMPLETO AUTOMATIZADO", 45, "2 horas"),
    study("glu", "GLUCOSA", 20, "2 horas")
  ];
  const tool = quoteStudiesTool({ loadCatalog: async () => catalog });
  const run = (text: string) => tool.run({ studies: [text] }, { now: new Date(NOW), patientText: text } as never) as Promise<{ facts?: Array<{ text: string; refs: string[] }>; blocks?: string[] }>;

  it.each([["frotis de sangre periferica", "frotis"], ["calprotectina en heces", "calpro"], ["sedimento de orina", "sedi"]])("«%s» se cotiza (antes: «te lo confirma la doctora»)", async (text, id) => {
    const result = await run(text);
    expect(result.facts?.[0]?.refs).toEqual([`study:${id}`]);
    expect(result.blocks?.join("\n")).not.toContain("confirma la doctora");
  });

  it("el redactor recibe el tiempo de entrega de lo cotizado (antes decía «no tengo confirmado el tiempo de entrega»)", async () => {
    const result = await run("frotis de sangre periferica");
    expect(result.facts?.some((fact) => fact.text.includes("MORFOLOGIA DE FROTIS SANGUINEO (1 LAMINA): 2 días") && fact.text.includes("nunca digas que no tienes el tiempo de entrega"))).toBe(true);
  });
});

describe("«unos análisis que me tenían que enviar» es una consulta de resultados", () => {
  it.each([
    "Hola buenos días. Le escribo por favor por unos análisis que me tenían que enviar",
    "quedaron de enviarme mis análisis",
    "estoy esperando mis estudios",
    "no me llegaron mis exámenes",
    "me iban a mandar los análisis de mi mamá"
  ])("SÍ: «%s»", (text) => {
    expect(routeResultsMessage(text)).toBe("READY_CHECK");
  });
  it.each(["pueden enviarme la cotización de estos estudios", "me pueden mandar los precios de los análisis", "pueden mandarme la ubicación para hacerme unos análisis", "cuanto cuesta el estudio de orina"])("no: «%s»", (text) => {
    expect(routeResultsMessage(text)).toBe("NORMAL");
  });
});

describe("apertura sin intención concreta → menú; «¿cuánto me sale?» sin estudios → texto fijo del camino 1", () => {
  it.each(["Dra", "?", "Con quien deseaba hablar", "disculpe", "una consulta", "Hola, una pregunta por favor", "quién habla?", "me llamaron de este número", "Hola me puede ayudar", "Buenas tardes"])("apertura: «%s»", (text) => {
    expect(isOpeningText(text)).toBe(true);
  });
  it.each(["Está realizando progesterona", "Cuánto me sale", "hemograma", "resultados", "dónde están", "gracias", "ok", "1600", "No por separado", "333 A", "A como"])("no es apertura: «%s»", (text) => {
    expect(isOpeningText(text)).toBe(false);
  });
  it.each(["Cuánto me sale", "Buenos días cuánto me sale", "quiero cotizar", "Quiero cotizar estudios", "precios", "quisiera saber los precios de unos análisis", "me puede cotizar", "A como", "Cuanto me costaría", "Buenas tardes Dr cotización por favor"])("pide cotizar sin estudios: «%s»", (text) => {
    expect(isQuoteAskText(text)).toBe(true);
  });
  it.each(["cuánto me sale el hemograma", "cuanto cuesta la progesterona", "precio convenio", "cotización de mi receta", "cuanto es el total"])("no: «%s»", (text) => {
    expect(isQuoteAskText(text)).toBe(false);
  });
  it.each([
    "Hola, buenos días.",
    "Buenas tardes, estás conversando con el asistente del laboratorio. Con gusto te ayudo por aquí. ¿Quieres cotizar algún estudio o consultar la ubicación y los horarios?",
    "¿Quieres hablar con la doctora o necesitas ayuda con algún estudio?",
    "Buenas tardes, ¿en qué puedo ayudarte hoy?"
  ])("respuesta que no ayuda: «%s»", (text) => {
    expect(isUnhelpfulReply(text)).toBe(true);
  });
  it.each(["¡Buenos días! ¿Qué estudios quieres cotizar? Puedes escribirme los nombres o enviarme una foto de tu receta.", "Atendemos las 24 horas, todos los días.", "¿A qué panel te refieres? Dime cómo se llama para cotizarlo."])("respuesta útil: «%s»", (text) => {
    expect(isUnhelpfulReply(text)).toBe(false);
  });
});

describe("el piloto: menú, camino 1 y respuestas que no ayudan", () => {
  const turn = (id: string, text: string) => ({ messageId: id, kind: "TEXT" as const, text });
  const make = (text: string, recent: Array<{ from: "PATIENT" | "ASSISTANT" | "STAFF"; text: string }> = []) => {
    const model = { plans: 0, async plan(): Promise<PlanOutput> { model.plans += 1; return { toolCalls: [] } as unknown as PlanOutput; }, async respond() { return { text }; } };
    const pilotSwitch: PilotSwitch = { enabled: async () => true };
    const pilot = createAgentPilot({
      model: model as unknown as AgentModel, modelName: "modelo-x", phones: new Set([PHONE]), switch: pilotSwitch,
      context: { loadCatalog: async () => FIXTURE_CATALOG, answer: fixtureAnswer, contactKeyFor: () => CONTACT_KEY, recent: async () => recent },
      log: () => undefined, now: () => NOW
    });
    return { pilot, model };
  };
  it("«Buenas tardes / ¿Con quién deseaba hablar? / ?» → el menú, sin modelo", async () => {
    const { pilot, model } = make("no se usa");
    const reply = await pilot.produce({ from: PHONE, turns: [turn("a", "Buenas tardes"), turn("b", "Con quien deseaba hablar"), turn("c", "?")] });
    expect(reply?.body).toBe(greetingMenu(new Date(NOW)));
    expect(reply?.menu).toBe(true);
    expect(model.plans).toBe(0);
  });
  it("«Dra» solo → el menú (espera por si sigue escribiendo, como un saludo)", async () => {
    const { pilot } = make("no se usa");
    expect((await pilot.produce({ from: PHONE, turns: [turn("a", "Dra")] }))?.menu).toBe(true);
  });
  it("«Buenos días / Cuánto me sale» → texto fijo del camino 1, sin modelo", async () => {
    const { pilot, model } = make("no se usa");
    const reply = await pilot.produce({ from: PHONE, turns: [turn("a", "Buenos días"), turn("b", "Cuánto me sale")] });
    expect(reply?.body).toBe(QUOTE_ASK_MESSAGE);
    expect(model.plans).toBe(0);
  });
  it("el «1» del menú también recibe el texto fijo del camino 1", async () => {
    const { pilot } = make("no se usa", [{ from: "PATIENT", text: "hola" }, { from: "ASSISTANT", text: greetingMenu(new Date(NOW)) }]);
    expect((await pilot.produce({ from: PHONE, turns: [turn("a", MENU_OPTIONS[0]!.canonical)] }))?.body).toBe(QUOTE_ASK_MESSAGE);
  });
  it("con una cotización a la vista, «¿cuánto me sale?» lo atiende el agente (no el texto fijo)", async () => {
    const { pilot, model } = make("El total va en la cotización de arriba.", [{ from: "PATIENT", text: "hemograma" }, { from: "ASSISTANT", text: "🩺 PlusMedik · Tu cotización" }]);
    const reply = await pilot.produce({ from: PHONE, turns: [turn("a", "Cuánto me sale")] });
    expect(model.plans).toBe(1);
    expect(reply?.body).not.toBe(QUOTE_ASK_MESSAGE);
  });
  it("si el redactor solo saluda («Hola, buenos días.»), sale el menú", async () => {
    const { pilot } = make("Hola, buenos días.");
    const reply = await pilot.produce({ from: PHONE, turns: [turn("a", "Hola buenos días"), turn("b", "Le escribo por algo que me dijeron")] });
    expect(reply?.body).toBe(greetingMenu(new Date(NOW)));
  });
});

describe("corregir un dato del resultado (caso Yuselin)", () => {
  it.each(["Un favor me lo pueden corregir el nombre", "Es ZARCO, lo corrigen por favor.", "pueden corregir mi apellido", "me pusieron mal el nombre", "el nombre está mal escrito", "quiero cambiar el nombre del resultado"])("SÍ: «%s»", (text) => {
    expect(isResultCorrection(text)).toBe(true);
  });
  it.each(["perdón, me corrijo: es hemograma", "quiero cambiar la fecha de mi cita", "cuánto cuesta el hemograma", "Es Yuselin"])("no: «%s»", (text) => {
    expect(isResultCorrection(text)).toBe(false);
  });
  it("lo que manda después sobre la corrección se deja a la Dra", () => {
    expect(isCorrectionFollowUp("Es Yuselin")).toBe(true);
    expect(isCorrectionFollowUp("Con U xfavor muchas gracias")).toBe(true);
    expect(isCorrectionFollowUp("¿cuánto cuesta el hemograma?")).toBe(false);
    expect(correctionAcked([{ from: "ASSISTANT", text: RESULT_CORRECTION_MESSAGE }])).toBe(true);
    expect(correctionAcked([{ from: "ASSISTANT", text: "¡Hola!" }])).toBe(false);
  });

  const from = "59170000009";
  const lease = { owner: "owner", fence: 1 };
  const text = (value: string, id: string): IncomingTurn => ({ kind: "TEXT", text: value, from, messageId: id });
  const image = (id: string): IncomingTurn => ({ kind: "IMAGE", from, messageId: id, mediaId: "m" } as IncomingTurn);
  const build = (acked = false) => {
    const audit = {
      claim: vi.fn(async () => ({ kind: "claimed" as const, runId: "run-c", lease })),
      renewLease: vi.fn(async () => true),
      recordIgnored: vi.fn(async () => undefined),
      recordFailure: vi.fn(async () => undefined),
      recordReply: vi.fn(async () => undefined),
      reserveSend: vi.fn(async () => "reserved" as const),
      confirmSend: vi.fn(async () => "proceed" as const)
    } as unknown as AuditRepository;
    const sendText = vi.fn(async () => undefined);
    const handler = vi.fn(async () => ({ body: "Respuesta del manejador" }));
    const analyze = vi.fn(async () => { throw new Error("sin análisis"); });
    const submit = vi.fn(async () => [{ state: "REGISTERED" }]);
    const deps = {
      audit, sendText, loadCatalog: vi.fn(async () => []), analyze, downloadImage: vi.fn(async () => ({ bytes: new Uint8Array() })), log: vi.fn(),
      turns: { handlers: { text: handler }, contactKeyFor: () => "e".repeat(64), correctionAcked: vi.fn(async () => acked), agentPilot: { isPilot: () => true, produce: vi.fn(async () => undefined) }, crmHandoff: { submit, submitSessionReview: vi.fn() } } as unknown as NonNullable<QuoteDeps["turns"]>
    } as unknown as QuoteDeps;
    return { deps, sendText, handler, analyze, submit };
  };

  it("foto del resultado + «me lo pueden corregir el nombre» + «Es Yuselin»: UN texto cálido fijo y el aviso al CRM (antes: silencio)", async () => {
    const { deps, sendText, handler, analyze, submit } = build();
    await processTurns([image("y-1"), text("Un favor me lo pueden corregir el nombre", "y-2"), text("Es Yuselin", "y-3"), text("Con U xfavor muchas gracias", "y-4")], deps);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect((sendText.mock.calls[0] as unknown as [string, string])[1]).toBe(RESULT_CORRECTION_MESSAGE);
    expect(handler).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
    expect((submit.mock.calls[0] as unknown as [unknown, Array<{ label: string }>])[1][0]!.label).toBe("RESULTS_READY");
  });
  it("ya respondido: «Con U por favor» se deja a la Dra (silencio)", async () => {
    const { deps, sendText, handler } = build(true);
    await processTurns([text("Con U por favor", "y-5")], deps);
    expect(sendText).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
  it("ya respondido, una pregunta nueva sigue su camino", async () => {
    const { deps, handler } = build(true);
    await processTurns([text("¿Cuánto cuesta el hemograma?", "y-6")], deps);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
