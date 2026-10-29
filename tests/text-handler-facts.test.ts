import { describe, expect, it, vi } from "vitest";
import { KnowledgeService } from "../src/knowledge/index.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { StudyFactsService, type StudyFactsStore } from "../src/study-facts/index.js";
import { createTextHandler, DRAFT_TEXTS } from "../src/text-handler.js";
import type { IncomingTurn, TurnHandlerContext } from "../src/turns.js";
import type { CatalogStudy } from "../src/types.js";
import { iso, MemoryStore, T0 } from "./support/knowledge-fixtures.js";

// El manejador de texto con los datos por estudio (G4.1): qué mensajes consultan los datos, cuáles NO (precio, médico, personas), el contexto de la última cotización, la firma y el rastro.
// Fixtures de PRUEBA, sin base de datos.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const study = (n: number, name: string, aliases: string[]): CatalogStudy => ({ id: id(n), code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs: 99, active: true });
const CATALOG = [study(1, "HEMOGRAMA DE PRUEBA", ["hemograma"]), study(2, "GLUCOSA DE PRUEBA", ["glucosa"])];
const fact = (n: number, payload: Record<string, unknown>) => ({
  kind: "TURNAROUND", labTestId: id(n), classification: "ADMINISTRATIVE", version: 3, versionId: `f-${n}`, payload: { labTestId: id(n), ...payload },
  validFrom: iso(-30), validUntil: iso(60), approvedAt: iso(-30), approvedBy: "crm:approver-prueba", contentHash: "c".repeat(64)
});
const FACTS = [fact(1, { unit: "HOURS", max: 24, countedFrom: "SAMPLE_COLLECTION" })];
const factsStore: StudyFactsStore = { revision: async () => 1, snapshot: async () => ({ revision: 1, items: structuredClone(FACTS) }) };

function make(options: { withFacts?: boolean; loopProtection?: boolean } = {}) {
  const log = vi.fn();
  const knowledge = new KnowledgeService({ store: new MemoryStore({ revision: 1, items: [] }), now: () => T0 });
  const studyFacts = new StudyFactsService({ store: factsStore, now: () => T0 });
  const handler = createTextHandler({
    log, ...(options.loopProtection ? { loopProtection: true } : {}),
    knowledge: { service: knowledge, loadCatalog: async () => CATALOG, now: () => T0, ...(options.withFacts === false ? {} : { studyFacts }) }
  });
  const context = (ids: string[]): TurnHandlerContext & { calls: number } => {
    const ctx = { calls: 0, async quotedStudyIds() { ctx.calls++; return ids; } };
    return ctx;
  };
  return { handler, log, context };
}
const turn = (text: string): IncomingTurn => ({ messageId: "wamid.1", from: "59170000000", kind: "TEXT", text });

