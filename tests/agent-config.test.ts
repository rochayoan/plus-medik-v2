import { describe, expect, it } from "vitest";
import { checkSource, dateProblems, renderTextsDoc } from "../scripts/agent-config.js";
import { buildPromptSource } from "../src/conversation-openai.js";
import { DATA_SECTION_IDS, renderFacts, validateBusinessData, type BusinessData, type DataSectionId } from "../src/conversation-facts.js";
import { guardModelReply } from "../src/conversation-model.js";
import { BUSINESS_DATA, SYSTEM_PROMPT } from "../src/system-prompt.js";
import { DRAFT_TEXTS } from "../src/text-handler.js";

// Configuración del agente conversacional (src/system-prompt.ts): SYSTEM_PROMPT y BUSINESS_DATA se importan como código (sin archivos ni generación). El horario general de 24 horas fue informado por el usuario;
// las otras seis secciones siguen POR_COMPLETAR. Una sección confirmada exige fuente, vigencia y datos sin importes. Datos de PRUEBA; sin red.

const NOW = new Date("2026-10-26T12:00:00Z");

// Datos mínimos con las siete secciones POR_COMPLETAR; `overrides` reemplaza una sección.
function dataWith(overrides: Partial<BusinessData> = {}): BusinessData {
  const base = Object.fromEntries(DATA_SECTION_IDS.map((id) => [id, { estado: "POR_COMPLETAR", fuente: "", vigenteHasta: "", datos: "- Dato uno: [POR COMPLETAR]\n- Dato dos: [POR COMPLETAR]" }])) as unknown as BusinessData;
  return { ...base, ...overrides };
}
const confirmed = (datos = "- Dato de prueba: valor de prueba", fuente = "doc-prueba#1", vigenteHasta = "2027-01-01") => ({ estado: "CONFIRMADO" as const, fuente, vigenteHasta, datos });
const check = (data: BusinessData, now = NOW) => {
  const source = buildPromptSource(SYSTEM_PROMPT, data);
  return checkSource({ ...source, problems: source.problems ?? [], origin: "code" }, validateBusinessData(data).pending, now);
};

