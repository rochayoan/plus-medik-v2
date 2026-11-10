import { describe, expect, it, vi } from "vitest";
import { BLOCKED_HANDOFF, classifyText, createTextHandler, DRAFT_TEXTS, UnsafeTextError, type ConversationTexts, type HandoffRequest, type HandoffSink } from "../src/text-handler.js";
import type { IncomingTurn } from "../src/turns.js";

// Manejador de texto mínimo y DETERMINISTA (sin modelos): clasifica con reglas, responde con textos fijos sin cifras y solo confirma una derivación a una persona cuando
// su persistencia está garantizada. Las garantías de envío (duplicados, pausa, obsolescencia) las da la coordinación de turnos: tests/turns*.test.ts.

const turn = (text: string, overrides: Partial<IncomingTurn> = {}): IncomingTurn => ({ messageId: "wamid.t1", from: "59170000000", kind: "TEXT", text, ...overrides });
const SENTINEL = "TEXTO_CLINICO_SENTINELA_7788";

function sink(behaviour: "ok" | "duplicate" | "fail", operational = true) {
  const requests: HandoffRequest[] = [];
  const handoff: HandoffSink = {
    operational,
    record: vi.fn(async (request) => {
      requests.push(request);
      if (behaviour === "fail") throw new Error(`persistencia caída ${SENTINEL}`);
      return behaviour === "duplicate" ? "DUPLICATE" : "RECORDED";
    })
  };
  return { handoff, requests };
}
function setup(options: { handoff?: HandoffSink; texts?: ConversationTexts } = {}) {
  const logs: Array<[string, Record<string, unknown>]> = [];
  const handler = createTextHandler({ handoff: options.handoff, texts: options.texts, log: (event, data) => logs.push([event, data]) });
  return { handler, logs };
}

describe("classifyText: clasificación determinista", () => {
  const cases: Array<[string, string[]]> = [
    ["GREETING", ["hola", "Hola!", "HOLA, buenas tardes", "buenos días", "Buenas", "hey", "  buen día  "]],
    ["RECIPE_OR_QUOTE", ["quiero cotizar", "cuánto cuesta un hemograma", "necesito el precio de la TSH", "tengo una receta", "me pasan un presupuesto?", "hola quiero cotizar unos análisis"]],
    ["INFO_REQUEST", ["¿a qué hora abren?", "cuál es el horario", "dónde están ubicados", "su dirección por favor", "aceptan tarjeta", "cómo puedo pagar", "tengo que ir en ayuno?", "hacen servicio a domicilio", "cuándo entregan los resultados", "tienen convenio con mi seguro", "atienden los sábados"]],
    ["HUMAN_REQUEST", ["quiero hablar con una persona", "pásame con un asesor", "necesito un humano", "me comunican con recepción", "llámenme por favor", "quiero hablar con alguien del laboratorio"]],
    ["MEDICAL", ["me duele la cabeza", "tengo fiebre y mareos", "qué dosis de ibuprofeno tomo", "me pueden interpretar mi resultado", "es una urgencia", "estoy embarazada, qué debo hacer", "tengo diabetes"]],
    ["OTHER", ["gracias", "ok", "😀", "jajaja", "no entiendo", "asdf"]]
  ];
  for (const [category, texts] of cases) {
    it(`${category}: ${texts.length} variaciones`, () => {
      for (const text of texts) expect(classifyText(text), text).toBe(category);
    });
  }

  it("prioridad conservadora: lo médico gana a todo, una persona gana a la información, la información gana a cotizar", () => {
    expect(classifyText("hola, me duele mucho, quiero cotizar")).toBe("MEDICAL");
    expect(classifyText("quiero hablar con un asesor para cotizar")).toBe("HUMAN_REQUEST");
    expect(classifyText("cuánto cuesta con convenio")).toBe("INFO_REQUEST");
  });

  it("ignora mayúsculas, tildes, signos y espacios; un texto vacío o solo signos es OTHER; un texto enorme se clasifica sin fallar", () => {
    expect(classifyText("¿¿CUÁNTO   CUESTA??")).toBe("RECIPE_OR_QUOTE");
    expect(classifyText("")).toBe("OTHER");
    expect(classifyText("¿¿??!!")).toBe("OTHER");
    // un texto enorme se examina solo hasta un tope (tiempo acotado); si en ese tramo no hay nada reconocible, un mensaje tan largo necesita a una persona
    expect(classifyText("hola ".repeat(50_000))).toBe("HUMAN_REQUEST");
    expect(classifyText(`${"x".repeat(100_000)} me duele`)).toBe("HUMAN_REQUEST");
    expect(classifyText(`me duele ${"x".repeat(100_000)}`)).toBe("MEDICAL");
  });
});

