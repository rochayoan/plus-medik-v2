import { describe, expect, it, vi } from "vitest";
import { guidanceFor, PREPARATION_NOTE } from "../src/agent/clinical-guidance.js";
import type { AgentModel, Fact, PlanOutput, RespondInput, Utterance } from "../src/agent/contracts.js";
import { parsePlan } from "../src/agent/openai.js";
import { runAgentTurn } from "../src/agent/pipeline.js";
import { verifyReply } from "../src/agent/verify.js";
import type { KnowledgeAnswer } from "../src/knowledge-answers.js";
import { createToolRegistry, labInfoTool, quoteStudiesTool } from "../src/agent/tools.js";
import type { AuditRepository } from "../src/audit.js";
import { typoCandidates } from "../src/catalog-search.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { greetingMenu, menuChoiceDecision, menuChoiceOf, menuSwitchOffer, MENU_OPTIONS, switchOfferOf } from "../src/greeting-menu.js";
import { formatGroupedOptions } from "../src/quote-options.js";
import { decideResultsAction, looksLikeIdentification, RESULTS_NAME_ASK, RESULTS_SWITCH_TAIL, RESULTS_THANKS, resultsAskMessage, resultsStageOf, routeResultsMessage } from "../src/results-silence.js";
import { processTurns, type IncomingTurn } from "../src/turns.js";
import type { CatalogStudy } from "../src/types.js";
import { isTypoOf, mentionsQuoting } from "../src/typo.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";

// Revisión de las conversaciones reales del 23-nov. Cada bloque es una CLASE de caso, no solo el mensaje que falló.
//   · 7a4267c3: «Hola» → menú → «2» → pedido de datos → «3» (lo tomó como dato) → «Ubicación y horarios de atención» → «Si» (sin respuesta) → «Cotozame hcg, hiv y Sífilis» (→ «Enseguida la doctora revisa tu resultado»).
//   · 6fae1e98: «Cotízame hgc, hiv y sífilis» → cotizó HIV y sífilis y dejó «Hgc» para la doctora, sin sugerir HCG.

const NOW = new Date("2026-11-23T14:00:00Z");
const LOCATION_REPLY = "Estamos en Av. Ejemplo 123 📍 https://maps.app.goo.gl/abcDEF Atendemos las 24 horas, todos los días 😊 ¿Quieres que te cotice algún estudio?";
type Entry = { from: "PATIENT" | "ASSISTANT" | "STAFF"; text: string };

const study = (id: string, name: string, aliases: string[], priceBs: number): CatalogStudy =>
  ({ id, code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active: true, category: null, sampleType: null, turnaroundText: "en el día" }) as unknown as CatalogStudy;
const BETA_HCG = study("hcg-cuanti", "BETA HCG CUANTITATIVA", ["beta hcg", "hcg"], 120);
const HCG_CUALI = study("hcg-cuali", "HCG SUB UNIDAD BETA CUALITATIVA", ["prueba de embarazo", "hcg"], 60);
const HIV = study("hiv", "HIV 1+2 (ANTICUERPOS)", ["hiv", "vih"], 50);
const HCV = study("hcv", "HEPATITIS C (HCV)", ["hcv"], 150);
const SIF_G = study("sif-g", "SIFILIS IGG", [], 200);
const SIF_M = study("sif-m", "SIFILIS IGM", [], 200);
const LIPASA = study("lipasa", "LIPASA", [], 80);
const AST = study("ast", "ASPARTATO AMINOTRANSFERASA", [], 40);
const HEMOGRAMA = study("hemo", "HEMOGRAMA COMPLETO AUTOMATIZADO", ["hemograma"], 45);
const PAUL = study("paul", "PAUL BUNNELL", [], 70);
const CATALOG = [BETA_HCG, HIV, HCV, SIF_G, SIF_M, LIPASA, AST, HEMOGRAMA, PAUL];

describe("«cotizar» se reconoce aunque venga mal escrito", () => {
  it.each(["Cotozame hcg, hiv y Sífilis", "cotisame un hemograma", "kotizame la glucosa", "cotizane esto", "coitzame porfa", "cptizame", "me lo coticen", "Cotízame hgc, hiv y sífilis", "quiero una cotizacion"])("SÍ: «%s»", (text) => {
    expect(mentionsQuoting(text)).toBe(true);
  });
  it.each(["Juan Pérez Rojas", "algo cotidiano", "en la cocina", "el costo", "la cortina", "hemograma del lunes", "3"])("no: «%s»", (text) => {
    expect(mentionsQuoting(text)).toBe(false);
  });
});

