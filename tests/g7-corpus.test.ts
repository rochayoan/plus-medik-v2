import { describe, expect, it } from "vitest";
import { baseline, buildFixture, fixedTextsIn, readRaw, toBatches, verify } from "../scripts/g7/lib/corpus.js";
import { createPseudonymizer, residualNameCandidates } from "../scripts/g7/lib/pseudonymize.js";
import { FixtureConversation, Scenario } from "../scripts/g7/lib/schema.js";
import { DRAFT_TEXTS } from "../src/text-handler.js";
import { SCENARIOS } from "./support/g7-scenarios.js";

// G7 · Fase 0. Datos 100 % inventados: nada de aquí proviene de un paciente real.

describe("g7 · seudonimización", () => {
  const text = (input: string) => createPseudonymizer().text(input);

  it("oculta teléfonos, correos, enlaces, identificadores de WhatsApp, documentos y fechas", () => {
    const out = text("Mi cel es 71234567 o +591 71234567, escribo a ana.perez@correo.com, mira https://ejemplo.com/x wamid.HBgLNTkxNzEyMzQ1NjcVAgASGBQzQTZD, CI: 1234567 LP, nací 12/03/1985");
    expect(out).not.toMatch(/71234567|ana\.perez|ejemplo\.com|HBgL|1234567|1985/);
    expect(out).toContain("[TELEFONO]");
    expect(out).toContain("[CORREO]");
    expect(out).toContain("[ENLACE]");
    expect(out).toContain("[ID_MENSAJE]");
    expect(out).toContain("[DOCUMENTO]");
    expect(out).toContain("[FECHA]");
  });

  it("oculta nombres tras un disparador pero conserva estudios y vocabulario del dominio", () => {
    expect(text("Hola, me llamo María Fernanda Rojas y quiero cotizar hemograma")).toBe("Hola, me llamo [NOMBRE] y quiero cotizar hemograma");
    expect(text("Soy Hemograma Completo")).toContain("Hemograma Completo"); // «Hemograma» es vocabulario: no se trata como nombre
    expect(text("a nombre de Juan Carlos Pérez")).toBe("a nombre de [NOMBRE]");
  });

  it("conserva el contenido clínico y las cantidades pequeñas (necesario para evaluar comprensión)", () => {
    const original = "Tengo fiebre hace 3 días, necesito 2 estudios: glucosa y TSH, ¿atienden el sábado a las 8:30?";
    expect(text(original)).toBe(original);
  });

  it("los seudónimos son estables por contacto y no se derivan del dato", () => {
    const pseudo = createPseudonymizer();
    expect(pseudo.contact("key-a")).toBe("C001");
    expect(pseudo.contact("key-b")).toBe("C002");
    expect(pseudo.contact("key-a")).toBe("C001");
    expect(pseudo.phone("+591 71234567")).toBe("P001");
    expect(pseudo.phone("59171234567")).toBe("P001");
    expect(JSON.stringify(pseudo.equivalences())).toContain("59171234567");
  });

  it("señala nombres residuales que la heurística no pudo cubrir", () => {
    expect(residualNameCandidates("Buenas, mi hija Valentina necesita un examen")).toEqual(["Valentina"]);
    expect(residualNameCandidates("Buenas, necesito un Hemograma")).toEqual([]);
  });
});

const raw = (over: Record<string, unknown>) => ({ seq: 1, at: "2026-11-04T14:00:00.000Z", contactKey: "k1", contactPhone: "59171234567", messageId: "id-1", direction: "IN", actor: "PATIENT", origin: null, kind: "TEXT", messageType: "text", mediaRef: null, state: "RECEIVED", deliveryAt: null, auditRunId: null, replyTo: null, textStatus: "OK", text: "hola", ...over });
const jsonl = (rows: Array<Record<string, unknown>>) => rows.map((row) => JSON.stringify(raw(row))).join("\n");

