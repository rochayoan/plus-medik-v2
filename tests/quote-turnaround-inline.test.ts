import { describe, expect, it } from "vitest";
import { formatDoctorConfirms } from "../src/quote-options.js";
import { formatQuoteMessage, turnaroundSuffix } from "../src/whatsapp-quote.js";

// Dueño (20-nov): «sí o sí en la cotización, aparte del precio, tiene que estar el tiempo de entrega». Lo usan la cotización por texto (agente y rutas de respaldo) y la de fotos.
describe("tiempo de entrega junto al precio", () => {
  it("con dato: el texto del laboratorio tal cual; sin dato en el catálogo: lo confirma la doctora; si quien llama no lo trae: nada", () => {
    expect(turnaroundSuffix("3 días")).toBe(" (entrega: 3 días)");
    expect(turnaroundSuffix(null)).toBe(" (entrega: te la confirma la doctora)");
    expect(turnaroundSuffix("  ")).toBe(" (entrega: te la confirma la doctora)");
    expect(turnaroundSuffix(undefined)).toBe("");
  });
  it("cada línea de la cotización lleva el suyo y el encabezado se puede cambiar", () => {
    const text = formatQuoteMessage({ studies: [{ name: "ZINC", priceBs: 220, turnaroundText: "4 días" }, { name: "HOMOCISTEINA", priceBs: 250, turnaroundText: null }, { name: "GLUCOSA", priceBs: 30 }], totalBs: 500, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" }, { title: "Tu cotización" });
    expect(text.split("\n").slice(0, 5)).toEqual(["🩺 *PlusMedik* · Tu cotización", "", "🧪 ZINC — Bs 220 (entrega: 4 días)", "🧪 HOMOCISTEINA — Bs 250 (entrega: te la confirma la doctora)", "🍬 GLUCOSA — Bs 30"]);
  });
});

describe("estudios que confirma la doctora (indicación del laboratorio, 20-nov)", () => {
  it("uno o varios, sin repetir, con mayúscula inicial; nunca dice que no lo tenemos", () => {
    expect(formatDoctorConfirms([])).toBeUndefined();
    expect(formatDoctorConfirms(["ecografia"])).toBe("👩‍⚕️ *Este estudio te lo confirma la doctora:*\n\n▫️ Ecografia\n\nTe escribirá por este chat con el precio y el tiempo de entrega. 😊");
    const many = formatDoctorConfirms(["ecografia", "resonancia", "ecografia"])!;
    expect(many).toMatch(/^👩‍⚕️ \*Estos estudios te los confirma la doctora:\*\n\n▫️ Ecografia\n▫️ Resonancia\n/);
    expect(many).not.toMatch(/no (lo |los )?tenemos|no (lo |los )?realizamos|laboratorio/i);
  });
});