describe("erratas de estudios (letras cambiadas de lugar, una de más o de menos)", () => {
  it.each([["hgc", "hcg"], ["hvi", "hiv"], ["hcgg", "hcg"], ["lipsaa", "lipasa"], ["hemogarma", "hemograma"], ["ferirtina", "ferritina"]])("«%s» es errata de «%s»", (written, known) => {
    expect(isTypoOf(written, known)).toBe(true);
  });
  // En una sigla, cambiar una letra por otra da OTRO estudio: no es errata.
  it.each([["hcv", "hiv"], ["tsh", "fsh"], ["ldh", "lh"], ["hcg", "hcg"], ["fsh", "hsf"]])("«%s» NO es errata de «%s»", (written, known) => {
    expect(isTypoOf(written, known)).toBe(false);
  });
  it("sirve para TODO el catálogo, sin alias cargados a mano", () => {
    expect(typoCandidates("hgc", CATALOG).map((item) => item.id)).toEqual(["hcg-cuanti"]);
    expect(typoCandidates("hvi", CATALOG).map((item) => item.id)).toEqual(["hiv"]);
    expect(typoCandidates("lipsaa", CATALOG).map((item) => item.id)).toEqual(["lipasa"]);
    expect(typoCandidates("beta hgc", CATALOG).map((item) => item.id)).toEqual(["hcg-cuanti"]);
    expect(typoCandidates("hcv", CATALOG)).toEqual([]);
    expect(typoCandidates("xyz", CATALOG)).toEqual([]);
  });
});

describe("6fae1e98: «Cotízame hgc, hiv y sífilis» sugiere HCG con su precio en vez de dejarlo a la doctora", () => {
  type Result = { facts?: Array<{ text: string; refs: string[] }>; blocks?: string[] };
  const run = (catalog: readonly CatalogStudy[], studies: string[], guesses?: Array<{ written: string; guess: string }>) =>
    quoteStudiesTool({ loadCatalog: async () => catalog }).run({ studies, ...(guesses ? { guesses } : {}) }, { now: NOW, patientText: studies.join(", ") } as never) as Promise<Result>;

  it("un solo candidato: «¿Con «hgc» quisiste decir…?» con precio, fuera del total; HIV y sífilis se cotizan", async () => {
    const result = await run(CATALOG, ["hgc", "hiv", "sífilis"]);
    const blocks = result.blocks!.join("\n");
    expect(result.facts?.[0]?.refs).toEqual(expect.arrayContaining(["study:hiv", "study:sif-g", "study:sif-m"]));
    expect(result.facts?.[0]?.refs).not.toContain("study:hcg-cuanti");
    expect(blocks).toContain("🔎 ¿Con «hgc» quisiste decir *BETA HCG CUANTITATIVA*?");
    expect(blocks).toContain("Bs 120");
    expect(blocks).toContain("Si es así, respóndeme «sí» y te lo sumo a la cotización");
    expect(blocks).not.toContain("Este estudio te lo confirma la doctora");
    expect(result.facts?.some((fact) => fact.text.includes("«hgc»") && fact.text.includes("error de tipeo"))).toBe(true);
  });
  it("varios candidatos (HCG cuantitativa y cualitativa): la lista numerada con precios", async () => {
    const blocks = (await run([...CATALOG, HCG_CUALI], ["hgc", "hiv"])).blocks!.join("\n");
    expect(blocks).toContain("*Para «hgc»:*");
    expect(blocks).toContain("BETA HCG CUANTITATIVA — Bs 120");
    expect(blocks).toContain("HCG SUB UNIDAD BETA CUALITATIVA — Bs 60");
  });
  it("sin errata posible, lo que cree el modelo («mono test» → Paul Bunnell) también se sugiere", async () => {
    const blocks = (await run(CATALOG, ["mono test"], [{ written: "mono test", guess: "paul bunnell" }])).blocks!.join("\n");
    expect(blocks).toContain("¿Con «mono test» quisiste decir *PAUL BUNNELL*?");
    expect(blocks).toContain("te armo la cotización");
  });
  it("sin errata ni idea del modelo, sigue igual: lo confirma la doctora", async () => {
    const blocks = (await run(CATALOG, ["mono test"])).blocks!.join("\n");
    expect(blocks).toContain("te lo confirma la doctora");
    expect(blocks).not.toContain("quisiste decir");
  });
  it("lo que cree el modelo NUNCA se cotiza solo ni tapa lo que el paciente escribió bien", async () => {
    const result = await run(CATALOG, ["hemograma"], [{ written: "hemograma", guess: "lipasa" }]);
    expect(result.facts?.[0]?.refs).toEqual(["study:hemo"]);
    expect(result.blocks!.join("\n")).not.toContain("LIPASA");
  });
  it("el plan del modelo lleva sus ideas a quote_studies", () => {
    const plan = parsePlan(JSON.stringify({ toolCalls: [{ tool: "quote_studies", text: null, studies: ["hgc", "hiv"], guesses: [{ written: "hgc", guess: "beta hcg" }] }], silent: false, handoff: null }));
    expect(plan.toolCalls[0]!.input).toEqual({ studies: ["hgc", "hiv"], guesses: [{ written: "hgc", guess: "beta hcg" }] });
    expect(parsePlan(JSON.stringify({ toolCalls: [{ tool: "quote_studies", text: null, studies: ["hiv"], guesses: null }], silent: false, handoff: null })).toolCalls[0]!.input).toEqual({ studies: ["hiv"] });
  });
  it("una sugerencia que no viene de una errata sigue en la lista de siempre", () => {
    expect(formatGroupedOptions([{ label: "hepatitis", studies: [HCV] }], false)).toContain("*Para «hepatitis»:*");
  });
});

