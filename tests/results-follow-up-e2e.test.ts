import { describe, expect, it, vi } from "vitest";
import type { AuditRepository } from "../src/audit.js";
import { RESULTS_NAME_ASK, RESULTS_PICKUP_INFO, RESULTS_THANKS, type ResultsStage } from "../src/results-silence.js";
import { processTurns, type IncomingTurn } from "../src/turns.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";

// Camino 2 «Consultar resultados» (decisión del dueño, 21-nov): pedir los datos → pedir el nombre completo UNA vez si falta → agradecer → silencio. El paso sale de los mensajes recientes (resultsStage).
const from = "59170000001";
const lease = { owner: "owner", fence: 1 };
const turn = (text: string, id: string): IncomingTurn => ({ kind: "TEXT", text, from, messageId: id });
const image = (id: string): IncomingTurn => ({ kind: "IMAGE", from, messageId: id, mediaId: `m-${id}` });

const build = (stage: ResultsStage | undefined) => {
  const recordIgnored = vi.fn(async () => undefined);
  const audit = {
    claim: vi.fn(async () => ({ kind: "claimed" as const, runId: "run-f", lease })),
    renewLease: vi.fn(async () => true),
    recordIgnored,
    recordFailure: vi.fn(async () => undefined),
    recordReply: vi.fn(async () => undefined),
    reserveSend: vi.fn(async () => "reserved" as const),
    confirmSend: vi.fn(async () => "proceed" as const)
  } as unknown as AuditRepository;
  const sendText = vi.fn(async () => undefined);
  const handler = vi.fn(async () => ({ body: "Respuesta del manejador" }));
  const analyze = vi.fn(async () => { throw new Error("NO DEBE EJECUTARSE"); });
  const resultsStage = vi.fn(async () => stage);
  const deps = {
    audit, sendText, loadCatalog: vi.fn(async () => []), analyze,
    downloadImage: vi.fn(async () => ({ bytes: new Uint8Array() })),
    log: vi.fn(),
    turns: { handlers: { text: handler }, contactKeyFor: () => "a".repeat(64), resultsStage } as unknown as NonNullable<QuoteDeps["turns"]>
  } as unknown as QuoteDeps;
  const sent = () => sendText.mock.calls.map((call) => (call as unknown as [string, string])[1]);
  return { deps, sendText, sent, handler, analyze, recordIgnored, resultsStage };
};