describe("src/system-prompt.ts real de PlusMedik", () => {
  const report = validateBusinessData(BUSINESS_DATA);

  it("solo el horario general está confirmado por el usuario; otras seis secciones siguen pendientes", () => {
    expect(report.problems).toEqual([]);
    expect(report.sections.map((section) => section.id)).toEqual([...DATA_SECTION_IDS]);
    for (const section of report.sections.filter((item) => item.id !== "HORARIOS")) {
      expect(section, section.id).toMatchObject({ status: "PENDING", text: "", source: null, validUntil: null });
    }
    expect(report.sections.find((section) => section.id === "HORARIOS")).toMatchObject({
      status: "CONFIRMED", source: "confirmacion_usuario_2026-10-30", validUntil: "2026-12-31",
      text: "- Horario de atención general del laboratorio: 24 horas del día."
    });
  });

  it("lista lo que falta con el nombre de cada dato (nombre comercial, direcciones, horarios, teléfonos, servicios, pagos, políticas)", () => {
    const missing = Object.fromEntries(report.pending.map((item) => [item.section, item.missing]));
    expect(missing.NEGOCIO).toContain("Nombre comercial");
    expect(missing.SUCURSALES).toContain("Sucursal 1 — Dirección");
    expect(missing).not.toHaveProperty("HORARIOS");
    expect(missing.TELEFONOS).toContain("WhatsApp de atención");
    expect(missing.SERVICIOS).toContain("Toma de muestras a domicilio");
    expect(missing.METODOS_DE_PAGO).toContain("Métodos aceptados");
    expect(missing.POLITICAS).toContain("Facturación");
    expect(check(BUSINESS_DATA).complete).toBe(false);
  });

  it("tiene UN prompt con UN marcador de datos, personalidad, tono y reglas de conversación editables, y el aviso de que precios, estudios, preparación y tiempos son del sistema", () => {
    expect(SYSTEM_PROMPT.split("{{DATOS}}")).toHaveLength(2);
    for (const heading of ["PERSONALIDAD", "TONO Y ESTILO", "REGLAS DE CONVERSACIÓN", "LO QUE HACE EL SISTEMA", "DATOS DEL LABORATORIO", "CÓMO CLASIFICAR", "FORMATO DE SALIDA"]) expect(SYSTEM_PROMPT, heading).toContain(heading);
    expect(SYSTEM_PROMPT).toMatch(/Tú NUNCA das, estimas ni comentas un precio/);
    expect(SYSTEM_PROMPT).toMatch(/Tú NUNCA los dices/);
    expect(SYSTEM_PROMPT).toMatch(/Tú NUNCA prometes que alguien/);
    expect(SYSTEM_PROMPT).toContain("recepcionista virtual");
    expect(SYSTEM_PROMPT).toContain("👋");
    expect(SYSTEM_PROMPT).toContain("¿Sobre qué te gustaría saber más?");
    expect(SYSTEM_PROMPT).toContain("precio final");
    expect(SYSTEM_PROMPT).toContain("requisitos");
    expect(SYSTEM_PROMPT).toContain("cotización");
    // el prompt no trae ningún dato comercial: ni teléfonos, ni enlaces, ni importes
    expect(SYSTEM_PROMPT).not.toMatch(/https?:\/\/|@|\+?\d[\d ]{6,}\d|\b(bs|bob|usd)\b|\$/i);
  });

  it("solo permite afirmar el horario general confirmado, sin inventar días, servicios o sucursales", () => {
    const facts = renderFacts(report.sections, new Date("2026-10-30T12:00:00Z"));
    expect(facts.included).toEqual(["HORARIOS"]);
    expect(guardModelReply("El laboratorio atiende las 24 horas del día.", facts.context)).toMatchObject({ ok: true });
    expect(guardModelReply("Atendemos de lunes a viernes.", facts.context)).toMatchObject({ ok: false });
    expect(guardModelReply("Abrimos a las 08:00.", facts.context)).toMatchObject({ ok: false });
    expect(guardModelReply("El resultado del hemograma tarda 24 horas.", facts.context)).toMatchObject({ ok: false });
    expect(renderFacts(report.sections, new Date("2027-01-01T12:00:00Z")).included).not.toContain("HORARIOS");
  });

  it("orienta cotización escrita o por foto sin ceder la cotización al modelo", () => {
    const rules = SYSTEM_PROMPT.split("REGLAS DE CONVERSACIÓN")[1]?.split("LO QUE HACE EL SISTEMA")[0];
    expect(rules).toContain("escribir los nombres de sus estudios");
    expect(rules).toContain("foto clara y completa");
    expect(rules).toContain("No le exijas una foto");
    expect(rules).toContain("responde SÍ o escribe LISTO");
    expect(rules).toContain("el backend puede cotizar sin exigir LISTO");
    expect(rules).toContain("tú no calculas precios");
  });
  it("el agente usa ESTE módulo tal cual: el prompt y la huella salen de SYSTEM_PROMPT y BUSINESS_DATA, y la huella cambia con cualquier edición", () => {
    const source = buildPromptSource();
    expect(source).toMatchObject({ origin: "code", problems: [], prompt: SYSTEM_PROMPT });
    expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(buildPromptSource(SYSTEM_PROMPT.replace("PERSONALIDAD", "PERSONALIDAD "), BUSINESS_DATA).sha256).not.toBe(source.sha256);
    expect(buildPromptSource().sha256).toBe(source.sha256);
  });
});

