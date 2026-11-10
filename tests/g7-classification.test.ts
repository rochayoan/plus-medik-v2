import { describe, expect, it } from "vitest";
import { classifyBatches, type Telemetry } from "../scripts/g7/lib/batch-classification.js";
import { toBatches } from "../scripts/g7/lib/corpus.js";
import type { FixtureConversation, FixtureMessage } from "../scripts/g7/lib/schema.js";
import { DRAFT_TEXTS } from "../src/text-handler.js";

// G7 · clasificación de lotes. Datos inventados.
let n = 0;
const msg = (at: string, actor: FixtureMessage["actor"], text: string | null, messageType = "text"): FixtureMessage => ({ id: `M${++n}`, at, actor, kind: messageType === "image" ? "IMAGE" : messageType === "audio" ? "AUDIO" : messageType === "text" ? "TEXT" : "OTHER", state: "RECEIVED", replyTo: null, hasAuditRun: false, messageType, origin: null, text });
const conversation = (id: string, messages: FixtureMessage[]): FixtureConversation => ({ id, messageCount: messages.length, batches: toBatches(id, messages) });
const none: Telemetry = { events: [] };
const label = (conversations: FixtureConversation[], telemetry: Telemetry = none) => classifyBatches(conversations, telemetry).labels;

describe("g7 · clasificación de lotes", () => {
  it("un saludo o agradecimiento sin respuesta es silencio correcto, no un fallo", () => {
    const [l] = label([conversation("C1", [msg("2026-11-04T14:00:00Z", "PATIENT", "muchas gracias")])]);
    expect(l).toMatchObject({ family: "SILENCIO_CORRECTO", detail: "SOCIAL_SIN_ACCION" });
  });

  it("tras un mensaje humano, el silencio del agente es correcto si una persona atiende (incluso con un mensaje posterior del paciente)", () => {
    const labels = label([conversation("C2", [
      msg("2026-11-04T14:00:00Z", "HUMAN", "Buenas, le escribimos de la recepción"),
      msg("2026-11-04T14:01:00Z", "PATIENT", "¿a qué hora atienden?"),
      msg("2026-11-04T14:01:40Z", "PATIENT", "y los domingos?"),
      msg("2026-11-04T14:03:00Z", "HUMAN", "de 8 a 12")
    ])]);
    expect(labels.map((l) => l.family)).toEqual(["ATENCION_HUMANA_CORRECTA", "ATENCION_HUMANA_CORRECTA"]);
  });

  it("bajo pausa humana y sin que nadie responda es una falta real cuyo responsable es el proceso de recepción, no el agente", () => {
    const [l] = label([conversation("C3", [msg("2026-11-04T14:00:00Z", "HUMAN", "Hola"), msg("2026-11-04T14:05:00Z", "PATIENT", "necesito saber el precio?")])]);
    expect(l).toMatchObject({ family: "FALTA_REAL_DE_RESPUESTA", detail: "PAUSA_HUMANA_SIN_ATENCION_DE_NADIE", owner: "RECEPCION_PROCESO" });
  });

  it("una respuesta fija justo después de un 429 es error técnico del proveedor, no un fallo del agente", () => {
    const labels = label([conversation("C4", [msg("2026-11-04T14:00:00Z", "PATIENT", "Hola, buenas tardes"), msg("2026-11-04T14:00:20Z", "AGENT", DRAFT_TEXTS.greeting)])], { events: [{ t: "2026-11-04T14:00:15Z", kind: "LLM_429" }] });
    expect(labels[0]).toMatchObject({ family: "ERROR_TECNICO", owner: "PROVEEDOR_IA" });
  });

  it("«no puedo derivar» ante una pregunta es una respuesta insuficiente de diseño (derivación desactivada)", () => {
    const [l] = label([conversation("C5", [msg("2026-11-04T14:00:00Z", "PATIENT", "¿me pueden dar el resultado de mi examen?"), msg("2026-11-04T14:00:20Z", "AGENT", DRAFT_TEXTS.handoff_unavailable)])]);
    expect(l).toMatchObject({ family: "RESPUESTA_INSUFICIENTE", owner: "DISENO_PROTECCION" });
  });

  it("una retención por tope (reply_withheld limited) sin respuesta es falta real atribuida a la protección; el rechazo de auditoría es error técnico de la base", () => {
    const base = [msg("2026-11-04T14:00:00Z", "PATIENT", "cotizame un hemograma por favor")];
    expect(label([conversation("C6", base)], { events: [{ t: "2026-11-04T14:00:40Z", kind: "WITHHELD_LIMITED" }] })[0]).toMatchObject({ family: "FALTA_REAL_DE_RESPUESTA", owner: "DISENO_PROTECCION" });
    expect(label([conversation("C7", base)], { events: [{ t: "2026-11-04T14:00:40Z", kind: "WITHHELD_AUDIT_CLAIM_REJECTED" }] })[0]).toMatchObject({ family: "ERROR_TECNICO", owner: "BASE_AUDITORIA" });
    expect(label([conversation("C8", base)], { events: [{ t: "2026-11-04T14:00:40Z", kind: "WITHHELD_BLOCKED" }] })[0]).toMatchObject({ family: "ATENCION_HUMANA_CORRECTA" });
  });

  it("un documento sin manejador es una falta real del agente; una reacción es silencio correcto", () => {
    expect(label([conversation("C9", [msg("2026-11-04T14:00:00Z", "PATIENT", null, "document")])])[0]).toMatchObject({ family: "FALTA_REAL_DE_RESPUESTA", detail: expect.stringContaining("TIPO_DE_MENSAJE_SIN_MANEJADOR") });
    expect(label([conversation("C10", [msg("2026-11-04T14:00:00Z", "PATIENT", null, "reaction")])])[0]).toMatchObject({ family: "SILENCIO_CORRECTO" });
  });

  it("una foto cuyo análisis falló por el proveedor y recibió el aviso técnico es error técnico del proveedor", () => {
    const labels = label([conversation("C11", [msg("2026-11-04T14:00:00Z", "PATIENT", null, "image"), msg("2026-11-04T14:00:06Z", "AGENT", "Tuvimos un inconveniente al revisar tu receta")])], { events: [{ t: "2026-11-04T14:00:05Z", kind: "PHOTO_FAILED" }] });
    expect(labels[0]).toMatchObject({ family: "ERROR_TECNICO", detail: "FOTO_NO_PROCESADA_FALLO_IA" });
  });

  it("el total siempre cuadra: cada lote del paciente recibe exactamente una etiqueta", () => {
    const conversations = [conversation("C12", [msg("2026-11-04T14:00:00Z", "PATIENT", "hola"), msg("2026-11-04T14:10:00Z", "PATIENT", "quiero cotizar"), msg("2026-11-04T14:30:00Z", "PATIENT", "gracias")])];
    expect(label(conversations)).toHaveLength(3);
  });
});
