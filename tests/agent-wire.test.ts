import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enforceOffline, releaseOfflineForTests } from "../src/offline.js";
import { createAgentModel, createOpenAiAgentClient } from "../src/agent/openai.js";
import { runAll, runScenario, summarize } from "../scripts/g7/lib/agent-eval.js";
import { AGENT_SCENARIOS, type ScriptedReply } from "../scripts/g7/lib/agent-scenarios.js";

// El adaptador REAL (SDK oficial de OpenAI, API Responses) contra un servidor LOCAL que imita /v1/responses. No hay red externa, ni clave real, ni datos de pacientes: sirve para comprobar el formato del cable
// (el PLAN con esquema estricto y la RESPUESTA en texto libre, sin estado ni herramientas nativas; lectura de output_text y del uso de tokens) y cómo se ven los errores reales del SDK (429 de cuota, 500, tiempo agotado, salida vacía).

interface Captured { path: string; auth: string | undefined; body: Record<string, any> }
let server: Server;
let baseUrl: string;
const captured: Captured[] = [];
// Lo que el servidor responde a la siguiente petición: una función que ve la petición.
let respond: (request: Captured, response: ServerResponse) => void;

const json = (response: ServerResponse, status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
const completion = (text: string, usage = { input_tokens: 120, output_tokens: 30, output_tokens_details: { reasoning_tokens: 10 } }) => ({
  id: "resp_local", object: "response", status: "completed", model: "modelo-local", created_at: 1,
  output: [{ type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
  usage
});
// El plan se distingue de la respuesta porque lleva el esquema estricto; la respuesta es texto libre (sin `text.format`).
const isPlan = (request: Captured): boolean => request.body.text?.format?.name === "plusmedik_agent_plan";
const planOf = (reply: ScriptedReply) => JSON.stringify({
  toolCalls: reply.calls.map((call) => { const input = call.input as Record<string, any>; return { tool: call.tool, text: input.question ?? input.query ?? null, studies: input.studies ?? null }; }),
  silent: reply.silent ?? false,
  handoff: reply.handoff ?? null
});
const scripted = (reply: () => ScriptedReply | undefined) => (request: Captured, response: ServerResponse) => { const current = reply()!; return json(response, 200, completion(isPlan(request) ? planOf(current) : current.text)); };

beforeAll(async () => {
  // Las pruebas bloquean toda la red; aquí (solo aquí) se libera para hablar con el servidor LOCAL de esta prueba, y se vuelve a bloquear al terminar.
  releaseOfflineForTests();
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const request: Captured = { path: req.url ?? "", auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") };
      captured.push(request);
      respond(request, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  process.env.OPENAI_BASE_URL = baseUrl;
});
afterAll(async () => {
  enforceOffline({ strict: false });
  delete process.env.OPENAI_BASE_URL;
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const modelOf = (timeoutMs = 10_000) => createAgentModel({ client: createOpenAiAgentClient({ apiKey: "sk-clave-falsa-local", model: "modelo-local", reasoningEffort: "medium" }), timeoutMs });
const find = (id: string) => AGENT_SCENARIOS.find((scenario) => scenario.id === id)!;

describe("el adaptador real contra un servidor local de Responses", () => {
  it("cada escenario sintético pasa de punta a punta con el SDK real: el plan estricto, la respuesta en texto libre, sin estado y sin herramientas nativas", async () => {
    let current: ScriptedReply | undefined;
    respond = scripted(() => current);
    captured.length = 0;
    const runs = [];
    for (const scenario of AGENT_SCENARIOS) {
      current = scenario.good[0];
      runs.push(...await runAll(modelOf(), { scenarios: [scenario], modelName: "modelo-local" }));
    }
    const summary = summarize(runs);
    expect(summary).toMatchObject({ scenarios: AGENT_SCENARIOS.length, passed: AGENT_SCENARIOS.length, rejected: 0, modelErrors: 0, failedList: [] });
    // salud sin precio no llama al modelo; fuera de tema solo planifica; el resto, plan + redacción. Tokens leídos del cable (output_tokens_details.reasoning_tokens incluido)
    const calls = 2 * (AGENT_SCENARIOS.length - 2) + 1;
    expect(captured.length).toBe(calls);
    expect(summary.usage).toMatchObject({ inputTokens: 120 * calls, outputTokens: 30 * calls, reasoningTokens: 10 * calls });
    for (const request of captured) {
      expect(request.path).toBe("/v1/responses");
      expect(request.auth).toBe("Bearer sk-clave-falsa-local");
      expect(request.body).toMatchObject({ model: "modelo-local", store: false, reasoning: { effort: "medium" } });
      expect(request.body.tools).toBeUndefined();
      // el plan lleva el esquema estricto; la respuesta es texto libre (sin formato)
      if (isPlan(request)) expect(request.body.text).toMatchObject({ format: { type: "json_schema", strict: true } });
      else expect(request.body.text).toBeUndefined();
      // PRIVACIDAD: en el cable real viaja solo esto; nada que identifique al paciente ni la conversación
      expect(Object.keys(request.body).sort()).toEqual(isPlan(request) ? ["input", "instructions", "max_output_tokens", "model", "reasoning", "store", "text"] : ["input", "instructions", "max_output_tokens", "model", "reasoning", "store"]);
      expect(JSON.stringify(request.body)).not.toMatch(/5917\d{7}|wamid|contact_key|[0-9a-f]{64}/);
      expect(typeof request.body.instructions).toBe("string");
      expect(request.body.max_output_tokens).toBeGreaterThan(0);
    }
  });

  it("lo que viaja en la petición es el texto del paciente tal cual (también si menciona salud, decisión del dueño); el modelo NUNCA ve los precios del catálogo", async () => {
    let current: ScriptedReply = find("salud-con-precio").good[0]!;
    respond = scripted(() => current);
    captured.length = 0;
    await runScenario(modelOf(), find("salud-con-precio"));
    current = find("cotizar-por-nombre").good[0]!;
    await runScenario(modelOf(), find("cotizar-por-nombre"));
    // Se revisa lo que va en `input` (el mensaje con lo que escribió el paciente y los hechos); las instrucciones fijas mencionan «Bs» para PROHIBIR escribirlo.
    const sent = JSON.stringify(captured.map((request) => request.body.input));
    expect(sent).toMatch(/diabetes/);
    expect(sent).not.toMatch(/\b45\b|30[.,]5|75[.,]5|Bs/);
    expect(sent).toContain("cuanto cuesta un hemograma");
  });

  it("un 429 de cuota (insufficient_quota) llega al registro como QUOTA_OR_BILLING con su estado, sin el mensaje del proveedor", async () => {
    respond = (_request, response) => json(response, 429, { error: { message: "You exceeded your current quota, detalle-secreto", type: "insufficient_quota", code: "insufficient_quota" } });
    const run = await runScenario(modelOf(), AGENT_SCENARIOS[0]!);
    expect(run.decision).toMatchObject({ status: "MODEL_ERROR", modelError: { cause: "QUOTA_OR_BILLING", httpStatus: 429, errorCode: "insufficient_quota" } });
    expect(JSON.stringify(run.decision)).not.toContain("detalle-secreto");
  });

  it("un 429 por velocidad, un 500 y una clave rechazada se distinguen por su causa", async () => {
    const causeFor = async (status: number, body: unknown, headers: Record<string, string> = {}) => {
      respond = (_request, response) => { response.writeHead(status, { "content-type": "application/json", ...headers }); response.end(JSON.stringify(body)); };
      return (await runScenario(modelOf(), AGENT_SCENARIOS[0]!)).decision?.modelError;
    };
    expect(await causeFor(429, { error: { message: "x", type: "requests", code: "rate_limit_exceeded" } }, { "retry-after": "2" })).toMatchObject({ cause: "RATE_LIMIT", httpStatus: 429, retryAfterS: 2 });
    expect(await causeFor(500, { error: { message: "x", type: "server_error", code: null } })).toMatchObject({ cause: "SERVER", httpStatus: 500 });
    expect(await causeFor(401, { error: { message: "x", type: "invalid_request_error", code: "invalid_api_key" } })).toMatchObject({ cause: "AUTH", httpStatus: 401 });
  });

  it("ya no existe una «salida inválida» que tumbe el turno: un plan que no es JSON se responde sin herramientas; solo una respuesta VACÍA es INVALID_OUTPUT, con su motivo y etapa", async () => {
    // el plan ilegible NO tumba el turno
    respond = (_request, response) => json(response, 200, completion("claro, te ayudo con eso"));
    const text = await runScenario(modelOf(), AGENT_SCENARIOS[0]!);
    expect(text.decision).toMatchObject({ status: "VERIFIED", planFallback: "plan_not_json", reply: "claro, te ayudo con eso" });
    // una respuesta vacía (por ejemplo, cortada por el tope de tokens) sí es un error del modelo, ahora con su motivo
    respond = (request, response) => json(response, 200, isPlan(request) ? completion(JSON.stringify({ toolCalls: [], silent: false, handoff: null })) : { ...completion(""), status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] });
    expect((await runScenario(modelOf(), AGENT_SCENARIOS[0]!)).decision?.modelError).toEqual({ cause: "INVALID_OUTPUT", stage: "respond", reason: "empty_incomplete_max_output_tokens" });
    respond = (_request, response) => json(response, 200, { ...completion(""), output: [] });
    const both = (await runScenario(modelOf(), AGENT_SCENARIOS[0]!)).decision;
    expect(both?.modelError).toEqual({ cause: "INVALID_OUTPUT", stage: "respond", reason: "empty" });
    expect(both?.planFallback).toBe("plan_empty");
  });

  it("un modelo que primero se equivoca y luego corrige: el segundo intento llega con los códigos y la decisión queda verificada", async () => {
    const hours = find("horario");
    let responds = 0;
    respond = (request, response) => {
      if (isPlan(request)) return json(response, 200, completion(planOf(hours.good[0]!)));
      responds += 1;
      return json(response, 200, completion(responds === 1 ? "Abrimos de 07:00 a 18:00 y entregamos en 24 horas." : hours.good[0]!.text));
    };
    captured.length = 0;
    const run = await runScenario(modelOf(), hours);
    expect(run.decision).toMatchObject({ status: "VERIFIED", repairs: 1, firstViolations: [{ code: "UNGROUNDED_FIGURE" }] });
    const retry = captured.filter((request) => !isPlan(request))[1]!;
    expect(retry.body.input).toMatch(/RECHAZADA/);
    expect(retry.body.input).not.toMatch(/24 horas/);
  });

  it("el mensaje del paciente viaja tal cual, con sus datos; lo que NO viaja es la clave, el teléfono de la conversación ni los ids de la plataforma", async () => {
    respond = (request, response) => json(response, 200, completion(isPlan(request) ? JSON.stringify({ toolCalls: [], silent: false, handoff: null }) : "Claro, con gusto te ayudo."));
    captured.length = 0;
    const scenario = { ...AGENT_SCENARIOS[0]!, turns: ["Hola, soy Maria Perez, mi hijo Luis tiene 8 años y quiero cotizar hemograma"] };
    await runScenario(modelOf(), scenario);
    expect(captured.length).toBeGreaterThanOrEqual(2);
    const sent = JSON.stringify(captured.map((request) => request.body.input));
    expect(sent).toContain("Maria Perez");
    expect(sent).toContain("hemograma");
    expect(JSON.stringify(captured.map((request) => request.body))).not.toMatch(/sk-clave-falsa|5917\d{7}|wamid|[0-9a-f]{64}/);
  });

  // Va al final: corta las conexiones del servidor para liberar la petición colgada.
  it("un servidor que no responde agota el tiempo configurado y queda como TIMEOUT (sin colgar)", async () => {
    respond = () => undefined;
    const started = Date.now();
    const run = await runScenario(modelOf(300), AGENT_SCENARIOS[0]!);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(run.decision).toMatchObject({ status: "MODEL_ERROR", modelError: { cause: "TIMEOUT" } });
    server.closeAllConnections?.();
  });
});