describe("g7 · verificación y lotes", () => {
  const rows = [
    { seq: 1, at: "2026-11-04T14:00:00.000Z", messageId: "a", text: "Hola, quiero cotizar" },
    { seq: 2, at: "2026-11-04T14:00:05.000Z", messageId: "b", text: "hemograma y glucosa, mi correo x@y.com" },
    { seq: 3, at: "2026-11-04T14:00:20.000Z", messageId: "c", direction: "OUT", actor: "AGENT", state: "ACCEPTED", replyTo: "b", text: DRAFT_TEXTS.send_recipe },
    { seq: 4, at: "2026-11-04T14:05:00.000Z", messageId: "d", direction: "OUT", actor: "HUMAN", state: "SENT", text: "Le atiende una persona del equipo" },
    { seq: 5, at: "2026-11-04T14:06:00.000Z", messageId: "e", text: "gracias" },
    { seq: 6, at: "2026-11-04T14:00:01.000Z", messageId: "z", contactKey: "k2", contactPhone: "59179999999", text: "buenas", replyTo: "no-existe" }
  ];

  it("lee JSONL, cuenta y detecta anomalías sin mostrar texto", () => {
    const read = readRaw(`${jsonl(rows)}\nnoesjson`);
    const report = verify(read, 6);
    expect(report.total).toBe(6);
    expect(report.invalidRecords).toBe(1);
    expect(report.matchesExpectedTotal).toBe(true);
    expect(report.contacts).toBe(2);
    expect(report.replyToOrphans).toBe(1);
    expect(report.byActor).toEqual({ AGENT: 1, HUMAN: 1, PATIENT: 4 });
    expect(JSON.stringify(report)).not.toMatch(/cotizar|hemograma|59171234567/);
  });

  it("lee el CSV del exportador, con comillas y saltos de línea en el texto", () => {
    const csv = ["seq,at,direction,actor,origin,kind,messageType,state,deliveryAt,contactPhone,contactKey,messageId,replyTo,auditRunId,mediaRef,textStatus,text", '1,2026-11-04T14:00:00.000Z,IN,PATIENT,,TEXT,text,RECEIVED,,59171234567,k1,a,,,,OK,"hola, ""amigo""\nsegunda línea"'].join("\n");
    const read = readRaw(csv);
    expect(read.format).toBe("csv");
    expect(read.messages).toHaveLength(1);
    expect(read.messages[0]!.text).toBe('hola, "amigo"\nsegunda línea');
  });

  it("lee las filas de la tabla del historial (occurred_at, provider_message_id, body, delivery_state…)", () => {
    const sql = [
      { seq: 1, occurred_at: "2026-11-04T14:00:00.000Z", contact_phone: "59171234567", contact_key: "k1", direction: "IN", actor: "PATIENT", origin: "cloud_api", message_type: "text", body: "hola", delivery_state: "RECEIVED", provider_message_id: "p1" },
      { seq: 2, occurred_at: "2026-11-04T14:00:03.000Z", contact_phone: null, contact_key: "k1", direction: "IN", actor: "PATIENT", origin: "cloud_api", message_type: "image", body: null, delivery_state: "RECEIVED", provider_message_id: "p2" },
      { seq: 3, occurred_at: "2026-11-04T14:00:04.000Z", contact_phone: null, contact_key: "k1", direction: "IN", actor: "PATIENT", origin: "cloud_api", message_type: "document", body: null, delivery_state: "RECEIVED", provider_message_id: "p3" },
      { seq: 4, occurred_at: "2026-11-04T14:03:00.000Z", contact_phone: null, contact_key: "k1", direction: "OUT", actor: "HUMAN", origin: "business_app", message_type: "text", body: "ya le atendemos", delivery_state: "SENT", provider_message_id: "p4" }
    ].map((row) => JSON.stringify(row)).join("\n");
    const read = readRaw(sql);
    expect(read.format).toBe("sql-rows");
    expect(read.invalid).toBe(0);
    expect(read.messages.map((message) => message.kind)).toEqual(["TEXT", "IMAGE", "OTHER", "TEXT"]);
    expect(read.messages.map((message) => message.textStatus)).toEqual(["OK", "NONE", "NONE", "OK"]);
    expect(verify(read, 4).byKind).toEqual({ "IN:document": 1, "IN:image": 1, "IN:text": 1, "OUT:text": 1 });
    const built = buildFixture(read.messages);
    expect(built.conversations[0]!.batches.map((batch) => batch.messages.length)).toEqual([3, 1]);
    expect(built.conversations[0]!.batches[0]!.messages[2]!.messageType).toBe("document");
  });

  it("agrupa en lotes de 15 s del paciente y deja los demás actores como lotes sueltos", () => {
    const built = buildFixture(readRaw(jsonl(rows)).messages);
    const k1 = built.conversations.find((conversation) => conversation.id === "C001")!;
    expect(k1.batches.map((batch) => batch.messages.length)).toEqual([2, 1, 1, 1]);
    expect(built.conversations.map((conversation) => conversation.id)).toEqual(["C001", "C002"]);
    expect(() => FixtureConversation.parse(k1)).not.toThrow();
    const dump = JSON.stringify(built.conversations);
    expect(dump).not.toMatch(/x@y\.com|59171234567|k1/);
    expect(dump).toContain("[CORREO]");
  });

  it("no agrupa mensajes del paciente separados por más de 15 s ni por otro actor", () => {
    const batches = toBatches("C9", [
      { id: "M1", at: "2026-11-04T14:00:00.000Z", actor: "PATIENT", kind: "TEXT", state: "RECEIVED", replyTo: null, hasAuditRun: false, messageType: null, origin: null, text: "a" },
      { id: "M2", at: "2026-11-04T14:00:20.000Z", actor: "PATIENT", kind: "TEXT", state: "RECEIVED", replyTo: null, hasAuditRun: false, messageType: null, origin: null, text: "b" }
    ]);
    expect(batches).toHaveLength(2);
  });
});

