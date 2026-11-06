import { describe, expect, it } from "vitest";
import { emptyState, invariantViolations, pending, reduce, replayEvents, type ConversationEvent, type PatientItem } from "../scripts/g7/phase1/conversation-state.js";

// G7 · Fase 1 (prototipo). Eventos 100 % inventados.
const MIN = 60_000;
const item = (messageId: string, topic: string, goal: PatientItem["goal"] = "LAB_INFO"): PatientItem => ({ messageId, topic, goal });
const batch = (id: string, at: number, ...items: PatientItem[]): ConversationEvent => ({ id, type: "PATIENT_BATCH", at, items });

describe("g7 · fase 1 · preguntas y objetivos pendientes", () => {
  it("cada petición nace abierta y con objetivo; las tres preguntas de un lote quedan registradas (cobertura)", () => {
    const state = replayEvents([batch("b1", 0, item("m1", "HOURS"), item("m2", "PAYMENT"), item("m3", "PREPARATION"))]);
    expect(state.questions.map((q) => q.status)).toEqual(["OPEN", "OPEN", "OPEN"]);
    expect(state.goals).toHaveLength(1); // un solo objetivo LAB_INFO para las tres
    expect(invariantViolations(state)).toEqual([]);
  });

  it("una respuesta con contenido cierra lo abierto; un texto fijo genérico NO lo cierra (queda pospuesto con motivo)", () => {
    let state = replayEvents([batch("b1", 0, item("m1", "HOURS"))]);
    state = reduce(state, { id: "r1", type: "AGENT_REPLY", at: 5_000, quality: "GENERIC" });
    expect(state.questions[0]).toMatchObject({ status: "CARRIED", reason: "FIXED_REPLY_ONLY", attempts: 1 });
    expect(pending(state, 10 * MIN)).toHaveLength(1);
    state = reduce(state, batch("b2", MIN, item("m2", "ADDRESS")));
    state = reduce(state, { id: "r2", type: "AGENT_REPLY", at: 2 * MIN, quality: "ANSWER" });
    expect(state.questions.find((q) => q.id === "Q2")).toMatchObject({ status: "ANSWERED", closedBy: "AGENT" });
    // lo pospuesto por un texto fijo sobre OTRO tema sigue pendiente: contestar la dirección no atiende el horario
    expect(state.questions.find((q) => q.id === "Q1")?.status).toBe("CARRIED");
  });

  it("una respuesta con contenido SÍ atiende lo pospuesto del mismo tema, y una cotización lo pospuesto con objetivo de cotizar; la pausa humana no se toca", () => {
    let state = replayEvents([batch("b1", 0, item("m1", "HOURS")), { id: "r1", type: "AGENT_REPLY", at: 1_000, quality: "GENERIC" }]);
    state = reduce(state, batch("b2", MIN, item("m2", "HOURS")));
    state = reduce(state, { id: "r2", type: "AGENT_REPLY", at: 2 * MIN, quality: "ANSWER" });
    expect(state.questions.map((q) => q.status)).toEqual(["ANSWERED", "ANSWERED"]);
    expect(state.questions[0]).toMatchObject({ closedBy: "AGENT", closedAt: 2 * MIN });
    expect(state.questions[0]!.reason).toBeUndefined();

    let quote = replayEvents([batch("c1", 0, item("n1", "MEDIA_IMAGE", "QUOTE")), { id: "q1", type: "AGENT_REPLY", at: 1_000, quality: "UNRESOLVED" }]);
    quote = reduce(quote, batch("c2", MIN, item("n2", "RECIPE_OR_QUOTE", "QUOTE")));
    quote = reduce(quote, { id: "q2", type: "AGENT_REPLY", at: 2 * MIN, quality: "QUOTE" });
    expect(quote.questions.map((q) => q.status)).toEqual(["ANSWERED", "ANSWERED"]);

    let paused = replayEvents([{ id: "h0", type: "HUMAN_MESSAGE", at: 0 }, batch("d1", 1_000, item("p1", "HOURS"))]);
    paused = reduce(paused, { id: "h1", type: "HUMAN_RESUME", at: 2_000 });
    paused = reduce(paused, batch("d2", 3_000, item("p2", "HOURS")));
    paused = reduce(paused, { id: "p-r", type: "AGENT_REPLY", at: 4_000, quality: "ANSWER" });
    expect(paused.questions.map((q) => q.status)).toEqual(["ANSWERED", "ANSWERED"]);
    // lo que sigue en pausa humana (la persona tiene la palabra) no lo cierra una respuesta del agente
    let held = replayEvents([{ id: "h2", type: "HUMAN_MESSAGE", at: 0 }, batch("e1", 1_000, item("s1", "HOURS"))]);
    held = reduce(held, { id: "e-r", type: "AGENT_REPLY", at: 2_000, quality: "ANSWER" });
    expect(held.questions[0]).toMatchObject({ status: "CARRIED", reason: "HUMAN_PAUSED" });
    expect(invariantViolations(state)).toEqual([]);
    expect(invariantViolations(quote)).toEqual([]);
  });

  it("«no puedo derivar» deja la pregunta pospuesta por HANDOFF_UNAVAILABLE (visible, no perdida)", () => {
    const state = replayEvents([batch("b1", 0, item("m1", "HUMAN", "HUMAN_ATTENTION")), { id: "r1", type: "AGENT_REPLY", at: 1000, quality: "BLOCKED" }]);
    expect(state.questions[0]).toMatchObject({ status: "CARRIED", reason: "HANDOFF_UNAVAILABLE" });
    expect(pending(state, 20 * MIN, 15 * MIN)).toHaveLength(1);
  });

  it("durante la pausa humana los mensajes del paciente quedan en espera explícita y se reabren al reanudar (manual)", () => {
    let state = replayEvents([
      batch("b1", 0, item("m1", "HOURS")),
      { id: "h1", type: "HUMAN_MESSAGE", at: MIN },
      batch("b2", 5 * MIN, item("m2", "SAMPLE"))
    ]);
    expect(state.holder).toBe("HUMAN");
    expect(state.questions[0]).toMatchObject({ status: "ANSWERED", closedBy: "STAFF" });
    expect(state.questions[1]).toMatchObject({ status: "CARRIED", reason: "HUMAN_PAUSED" });
    // la recepción ve lo pendiente aunque el agente no hable
    expect(pending(state, 30 * MIN, 15 * MIN).map((q) => q.topic)).toEqual(["SAMPLE"]);
    state = reduce(state, { id: "u1", type: "HUMAN_RESUME", at: 40 * MIN });
    expect(state.holder).toBe("AGENT");
    expect(state.questions[1]).toMatchObject({ status: "OPEN" });
    expect(state.questions[1]!.reason).toBeUndefined();
  });

  it("un objetivo persiste entre lotes y se cumple cuando se cierran todas sus preguntas", () => {
    let state = replayEvents([batch("b1", 0, item("m1", "QUOTE", "QUOTE"))]);
    state = reduce(state, batch("b2", 3 * MIN, item("m2", "QUOTE_STUDIES", "QUOTE")));
    expect(state.goals.filter((g) => g.kind === "QUOTE")).toHaveLength(1);
    state = reduce(state, { id: "r1", type: "AGENT_REPLY", at: 4 * MIN, quality: "QUOTE" });
    expect(state.goals[0]!.status).toBe("FULFILLED");
  });

  it("un objetivo sin actividad por más de 24 h caduca; el siguiente mensaje abre uno nuevo", () => {
    let state = replayEvents([batch("b1", 0, item("m1", "QUOTE", "QUOTE"))]);
    state = reduce(state, batch("b2", 25 * 3600_000, item("m2", "QUOTE", "QUOTE")));
    expect(state.goals.filter((g) => g.kind === "QUOTE")).toHaveLength(2);
    expect(state.goals[0]!.status).toBe("EXPIRED");
  });

  it("es idempotente: aplicar dos veces el mismo evento no cambia nada (reintentos de Kapso)", () => {
    const event = batch("b1", 0, item("m1", "HOURS"));
    const once = reduce(emptyState(), event);
    const twice = reduce(once, event);
    expect(twice).toBe(once);
    expect(twice.questions).toHaveLength(1);
  });

  it("es puro: no muta el estado anterior", () => {
    const before = replayEvents([batch("b1", 0, item("m1", "HOURS"))]);
    const snapshot = JSON.stringify(before);
    reduce(before, { id: "h1", type: "HUMAN_MESSAGE", at: 1000 });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("los artefactos guardan solo ids y cantidades, nunca precios", () => {
    const state = replayEvents([{ id: "a1", type: "ARTIFACT", at: 0, artifact: { id: "R1", kind: "RECIPE", studyIds: ["id-1", "id-2"], unrecognized: 1 } }, { id: "a2", type: "ARTIFACT", at: 1, artifact: { id: "QT1", kind: "QUOTE", studyIds: ["id-1"], unrecognized: 0 } }]);
    expect(state.artifacts.map((a) => a.kind)).toEqual(["RECIPE", "QUOTE"]);
    expect(JSON.stringify(state)).not.toMatch(/price|total|Bs/i);
    expect(invariantViolations(state)).toEqual([]);
  });

  it("propiedad: ninguna secuencia aleatoria de eventos rompe los invariantes ni pierde preguntas", () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let run = 0; run < 200; run++) {
      let state = emptyState();
      let at = 0;
      let opened = 0;
      for (let step = 0; step < 25; step++) {
        at += Math.floor(random() * 10 * MIN);
        const roll = random();
        const id = `e${run}-${step}`;
        let event: ConversationEvent;
        if (roll < 0.4) { const n = 1 + Math.floor(random() * 3); opened += n; event = batch(id, at, ...Array.from({ length: n }, (_, k) => item(`${id}-${k}`, "T", (["QUOTE", "LAB_INFO", "OTHER"] as const)[Math.floor(random() * 3)]!))); }
        else if (roll < 0.7) event = { id, type: "AGENT_REPLY", at, quality: (["ANSWER", "QUOTE", "GENERIC", "BLOCKED"] as const)[Math.floor(random() * 4)]! };
        else if (roll < 0.85) event = { id, type: "HUMAN_MESSAGE", at };
        else event = { id, type: "HUMAN_RESUME", at };
        state = reduce(state, event);
        expect(invariantViolations(state), `${run}/${step}`).toEqual([]);
      }
      // Nada se pierde: toda pregunta abierta está en algún estado conocido y el total coincide con lo recibido
      expect(state.questions).toHaveLength(opened);
    }
  });
});