describe("textos de respuesta: sin políticas, horarios, precios ni datos médicos", () => {
  it("los textos por defecto no tienen cifras, moneda, plazos ni horarios", () => {
    for (const [key, text] of Object.entries(DRAFT_TEXTS)) {
      expect(text, key).not.toMatch(/\d/);
      expect(text, key).not.toMatch(/\b(bs|bob|usd)\b|\$/i);
      expect(text, key).not.toMatch(/\b(hora|horas|minuto|minutos|dia|dias|semana|lunes|martes|sabado|domingo|gratis|descuento)\b/i);
    }
  });

  it("un texto configurado con cifras, precios o plazos se rechaza al construir el manejador (no se puede inventar un dato por configuración)", () => {
    for (const bad of ["Atendemos de 8 a 18", "Tu cotización cuesta Bs 45", "Te respondemos en 24 horas", "Es gratis", "Abrimos el sábado", "Llámanos al 7000"]) {
      expect(() => createTextHandler({ texts: { ...DRAFT_TEXTS, fallback: bad }, log: () => undefined }), bad).toThrow(UnsafeTextError);
    }
    expect(() => createTextHandler({ texts: { ...DRAFT_TEXTS, greeting: "" }, log: () => undefined })).toThrow(UnsafeTextError);
    expect(() => createTextHandler({ texts: { ...DRAFT_TEXTS, greeting: "Hola" } as ConversationTexts, log: () => undefined })).not.toThrow();
  });

  it("los textos que no son de derivación no prometen que una persona responderá", () => {
    // handoff_unavailable queda fuera a propósito: por decisión del laboratorio (2026-11-10) avisa que un asesor atenderá la consulta.
    for (const key of ["greeting", "send_recipe", "fallback", "medical_unavailable"] as const) {
      expect(DRAFT_TEXTS[key], key).not.toMatch(/te escribir|te llamar|te contactar|revisar|responder|asesor/i);
    }
  });
});

describe("respuestas por categoría (sin derivación)", () => {
  it("saludo, cotizar y otros reciben un texto fijo; son descartables si el paciente ya escribió de nuevo", async () => {
    const t = setup();
    for (const [text, expected] of [["hola", DRAFT_TEXTS.greeting], ["quiero cotizar", DRAFT_TEXTS.send_recipe], ["gracias", DRAFT_TEXTS.fallback]] as const) {
      expect(await t.handler(turn(text))).toEqual({ body: expected, stale: "NEWER_TURN" });
    }
  });

  it("un turno sin texto no genera respuesta", async () => {
    const t = setup();
    expect(await t.handler(turn("", { text: undefined }))).toBeUndefined();
  });

  it("solo registra la categoría (código): nunca el texto del paciente ni su teléfono", async () => {
    const t = setup();
    await t.handler(turn(`${SENTINEL} quiero cotizar`));
    expect(t.logs).toEqual([["text_turn", { category: "RECIPE_OR_QUOTE", handoff: "none" }]]);
    expect(JSON.stringify(t.logs)).not.toContain(SENTINEL);
    expect(JSON.stringify(t.logs)).not.toContain("59170000000");
  });
});

