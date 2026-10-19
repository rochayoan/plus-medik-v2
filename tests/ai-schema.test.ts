import { ThinkingLevel } from "@google/genai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { geminiThinkingLevel, strictJsonSchema } from "../src/ai.js";

describe("strictJsonSchema (zod 4)", () => {
  const schema = z.object({
    name: z.string().min(1),
    items: z.array(z.object({ kind: z.enum(["a", "b"]), ok: z.boolean() }))
  });

  it("genera un esquema con 'type' (la API rechaza {\"$schema\": ...} a secas) y sin $schema", () => {
    const json = strictJsonSchema(schema);
    expect(json.type).toBe("object");
    expect(json).not.toHaveProperty("$schema");
    expect(json.properties).toMatchObject({ name: { type: "string" }, items: { type: "array" } });
  });

  it("es compatible con el modo estricto: todos los campos requeridos y sin propiedades extra", () => {
    const json = strictJsonSchema(schema) as { required: string[]; additionalProperties: boolean; properties: { items: { items: { required: string[]; additionalProperties: boolean } } } };
    expect(json.required.sort()).toEqual(["items", "name"]);
    expect(json.additionalProperties).toBe(false);
    expect(json.properties.items.items.required.sort()).toEqual(["kind", "ok"]);
    expect(json.properties.items.items.additionalProperties).toBe(false);
  });
});

describe("geminiThinkingLevel", () => {
  it("traduce low|medium|high (cualquier capitalización) al enum del SDK", () => {
    expect(geminiThinkingLevel("low")).toBe(ThinkingLevel.LOW);
    expect(geminiThinkingLevel(" Medium ")).toBe(ThinkingLevel.MEDIUM);
    expect(geminiThinkingLevel("HIGH")).toBe(ThinkingLevel.HIGH);
  });

  it("rechaza valores desconocidos o sin especificar", () => {
    expect(() => geminiThinkingLevel("extreme")).toThrow(/GEMINI_THINKING_LEVEL/);
    expect(() => geminiThinkingLevel("THINKING_LEVEL_UNSPECIFIED")).toThrow(/GEMINI_THINKING_LEVEL/);
  });
});
