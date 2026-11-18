import { describe, expect, it } from "vitest";
import { verifyReply } from "../src/agent/verify.js";

const MENU = "¡Hola! ¿En qué te puedo ayudar?\n1️⃣ Cotizar estudios\n2️⃣ Ubicación y horarios\n3️⃣ Hablar con una persona\nResponde con el número o cuéntame qué necesitas.";

describe("menú de opciones numerado: los marcadores de lista no cuentan como cifra", () => {
  it("el menú con insignias de teclado pasa la verificación", () => {
    expect(verifyReply({ text: MENU, facts: [] })).toEqual([]);
  });
  it("también «1.» y «2)» al inicio de línea", () => {
    expect(verifyReply({ text: "Elige:\n1. Cotizar estudios\n2) Ubicación y horarios", facts: [] })).toEqual([]);
  });
  it("solo del 1 al 5: «7️⃣» sigue siendo una cifra sin procedencia", () => {
    expect(verifyReply({ text: "Opciones:\n7️⃣ Cotizar", facts: [] }).map((p) => p.code)).toContain("UNGROUNDED_FIGURE");
  });
  it("un número en medio de la frase no es marcador: «2 estudios» sigue exigiendo procedencia", () => {
    expect(verifyReply({ text: "Tienes 2 estudios pendientes", facts: [] }).map((p) => p.code)).toContain("UNGROUNDED_FIGURE");
  });
  it("un marcador no protege un precio: «1. Hemograma Bs 45» sigue rechazado", () => {
    expect(verifyReply({ text: "1. Hemograma Bs 45", facts: [] }).map((p) => p.code)).toContain("PRICE_OUTSIDE_QUOTE");
  });
  it("un horario no se disfraza de marcador", () => {
    expect(verifyReply({ text: "Abrimos de 7 a 10", facts: [] }).map((p) => p.code)).toContain("UNGROUNDED_FIGURE");
  });
});