describe("camino 2: después de pedir los datos", () => {
  it("un nombre completo: agradece (y no pasa por el agente)", async () => {
    const { deps, sent, handler } = build("ASKED");
    await processTurns([turn("Porfirio Lozada Rivas", "n-1")], deps);
    expect(sent()).toEqual([RESULTS_THANKS]);
    expect(handler).not.toHaveBeenCalled();
  });
  it("se presenta con el nombre completo en un mensaje largo (caso real 21-nov): agradece con el texto fijo, sin pasar por el agente", async () => {
    const { deps, sent, handler } = build("ASKED");
    await processTurns([turn("Mi nombre es Ronald Sosa Céspedes y este número dejé como referencia", "n-long")], deps);
    expect(sent()).toEqual([RESULTS_THANKS]);
    expect(handler).not.toHaveBeenCalled();
  });
  it("solo una foto (el comprobante): agradece y la foto NO se analiza", async () => {
    const { deps, sent, analyze } = build("ASKED");
    await processTurns([image("img-1")], deps);
    expect(sent()).toEqual([RESULTS_THANKS]);
    expect(analyze).not.toHaveBeenCalled();
  });
  it("varios mensajes con el nombre entre ellos: UNA sola respuesta", async () => {
    const { deps, sent, recordIgnored } = build("ASKED");
    await processTurns([turn("Le pagué por QR", "n-2"), turn("Le tomaron foto", "n-3"), turn("Natalia Arancibia", "n-4")], deps);
    expect(sent()).toEqual([RESULTS_THANKS]);
    expect(recordIgnored).toHaveBeenCalledTimes(2);
  });
  it("un solo nombre («Porfirio») o sin nombre: pide el nombre completo UNA vez", async () => {
    for (const text of ["Porfirio", "señor porfirio", "hemograma, me lo hice ayer"]) {
      const { deps, sent } = build("ASKED");
      await processTurns([turn(text, `p-${text}`)], deps);
      expect(sent(), text).toEqual([RESULTS_NAME_ASK]);
    }
  });
  it("si vuelve a preguntar sin dar datos, también pide el nombre (no repite el mensaje largo)", async () => {
    const { deps, sent } = build("ASKED");
    await processTurns([turn("¿Ya están mis resultados?", "q-1")], deps);
    expect(sent()).toEqual([RESULTS_NAME_ASK]);
  });
  it("después de pedir el nombre, lo que mande se agradece tal cual: nunca se insiste más", async () => {
    const { deps, sent } = build("NAME_ASKED");
    await processTurns([turn("Porfirio", "n-5")], deps);
    expect(sent()).toEqual([RESULTS_THANKS]);
  });
  it("solo cortesía («ok», «gracias»): silencio", async () => {
    const { deps, sendText, handler } = build("ASKED");
    await processTurns([turn("ok gracias", "c-1")], deps);
    expect(sendText).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
  it("«¿puede recoger otra persona?»: responde lo que indicó la Dra", async () => {
    const { deps, sent } = build("ASKED");
    await processTurns([turn("¿Puede recoger otra persona mis resultados?", "o-1")], deps);
    expect(sent()).toEqual([RESULTS_PICKUP_INFO]);
  });
});

describe("camino 2: después de agradecer, silencio en todo lo de resultados (lo atiende la Dra)", () => {
  it.each([
    ["un nombre", [turn("Porfirio Lozada Rivas", "s-1")]],
    ["una foto", [image("s-2")]],
    ["otra consulta de resultados", [turn("¿A qué hora puedo pasar a recoger mis resultados?", "s-3")]],
    ["«¿puede recoger otra persona?»", [turn("¿Puede recoger otra persona mis resultados?", "s-4")]],
    ["cortesía", [turn("Muchas gracias", "s-5")]]
  ])("%s: no se contesta", async (_label, batch) => {
    const { deps, sendText, handler, analyze } = build("THANKED");
    await processTurns(batch, deps);
    expect(sendText).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
  });
});

describe("camino 2: lo que no es de este camino sigue su flujo", () => {
  it("un pedido propio SÍ se atiende, aunque se esté esperando a la Dra", async () => {
    for (const stage of ["ASKED", "THANKED"] as const) {
      const { deps, handler, sendText } = build(stage);
      await processTurns([turn("Quiero cotizar un hemograma", `k-${stage}`)], deps);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(sendText).toHaveBeenCalledTimes(1);
    }
  });
  it("sin una conversación de resultados, un nombre se atiende como siempre", async () => {
    const { deps, handler } = build(undefined);
    await processTurns([turn("Porfirio Lozada Rivas", "k-1")], deps);
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it("el paso se lee con los ids del lote excluidos (lo que acaba de llegar no cuenta como historial)", async () => {
    const { deps, resultsStage } = build("ASKED");
    await processTurns([turn("Porfirio Lozada Rivas", "x-1"), turn("Le pagué por QR", "x-2")], deps);
    expect(resultsStage).toHaveBeenCalledWith({ from, messageId: "x-1", excludeIds: ["x-1", "x-2"] });
  });
  it("si no se puede leer el paso, una consulta de resultados empieza de cero (pide los datos)", async () => {
    const { deps, sent, resultsStage } = build(undefined);
    resultsStage.mockRejectedValueOnce(new Error("red"));
    await processTurns([turn("¿Ya están mis resultados?", "z-1")], deps);
    expect(sent()[0]).toContain("Para verificar tu resultado, pásame por favor:");
  });
});
