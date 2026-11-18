import { describe, expect, it } from "vitest";
import { supportsReasoning } from "../src/agent/openai.js";

// gpt-4o / gpt-4.1 responden 400 «unsupported_parameter» si se les envía `reasoning`: el agente quedaba en modo esencial en cada mensaje.
describe("supportsReasoning", () => {
  it("solo los modelos de razonamiento reciben el parámetro", () => {
    for (const model of ["gpt-5", "gpt-5-mini", "gpt-5.1", "o3", "o4-mini", " GPT-5 "]) expect(supportsReasoning(model), model).toBe(true);
    for (const model of ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "gpt-4.1-mini"]) expect(supportsReasoning(model), model).toBe(false);
  });
});