describe("derivación a una persona: bloqueada mientras su persistencia no esté garantizada", () => {
  const requests = ["quiero hablar con una persona", "¿a qué hora abren?", "me duele la cabeza"];

  it("por defecto (sin sumidero) NUNCA confirma una derivación: responde con el texto de 'no disponible' y no registra nada", async () => {
    for (const handoff of [undefined, BLOCKED_HANDOFF]) {
      const t = setup({ handoff });
      for (const text of requests) {
        const reply = await t.handler(turn(text));
        expect(reply!.body, text).not.toBe(DRAFT_TEXTS.handoff_confirmed);
        expect(reply!.body, text).toBe(text.includes("duele") ? DRAFT_TEXTS.medical_unavailable : DRAFT_TEXTS.handoff_unavailable);
      }
      expect(t.logs.map(([, data]) => data.handoff)).toEqual(["blocked", "blocked", "blocked"]);
    }
  });

  it("un sumidero declarado no operativo se trata igual que bloqueado: no se le llama", async () => {
    const s = sink("ok", false);
    const t = setup({ handoff: s.handoff });
    expect((await t.handler(turn("quiero un asesor")))!.body).toBe(DRAFT_TEXTS.handoff_unavailable);
    expect(s.handoff.record).not.toHaveBeenCalled();
  });

  it("con sumidero operativo: primero se PERSISTE y solo entonces se confirma; la confirmación nunca se descarta por obsolescencia", async () => {
    const s = sink("ok");
    const t = setup({ handoff: s.handoff });
    const order: string[] = [];
    (s.handoff.record as ReturnType<typeof vi.fn>).mockImplementation(async (request: HandoffRequest) => { order.push("record"); s.requests.push(request); return "RECORDED"; });
    const reply = await t.handler(turn("quiero hablar con una persona"));
    order.push("reply");
    expect(order).toEqual(["record", "reply"]);
    expect(reply).toEqual({ body: DRAFT_TEXTS.handoff_confirmed, stale: "NONE" });
    expect(s.requests).toEqual([{ eventId: "handoff:wamid.t1", kapsoMessageId: "wamid.t1", contactPhone: "59170000000", reason: "HUMAN_REQUEST" }]);
    expect(t.logs).toEqual([["text_turn", { category: "HUMAN_REQUEST", handoff: "recorded" }]]);
  });

  it("el motivo de la derivación es un código: HUMAN_REQUEST, INFO_REQUEST o MEDICAL (y la solicitud no lleva el texto del paciente)", async () => {
    const s = sink("ok");
    const t = setup({ handoff: s.handoff });
    await t.handler(turn(`${SENTINEL} quiero un asesor`, { messageId: "a" }));
    await t.handler(turn(`${SENTINEL} horario de atención`, { messageId: "b" }));
    await t.handler(turn(`${SENTINEL} me duele`, { messageId: "c" }));
    expect(s.requests.map((r) => r.reason)).toEqual(["HUMAN_REQUEST", "INFO_REQUEST", "MEDICAL"]);
    expect(JSON.stringify(s.requests)).not.toContain(SENTINEL);
    expect(JSON.stringify(t.logs)).not.toContain(SENTINEL);
  });

  it("idempotente: un mensaje reprocesado (toma del lease) usa la misma clave y un duplicado también se confirma", async () => {
    const s = sink("duplicate");
    const t = setup({ handoff: s.handoff });
    const first = await t.handler(turn("quiero un asesor"));
    const again = await t.handler(turn("quiero un asesor"));
    expect(first!.body).toBe(DRAFT_TEXTS.handoff_confirmed);
    expect(again!.body).toBe(DRAFT_TEXTS.handoff_confirmed);
    expect(s.requests.map((r) => r.eventId)).toEqual(["handoff:wamid.t1", "handoff:wamid.t1"]);
  });

  it("FALLO DE PERSISTENCIA: no se confirma; se responde 'no disponible' (o el texto médico) sin el error y se registra solo el código", async () => {
    const s = sink("fail");
    const t = setup({ handoff: s.handoff });
    const human = await t.handler(turn("quiero un asesor"));
    const medical = await t.handler(turn("me duele el pecho"));
    expect(human).toEqual({ body: DRAFT_TEXTS.handoff_unavailable, stale: "NEWER_TURN" });
    expect(medical).toEqual({ body: DRAFT_TEXTS.medical_unavailable, stale: "NEWER_TURN" });
    expect(t.logs.map(([, data]) => data.handoff)).toEqual(["failed", "failed"]);
    expect(JSON.stringify([human, medical, t.logs])).not.toContain(SENTINEL);
  });

  it("los textos médicos no contienen ninguna orientación clínica, solo el aviso de que no se da y la referencia a emergencias", () => {
    expect(DRAFT_TEXTS.medical_unavailable).toMatch(/no puedo darte orientaci[oó]n m[eé]dica/i);
    expect(DRAFT_TEXTS.medical_unavailable).not.toMatch(/tom(a|e)r|medicament|dosis|diagn[oó]stic|normal|grave/i);
  });
});