describe("g7 · fase 4 · la respuesta declara lo que atendió", () => {
  it("closes: una respuesta que atiende una petición PENDIENTE de otro tema la cierra por id; con DEFER del resto sigue visible lo demás; lo de la pausa humana no se toca", () => {
    let state = replayEvents([batch("b1", 0, item("m1", "RECIPE_OR_QUOTE", "QUOTE")), { id: "r1", type: "AGENT_REPLY", at: 1_000, quality: "GENERIC" }]);
    expect(state.questions[0]).toMatchObject({ status: "CARRIED", reason: "FIXED_REPLY_ONLY" });
    state = reduce(state, batch("b2", 2_000, item("m2", "GREETING", "OTHER"), item("m3", "INFO_REQUEST")));
    // la respuesta atendió el saludo y la petición pendiente (m1), pero aplazó lo de información (calidad sin resolver)
    state = reduce(state, { id: "r2", type: "AGENT_REPLY", at: 3_000, quality: "UNRESOLVED", closes: ["m1"] });
    expect(state.questions.map((q) => `${q.messageId}:${q.status}`)).toEqual(["m1:ANSWERED", "m2:CARRIED", "m3:CARRIED"]);
    expect(state.questions[0]).toMatchObject({ closedBy: "AGENT", closedAt: 3_000 });
    expect(invariantViolations(state)).toEqual([]);
    const held = replayEvents([{ id: "h", type: "HUMAN_MESSAGE", at: 0 }, batch("c1", 1_000, item("p1", "INFO_REQUEST"))]);
    const after = reduce(held, { id: "r", type: "AGENT_REPLY", at: 2_000, quality: "ANSWER", closes: ["p1"] });
    expect(after.questions[0]).toMatchObject({ status: "CARRIED", reason: "HUMAN_PAUSED" });
  });

  it("upto: lo que llegó MIENTRAS se respondía (aunque la respuesta se fechara después) no se da por atendido", () => {
    let state = replayEvents([batch("b1", 1_000, item("m1", "INFO_REQUEST")), batch("b2", 1_500, item("m2", "RECIPE_OR_QUOTE", "QUOTE"))]);
    state = reduce(state, { id: "r1", type: "AGENT_REPLY", at: 2_000, quality: "ANSWER", upto: 1_000 });
    expect(state.questions.map((q) => `${q.messageId}:${q.status}`)).toEqual(["m1:ANSWERED", "m2:OPEN"]);
    // sin `upto` (respuestas anteriores a este cambio) todo lo anterior a la respuesta se da por atendido, como siempre
    const legacy = reduce(replayEvents([batch("b1", 1_000, item("m1", "INFO_REQUEST")), batch("b2", 1_500, item("m2", "RECIPE_OR_QUOTE", "QUOTE"))]), { id: "r1", type: "AGENT_REPLY", at: 2_000, quality: "ANSWER" });
    expect(legacy.questions.map((q) => q.status)).toEqual(["ANSWERED", "ANSWERED"]);
  });
});