describe("cambiar de opción en medio del camino de resultados", () => {
  const ask = resultsAskMessage(NOW);
  it("el texto de cada opción: claro, con el número y cómo seguir con el resultado", () => {
    expect(menuSwitchOffer(3)).toBe(`Me escribiste «3» 😊 ¿Quieres que te pase nuestra *ubicación y horarios* (opción 3️⃣)? Respóndeme «sí» y te ayudo con eso.\n${RESULTS_SWITCH_TAIL}`);
    expect(menuSwitchOffer(1)).toContain("¿Quieres *cotizar estudios* (opción 1️⃣)?");
    expect(menuSwitchOffer(4)).toContain("¿Quieres pedir un *estudio a domicilio* (opción 4️⃣)?");
    expect(menuSwitchOffer(5)).toContain("¿Quieres *hablar con una persona* del laboratorio (opción 5️⃣)?");
    expect(RESULTS_SWITCH_TAIL).toBe("Si no es así y quieres consultar tu resultado, pásame el nombre completo del paciente (nombre y apellidos) 🙏");
    for (const option of [1, 3, 4, 5]) expect(switchOfferOf(menuSwitchOffer(option)!)).toBe(option);
    expect(switchOfferOf(greetingMenu(NOW))).toBeUndefined();
  });
  it("un número solo del 1 al 5 mientras se esperan los datos: se ofrece cambiar (el 2 es la misma opción: se pide el nombre)", () => {
    for (const stage of ["ASKED", "NAME_ASKED"] as const) {
      expect(decideResultsAction({ stage, query: false, data: "NONE", courtesy: false, menuNumber: 3 })).toBe("SWITCH_OFFER");
      expect(decideResultsAction({ stage, query: false, data: "NONE", courtesy: false, menuNumber: 2 })).toBe("NAME_ASK");
    }
    expect(decideResultsAction({ stage: "THANKED", query: false, data: "NONE", courtesy: false, menuNumber: 3 })).toBe("SILENT");
    expect(decideResultsAction({ query: false, data: "NONE", courtesy: false, menuNumber: 3 })).toBeUndefined();
  });
  it("tras la oferta: «sí» o el mismo número eligen esa opción; otro número no; el nombre sigue siendo el dato", () => {
    const recent: Entry[] = [{ from: "ASSISTANT", text: ask }, { from: "PATIENT", text: "3" }, { from: "ASSISTANT", text: menuSwitchOffer(3)! }];
    for (const yes of ["sí", "Si", "si por favor", "dale", "ok", "3", "claro"]) expect(menuChoiceOf(yes, recent)?.code, yes).toBe("LOCATION");
    expect(menuChoiceOf("4", recent)).toBeUndefined();
    expect(menuChoiceOf("Juan Pérez", recent)).toBeUndefined();
    expect(resultsStageOf(recent)).toBe("ASKED");
    // Un «sí» o un «ok» al menú del saludo (o a cualquier otra cosa) no elige nada.
    expect(menuChoiceOf("ok", [{ from: "ASSISTANT", text: greetingMenu(NOW) }])).toBeUndefined();
    expect(menuChoiceOf("si", [{ from: "ASSISTANT", text: LOCATION_REPLY }])).toBeUndefined();
    expect(menuChoiceDecision("2", [{ from: "ASSISTANT", text: greetingMenu(NOW) }])?.option.code).toBe("RESULTS");
  });
  it("el pedido de datos se cierra si el asistente respondió otra cosa después; el agradecimiento no", () => {
    expect(resultsStageOf([{ from: "ASSISTANT", text: ask }, { from: "PATIENT", text: "Ubicación" }, { from: "ASSISTANT", text: LOCATION_REPLY }])).toBeUndefined();
    expect(resultsStageOf([{ from: "ASSISTANT", text: RESULTS_NAME_ASK }, { from: "ASSISTANT", text: LOCATION_REPLY }])).toBeUndefined();
    expect(resultsStageOf([{ from: "ASSISTANT", text: RESULTS_THANKS }, { from: "ASSISTANT", text: LOCATION_REPLY }])).toBe("THANKED");
  });
  it("pedir cotizar (aunque esté mal escrito) no es un dato del paciente; nombrar el estudio que se hizo sí puede serlo", () => {
    expect(looksLikeIdentification("Cotozame hcg, hiv y Sífilis")).toBe(false);
    expect(looksLikeIdentification("cotisame hemograma")).toBe(false);
    expect(routeResultsMessage("cotozame hemograma y quiero mi resultado")).toBe("NORMAL");
    // El pedido de datos pregunta «qué estudio te hiciste y qué día»: esto es la respuesta, no un pedido de cotización.
    expect(looksLikeIdentification("Juan Pérez, hemograma del lunes")).toBe(true);
    expect(looksLikeIdentification("Juan Pérez Rojas")).toBe(true);
  });
});

