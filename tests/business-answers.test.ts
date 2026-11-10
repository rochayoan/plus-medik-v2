import { describe, expect, it } from "vitest";
import { answerFromBusinessData } from "../src/business-answers.js";
import type { DataSection } from "../src/conversation-facts.js";

const NOW = new Date("2026-11-11T12:00:00Z");
const section = (id: DataSection["id"], text: string, over: Partial<DataSection> = {}): DataSection => ({ id, title: id, status: "CONFIRMED", source: "x", validUntil: "2026-12-31", text, ...over });
const SOURCE: DataSection[] = [
  section("NEGOCIO", "- Ubicación en Google Maps: https://maps.app.goo.gl/DU3r4eedeEWKHHZ2A"),
  section("SUCURSALES", "- Sucursal 1 — Dirección: Calle Cuellar casi esquina Santa Bárbara.\n- Sucursal 1 — Mapa: https://maps.app.goo.gl/DU3r4eedeEWKHHZ2A"),
  section("HORARIOS", "- Atención general: las 24 horas, todos los días del año.\n- No es necesario sacar cita previa."),
  section("TELEFONOS", "", { status: "PENDING", source: null, validUntil: null })
];

describe("lab_info con los datos comerciales de Git", () => {
  it("la ubicación sale de BUSINESS_DATA con el mapa vigente", () => {
    const answer = answerFromBusinessData("¿Dónde están ubicados?", NOW, SOURCE);
    expect(answer?.status).toBe("ANSWERED");
    expect(answer?.body).toContain("Calle Cuellar");
    expect(answer?.body).toContain("https://maps.app.goo.gl/DU3r4eedeEWKHHZ2A");
    expect(answer?.refs).toEqual([]);
  });
  it("el horario general sale de BUSINESS_DATA, con la cita previa", () => {
    const answer = answerFromBusinessData("¿A qué hora atienden? ¿hay que sacar cita?", NOW, SOURCE);
    expect(answer?.body).toContain("las 24 horas");
    expect(answer?.body).toContain("cita previa");
  });
  it("ubicación y horario juntos en una sola respuesta", () => {
    const answer = answerFromBusinessData("dónde queda y a qué hora abren", NOW, SOURCE);
    expect(answer?.body).toContain("Calle Cuellar");
    expect(answer?.body).toContain("24 horas");
  });
  it("otros temas (pagos, preparación, plazos) o temas mezclados siguen por el conocimiento aprobado", () => {
    expect(answerFromBusinessData("¿cómo puedo pagar?", NOW, SOURCE)).toBeUndefined();
    expect(answerFromBusinessData("¿necesito ayuno para el hemograma?", NOW, SOURCE)).toBeUndefined();
    expect(answerFromBusinessData("dónde queda y cómo puedo pagar", NOW, SOURCE)).toBeUndefined();
    expect(answerFromBusinessData("hola", NOW, SOURCE)).toBeUndefined();
  });
  it("una sección pendiente o vencida no se usa: la pregunta sigue por el camino de siempre", () => {
    expect(answerFromBusinessData("dónde queda", NOW, SOURCE.map((s) => (s.id === "SUCURSALES" ? { ...s, status: "PENDING" as const, text: "" } : s)))).toBeUndefined();
    expect(answerFromBusinessData("dónde queda", new Date("2027-02-01T00:00:00Z"), SOURCE)).toBeUndefined();
    expect(answerFromBusinessData("a qué hora atienden", NOW, SOURCE.filter((s) => s.id !== "HORARIOS"))).toBeUndefined();
  });
  it("con los datos reales del repositorio, la ubicación trae el mapa oficial", () => {
    const answer = answerFromBusinessData("¿dónde están?", NOW);
    expect(answer?.body).toContain("https://maps.app.goo.gl/DU3r4eedeEWKHHZ2A");
  });
});
