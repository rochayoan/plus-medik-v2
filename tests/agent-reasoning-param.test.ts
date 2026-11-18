import { describe, expect, it } from "vitest";
import { supportsReasoning } from "../src/agent/openai.js";

// gpt-4o / gpt-4.1 responden 400 «unsupported_parameter» si se les envía `reasoning`: el agente quedaba en modo esencial en cada mensaje.
describe("supportsReasoning", () => {
  it("la familia gpt-4 no recibe el parámetro; el resto sí", () => {
    for (const model of ["gpt-5", "gpt-5-mini", "gpt-5.1", "o3", "o4-mini", " GPT-5 ", "modelo-x"]) expect(supportsReasoning(model), model).toBe(true);
    for (const model of ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "gpt-4.1-mini", " GPT-4O "]) expect(supportsReasoning(model), model).toBe(false);
  });
});