describe("7a4267c3 de punta a punta (processTurns con el historial real)", () => {
  const from = "59170000023";
  const lease = { owner: "owner", fence: 1 };
  let seq = 0;
  const text = (value: string): IncomingTurn => ({ kind: "TEXT", text: value, from, messageId: `m-${++seq}` });
  const build = (history: Entry[]) => {
    const audit = {
      claim: vi.fn(async () => ({ kind: "claimed" as const, runId: `run-${seq}`, lease })),
      renewLease: vi.fn(async () => true),
      recordIgnored: vi.fn(async () => undefined),
      recordFailure: vi.fn(async () => undefined),
      recordReply: vi.fn(async () => undefined),
      reserveSend: vi.fn(async () => "reserved" as const),
      confirmSend: vi.fn(async () => "proceed" as const)
    } as unknown as AuditRepository;
    const sent: string[] = [];
    const sendText = vi.fn(async (_to: string, body: string) => {
      sent.push(body);
      history.push({ from: "ASSISTANT", text: body });
      return undefined;
    });
    // El agente: responde la ubicación si se la piden y, si no, deja constancia de lo que recibió (para ver que le llegó).
    const produce = vi.fn(async ({ turns }: { turns: ReadonlyArray<{ text?: string }> }) => {
      const asked = turns.map((turn) => turn.text ?? "").join(" ");
      const body = /ubicad|ubicaci/i.test(asked) ? LOCATION_REPLY : `AGENTE: ${asked}`;
      return { body, result: "conversation" as const, processingStatus: "COMPLETED" as const, stale: "NEWER_TURN" as const, quality: "ANSWER", quotedStudyIds: [] };
    });
    const recent = async () => history.map((entry) => ({ ...entry }));
    const deps = {
      audit, sendText, loadCatalog: vi.fn(async () => CATALOG), analyze: vi.fn(async () => { throw new Error("sin análisis"); }), downloadImage: vi.fn(async () => ({ bytes: new Uint8Array() })), log: vi.fn(),
      turns: {
        handlers: { text: vi.fn(async () => ({ body: "Respuesta del manejador" })) },
        contactKeyFor: () => "f".repeat(64),
        resultsStage: async () => resultsStageOf(await recent()),
        menuChoice: async ({ text: value }: { text: string }) => menuChoiceDecision(value, await recent())?.option.canonical,
        agentPilot: { isPilot: () => true, produce },
        crmHandoff: { submit: vi.fn(async () => [{ state: "REGISTERED" }]), submitSessionReview: vi.fn() }
      } as unknown as NonNullable<QuoteDeps["turns"]>
    } as unknown as QuoteDeps;
    const say = async (value: string): Promise<string | undefined> => {
      history.push({ from: "PATIENT", text: value });
      const before = sent.length;
      await processTurns([text(value)], deps);
      return sent.length > before ? sent[sent.length - 1] : undefined;
    };
    return { say, produce };
  };

  it("la conversación completa: cada mensaje sigue el camino que pidió el paciente", async () => {
    const history: Entry[] = [{ from: "PATIENT", text: "Hola" }, { from: "ASSISTANT", text: greetingMenu(NOW) }];
    const { say, produce } = build(history);
    expect(await say("2")).toContain("Para verificar tu resultado, pásame por favor");
    // Antes: «¿Me pasas el nombre completo del paciente…?»
    expect(await say("3")).toBe(menuSwitchOffer(3));
    expect(produce).not.toHaveBeenCalled();
    expect(await say("Ubicación y horarios de atención")).toBe(LOCATION_REPLY);
    // Antes: silencio.
    expect(await say("Si")).toBe("AGENTE: Si");
    // Antes: «¡Gracias por compartirnos tus datos! 😊 Enseguida la doctora revisa tu resultado…»
    const last = await say("Cotozame hcg, hiv y Sífilis");
    expect(last).toBe("AGENTE: Cotozame hcg, hiv y Sífilis");
    expect(last).not.toBe(RESULTS_THANKS);
  });

  it("«3» y luego «sí»: va a la ubicación (la frase de la opción llega al agente)", async () => {
    const history: Entry[] = [{ from: "ASSISTANT", text: resultsAskMessage(NOW) }];
    const { say } = build(history);
    expect(await say("3")).toBe(menuSwitchOffer(3));
    expect(await say("sí")).toBe(LOCATION_REPLY);
  });

  it("«3» y luego el nombre: se agradece como siempre", async () => {
    const history: Entry[] = [{ from: "ASSISTANT", text: resultsAskMessage(NOW) }];
    const { say } = build(history);
    expect(await say("3")).toBe(menuSwitchOffer(3));
    expect(await say("María Fernanda Rojas")).toBe(RESULTS_THANKS);
  });

  it("justo después del pedido de datos, «Cotozame …» también va a cotizar", async () => {
    const history: Entry[] = [{ from: "ASSISTANT", text: resultsAskMessage(NOW) }];
    const { say } = build(history);
    expect(await say("Cotozame hcg, hiv y Sífilis")).toBe("AGENTE: Cotozame hcg, hiv y Sífilis");
  });

  it("«5» en medio del camino de resultados y «sí»: el pedido de una persona sigue su camino", async () => {
    const history: Entry[] = [{ from: "ASSISTANT", text: resultsAskMessage(NOW) }];
    const { say } = build(history);
    expect(await say("5")).toBe(menuSwitchOffer(5));
    const reply = await say("si");
    expect(reply).not.toBe(RESULTS_NAME_ASK);
    expect(reply).not.toBe(RESULTS_THANKS);
  });

  it("los números de opción siguen funcionando con el menú del saludo", () => {
    expect(MENU_OPTIONS.map((option) => option.number)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("preparación y valores de referencia: orientación general en vez de «no tengo el dato, consulta con tu médico»", () => {
  it.each([
    ["Para un hemograma es necesario que vaya en ayunas?", ["PREPARATION"]],
    ["puedo desayunar antes del perfil lipídico?", ["PREPARATION"]],
    ["como recojo la muestra de orina?", ["PREPARATION"]],
    ["Será que me puede decir los valores de ref de la ferritina", ["REFERENCE"]],
    ["cual es el rango normal de la glucosa", ["REFERENCE"]],
    // Un resultado propio es interpretación (la Dra); síntomas o medicamentos tampoco.
    ["mi ferritina salió 15, cuál es el valor normal?", []],
    ["los valores de referencia de mi resultado", []],
    ["tomo metformina, puedo ir en ayunas?", []],
    ["cuánto cuesta el hemograma", []]
  ])("«%s» → %j", (text, expected) => {
    expect(guidanceFor(text as string, [])).toEqual(expected);
  });
  it("con la preparación APROBADA del laboratorio no hace falta orientación general; con sus valores de referencia cargados, tampoco", () => {
    const approved: Fact = { id: "lab_info:1", source: "LAB_INFO", text: "Hemograma: no requiere ayuno", refs: ["STUDY_PREPARATION:hemo@1:abc"] };
    expect(guidanceFor("el hemograma es en ayunas?", [approved])).toEqual([]);
    expect(guidanceFor("valores de referencia de la ferritina", [{ id: "r", source: "REFERENCE_RANGE", text: "Ferritina: …", refs: [] }])).toEqual([]);
  });
  it("la orientación de preparación puede dar horas o volúmenes; el dinero y los teléfonos siguen bloqueados", () => {
    const text = "Para la glucosa se recomienda un ayuno de 8 a 12 horas y para la orina de 24 horas guarda toda la orina.";
    expect(verifyReply({ text, facts: [] }).map((v) => v.code)).toContain("UNGROUNDED_FIGURE");
    expect(verifyReply({ text, facts: [], guidanceFigures: true })).toEqual([]);
    expect(verifyReply({ text: "Ayuno de 8 horas, cuesta Bs 30", facts: [], guidanceFigures: true }).map((v) => v.code)).toContain("PRICE_OUTSIDE_QUOTE");
    expect(verifyReply({ text: "Ayuno de 8 horas, llama al 78555440", facts: [], guidanceFigures: true }).map((v) => v.code)).toContain("UNGROUNDED_FIGURE");
  });

  const u = (text: string): Utterance => ({ topic: "OTHER_LAB", text } as Utterance);
  const tools = createToolRegistry([labInfoTool({ answer: async () => undefined as unknown as KnowledgeAnswer }), quoteStudiesTool({ loadCatalog: async () => CATALOG })]);
  const model = (plan: Partial<PlanOutput>, text: string, seen: RespondInput[]): AgentModel => ({
    async plan() { return { toolCalls: [], ...plan, usage: { inputTokens: 1, outputTokens: 1 } }; },
    async respond(input) { seen.push(input); return { text, usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } }; }
  });

  it("hemograma en ayunas: el redactor recibe la orientación general, puede dar horas y el sistema agrega la nota", async () => {
    const seen: RespondInput[] = [];
    const text = "Para el hemograma no hace falta ir en ayunas 😊 Si junto con él te haces glucosa o perfil lipídico, ahí sí son de 8 a 12 horas de ayuno.";
    const decision = await runAgentTurn({ model: model({ toolCalls: [{ tool: "lab_info", input: { question: "hemograma en ayunas" } }] }, text, seen), tools }, { utterances: [u("Para un hemograma es necesario que vaya en ayunas?")] });
    expect(decision.status).toBe("VERIFIED");
    expect(decision.reply).toBe(`${text}\n\n${PREPARATION_NOTE}`);
    expect(decision.guidance).toEqual(["PREPARATION"]);
    expect(seen[0]!.facts.some((fact) => fact.source === "GENERAL_GUIDANCE" && fact.text.includes("NO digas que no tienes el dato"))).toBe(true);
    // El «sin datos» del conocimiento ya no le dice al modelo que no lo invente.
    expect(seen[0]!.notes.some((note) => note.startsWith("lab_info:"))).toBe(false);
  });

  it("valores de referencia de la ferritina: sin cifras, sin derivar aunque el plan dijera MEDICAL", async () => {
    const seen: RespondInput[] = [];
    const handoff = vi.fn(async () => true);
    const text = "La ferritina mide las reservas de hierro del cuerpo. Su rango de referencia viene en tu informe junto al resultado, porque depende del método, la edad y el sexo. ¿Quieres que te la cotice?";
    const decision = await runAgentTurn({ model: model({ handoff: "MEDICAL" }, text, seen), tools, handoff }, { utterances: [u("Será que me puede decir los valores de ref de la ferritina")], capabilities: { handoff: true, quote: true } });
    expect(decision.status).toBe("VERIFIED");
    expect(decision.reply).toBe(text);
    expect(decision.guidance).toEqual(["REFERENCE"]);
    expect(handoff).not.toHaveBeenCalled();
    // Un rango con cifras inventado por el modelo se rechaza.
    const withFigures = await runAgentTurn({ model: model({}, "La ferritina normal es de 30 a 400 ng/mL.", []), tools }, { utterances: [u("valores de referencia de la ferritina")] });
    expect(withFigures.status).toBe("REJECTED");
  });

  it("interpretar un resultado propio sigue derivándose", async () => {
    const handoff = vi.fn(async () => true);
    const decision = await runAgentTurn({ model: model({ handoff: "MEDICAL" }, "Lo revisa la doctora y una persona del laboratorio te responde por aquí.", []), tools, handoff }, { utterances: [u("mi ferritina salió 15, es normal?")], capabilities: { handoff: true, quote: true } });
    expect(decision.guidance).toBeUndefined();
    expect(handoff).toHaveBeenCalledWith("MEDICAL");
  });
});