describe("secciones confirmadas (datos de PRUEBA)", () => {
  it("una sección completa pasa al modelo con su fuente y vigencia", () => {
    const result = validateBusinessData(dataWith({ HORARIOS: confirmed("- Oficina: lunes a viernes de 08:00 a 12:00\n- Sábado: 09:00 a 12:00") }));
    expect(result.problems).toEqual([]);
    expect(result.sections.find((section) => section.id === "HORARIOS")).toEqual({
      id: "HORARIOS", title: "Horarios de atención", status: "CONFIRMED", source: "doc-prueba#1", validUntil: "2027-01-01", text: "- Oficina: lunes a viernes de 08:00 a 12:00\n- Sábado: 09:00 a 12:00"
    });
    expect(result.pending.map((item) => item.section)).not.toContain("HORARIOS");
  });

  it("una sección confirmada incompleta o inválida es un ERROR y no llega al modelo: sin fuente, sin vigencia, con pendientes, con importes, vacía o con marcadores", () => {
    const cases: Array<[string, ReturnType<typeof confirmed>, string]> = [
      ["sin fuente", confirmed("- Dir: Calle", ""), "fuente"],
      ["fuente con espacios", confirmed("- Dir: Calle", "doc con espacios"), "fuente"],
      ["sin vigencia", confirmed("- Dir: Calle", "doc#1", ""), "vigenteHasta"],
      ["vigencia imposible", confirmed("- Dir: Calle", "doc#1", "2027-02-31"), "vigenteHasta"],
      ["con pendientes", confirmed("- Dir: [POR COMPLETAR]"), "POR COMPLETAR"],
      ["con importe", confirmed("- Consulta: Bs 45"), "importe"],
      ["vacía", confirmed(""), "ningún dato"],
      ["marcador reservado", confirmed("- Dir: {{DATOS}}"), "reservados"]
    ];
    for (const [name, entry, message] of cases) {
      const result = validateBusinessData(dataWith({ SUCURSALES: entry }));
      expect(result.problems.join(" | "), name).toContain(message);
      expect(result.sections.find((section) => section.id === "SUCURSALES")!.text, name).toBe("");
    }
  });

  it("un defecto en los DATOS no apaga el prompt: esa sección llega vacía y se informa el problema", () => {
    const source = buildPromptSource(SYSTEM_PROMPT, dataWith({ SUCURSALES: confirmed("- Consulta: Bs 45") }));
    expect(source.problems!.join(" ")).toContain("importe");
    expect(source.sections.find((section) => section.id === "SUCURSALES")!.text).toBe("");
    expect(source.prompt).toBe(SYSTEM_PROMPT);
  });

  it("las fechas: lo vencido se detecta (el agente lo descarta al usarlo) y lo que supera 400 días se avisa; validar los datos no depende de la fecha", () => {
    const result = validateBusinessData(dataWith({
      HORARIOS: confirmed("- a: b", "doc#1", "2026-10-01"),
      TELEFONOS: confirmed("- a: b", "doc#1", "2028-12-31"),
      SERVICIOS: confirmed("- a: b", "doc#1", "2027-03-01")
    }));
    expect(result.problems).toEqual([]);
    expect(dateProblems(result.sections, NOW)).toEqual({ expired: ["HORARIOS"], tooFar: ["TELEFONOS"] });
  });

  it("completo = las siete confirmadas, vigentes y dentro de 400 días", () => {
    const all = Object.fromEntries(DATA_SECTION_IDS.map((id: DataSectionId) => [id, confirmed()])) as unknown as BusinessData;
    expect(check(all)).toMatchObject({ valid: true, complete: true, expired: [], tooFar: [] });
    expect(check({ ...all, HORARIOS: confirmed("- a: b", "doc#1", "2026-10-01") }).complete).toBe(false);
  });
});

describe("los textos fijos", () => {
  it("el documento de textos a aprobar sale del código y recuerda que son el respaldo determinista", () => {
    const doc = renderTextsDoc();
    expect(doc).toContain(DRAFT_TEXTS.greeting);
    expect(doc).toContain("determinista");
  });
});