describe("manejador de texto con datos por estudio", () => {
  it("responde con el dato aprobado, lo marca como respuesta informativa (no se descarta) y entrega los rastros a registrar ANTES de enviar", async () => {
    const { handler } = make();
    const reply = (await handler(turn("¿cuánto demora el hemograma?")))!;
    expect(reply.body).toBe("*HEMOGRAMA DE PRUEBA*\nTiempo de entrega: hasta 24 horas (contado desde la toma de la muestra)");
    expect(reply.stale).toBe("NONE");
    expect(reply.knowledge!.refs).toEqual([{ kind: "TURNAROUND", key: id(1), version: 3, contentHash: "c".repeat(64) }]);
  });

  it("si los rastros no se pueden registrar, lo que corresponde sin datos es la respuesta de siempre (derivación bloqueada), nunca el dato", async () => {
    const { handler } = make();
    const reply = (await handler(turn("¿cuánto demora el hemograma?")))!;
    const fallback = (await reply.knowledge!.fallback())!;
    expect(fallback.body).toBe(DRAFT_TEXTS.fallback);
    expect(fallback.body).not.toContain("24");
  });

  it("sin dato aprobado para el estudio: lo dice claramente (sin inventar) y NO ofrece derivar a una persona (la derivación sigue bloqueada)", async () => {
    const { handler } = make();
    const reply = (await handler(turn("¿cuánto demora la glucosa?")))!;
    expect(reply.body).toBe("No tengo el tiempo de entrega de GLUCOSA DE PRUEBA disponible por ahora.");
    expect(reply.knowledge).toBeUndefined();
    expect(reply.body).not.toMatch(/persona|equipo|asesor/i);
  });

  it("sin el servicio de datos por estudio: la respuesta de siempre; el contexto de la cotización ni se consulta", async () => {
    const { handler, context } = make({ withFacts: false });
    const ctx = context([id(1)]);
    const reply = (await handler(turn("¿para cuándo estarían?"), ctx))!;
    expect(reply.body).toBe(DRAFT_TEXTS.fallback);
    expect(ctx.calls).toBe(0);
  });

  it("usa la última cotización solo cuando hace falta (no nombra el estudio) y no cuando lo nombra", async () => {
    const { handler, context } = make();
    const ctx = context([id(1)]);
    const sinNombre = (await handler(turn("¿y para cuándo estarían?"), ctx))!;
    expect(sinNombre.body).toContain("Sobre los estudios de tu última cotización:");
    expect(sinNombre.body).toContain("hasta 24 horas");
    expect(ctx.calls).toBe(1);
    await handler(turn("¿cuánto demora el hemograma?"), ctx);
    await handler(turn("hola"), ctx);
    await handler(turn("¿a qué hora abren?"), ctx);
    expect(ctx.calls).toBe(1);
  });

  it("sin contexto (llamado sin él) pide el estudio; con una cotización que ya no existe en el catálogo también", async () => {
    const { handler, context } = make();
    expect((await handler(turn("¿y para cuándo estarían?")))!.body).toContain("necesito el nombre del estudio");
    expect((await handler(turn("¿y para cuándo estarían?"), context([id(99)])))!.body).toContain("necesito el nombre del estudio");
  });

  it("un mensaje que menciona el PRECIO sigue el camino de cotización aunque pregunte también por el plazo (el precio solo sale al cerrar la solicitud)", async () => {
    const { handler } = make();
    for (const text of ["¿cuánto cuesta el examen de hemograma y cuánto demora?", "precio y plazo de entrega del estudio de glucosa", "cotizar estudios y tiempo de entrega"]) {
      const reply = (await handler(turn(text)))!;
      expect(reply.body, text).toBe(DRAFT_TEXTS.send_recipe);
      expect(reply.knowledge).toBeUndefined();
    }
  });

  it("una pregunta de plazo o muestra clasificada como pedido de estudios («examen», «estudio») sin precio SÍ se responde con los datos", async () => {
    const { handler } = make();
    expect((await handler(turn("¿cuánto demora el examen de hemograma?")))!.body).toContain("hasta 24 horas");
    expect((await handler(turn("¿para cuándo está el estudio de hemograma?")))!.body).toContain("hasta 24 horas");
  });

  it("lo médico y pedir a una persona NUNCA consultan los datos, aunque mencionen el plazo", async () => {
    const { handler, context } = make();
    const ctx = context([id(1)]);
    const medical = (await handler(turn("tengo mucho dolor, ¿cuánto demora el hemograma?"), ctx))!;
    expect(medical.body).toBe(DRAFT_TEXTS.medical_unavailable);
    const human = (await handler(turn("quiero hablar con una persona, ¿cuánto demora el hemograma?"), ctx))!;
    expect(human.body).toBe(DRAFT_TEXTS.handoff_unavailable);
    expect(ctx.calls).toBe(0);
  });

  it("con la protección antibucles: la firma lleva la categoría y los temas (códigos), nunca texto del paciente, y es la MISMA ante la misma consulta (así la base detecta que se repite)", async () => {
    const { handler } = make({ loopProtection: true });
    const reply = (await handler(turn("¿cuánto demora el hemograma? TEXTO_SENTINELA_1")))!;
    expect(reply.signature).toBe("OTHER:TURNAROUND");
    expect(JSON.stringify(reply.signature)).not.toContain("SENTINELA");
    expect((await handler(turn("cuánto demora el hemograma")))!.signature).toBe(reply.signature);
    // límite conocido: el eco de un dato (no de una plantilla fija) lo corta la detección de repeticiones de la base, no el reconocimiento de textos propios
  });

  it("jamás aparece el precio del catálogo (99) en estas respuestas", async () => {
    const { handler, context } = make();
    for (const text of ["¿cuánto demora el hemograma?", "¿para cuándo estarían?", "qué muestra necesito para la glucosa"]) {
      const reply = (await handler(turn(text), context([id(1)])))!;
      expect(reply.body, text).not.toMatch(/\b99\b|Bs/);
    }
  });

  it("los registros del manejador llevan categorías, temas y versiones, nunca el texto ni los nombres de los estudios", async () => {
    const { handler, log } = make();
    await handler(turn("¿cuánto demora el hemograma? TEXTO_SENTINELA_2"));
    const text = JSON.stringify(log.mock.calls);
    expect(text).not.toContain("SENTINELA");
    expect(text).not.toContain("HEMOGRAMA");
    expect(text).toContain("TURNAROUND");
  });
});