describe("g7 · línea base", () => {
  it("reconoce los textos fijos (también dentro de un mensaje combinado) y mide lo que se puede medir sin etiquetas", () => {
    expect(fixedTextsIn(DRAFT_TEXTS.greeting)).toEqual(["DRAFT:greeting"]);
    expect(fixedTextsIn(`${DRAFT_TEXTS.send_recipe}\n\n${DRAFT_TEXTS.handoff_unavailable}`).sort()).toEqual(["DRAFT:handoff_unavailable", "DRAFT:send_recipe"]);
    expect(fixedTextsIn("Respuesta libre del agente")).toEqual([]);

    const rows = [
      { seq: 1, at: "2026-11-04T14:00:00.000Z", messageId: "a", text: "¿atienden los domingos? ¿dónde queda?" },
      { seq: 2, at: "2026-11-04T14:00:09.000Z", messageId: "b", direction: "OUT", actor: "AGENT", state: "ACCEPTED", text: DRAFT_TEXTS.fallback },
      { seq: 3, at: "2026-11-04T14:01:00.000Z", messageId: "c", text: "¿atienden los domingos? ¿dónde queda?" },
      { seq: 4, at: "2026-11-04T14:02:00.000Z", messageId: "d", direction: "OUT", actor: "AGENT", state: "ACCEPTED", text: DRAFT_TEXTS.handoff_unavailable },
      { seq: 5, at: "2026-11-04T14:30:00.000Z", messageId: "e", text: "muchas gracias" },
      { seq: 6, at: "2026-11-04T15:30:00.000Z", messageId: "f", text: "necesito hablar con alguien" }
    ];
    const report = baseline(buildFixture(readRaw(jsonl(rows)).messages).conversations);
    expect(report.agentReplies).toBe(2);
    expect(report.agentReplyShare).toEqual({ generic: 1, blockedHandoff: 1, otherFixed: 0, free: 0 });
    expect(report.multiQuestion.patientMessagesWithTwoPlusQuestions).toBe(2);
    expect(report.multiQuestion.batchesWithTwoPlusQuestionsAndOneAgentReply).toBe(2);
    expect(report.reAsks.patientRepeatsAfterAgentReply).toBeGreaterThanOrEqual(1);
    expect(report.unansweredPatientBatches).toEqual({ total: 2, socialOnly: 1, followedByHuman: 0, other: 1 });
    expect(report.latencySeconds.samples).toBe(2);
  });
});

describe("g7 · escenarios sintéticos", () => {
  it("todos cumplen el esquema, tienen ids únicos y cubren cada capacidad", () => {
    const ids = SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of SCENARIOS) expect(() => Scenario.parse(scenario)).not.toThrow();
    const capabilities = new Set(SCENARIOS.flatMap((scenario) => scenario.capabilities));
    for (const needed of ["MEMORY", "MULTI_QUESTION", "RECIPE_RECALL", "COREFERENCE", "HUMAN_RESUME", "PENDING_QUESTION", "OPS_QUERY", "MEDICAL_SAFETY", "HUMAN_REQUEST", "QUOTE_FLOW", "GOAL_PERSISTENCE", "ADVERSARIAL"]) expect(capabilities.has(needed as never)).toBe(true);
  });

  it("los enunciados exigidos por cada expectativa existen en el mensaje del lote o en uno anterior", () => {
    for (const scenario of SCENARIOS) {
      const known = new Set<string>();
      for (const turn of scenario.turns) {
        for (const message of turn.batch) for (const utterance of message.utterances ?? []) known.add(utterance.id);
        for (const id of turn.expect.mustCover) expect(known.has(id), `${scenario.id}: ${id}`).toBe(true);
        for (const pattern of turn.expect.mustNotMatch) expect(() => new RegExp(pattern, "i"), `${scenario.id}: ${pattern}`).not.toThrow();
      }
    }
  });
});
