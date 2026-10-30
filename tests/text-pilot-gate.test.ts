import { describe, expect, it } from "vitest";
import { resolveTextPilotGate } from "../src/text-pilot-gate.js";

const scoped = { PLUSMEDIK_TEXT_PILOT_GUARD: "on", ALLOWED_PHONES: "59170000000", PLUSMEDIK_AGENT_CONTROL_PHONES: "59170000000" };

describe("puerta estricta de piloto de cotización por texto", () => {
  it("no cambia nada si la función no se habilita", () => {
    expect(resolveTextPilotGate({})).toEqual({ enabled: false, ready: true });
    expect(resolveTextPilotGate({ PLUSMEDIK_TEXT_PILOT_GUARD: "off" })).toEqual({ enabled: false, ready: true });
  });
  it("acepta un único teléfono exacto para ambas listas", () => {
    expect(resolveTextPilotGate(scoped)).toEqual({ enabled: true, ready: true });
    expect(resolveTextPilotGate({ ...scoped, ALLOWED_PHONES: " +59170000000 ", PLUSMEDIK_AGENT_CONTROL_PHONES: "59170000000" })).toEqual({ enabled: true, ready: true });
  });
  it.each([
    ["lista de permitido vacía", { ALLOWED_PHONES: undefined }],
    ["lista de control ausente", { PLUSMEDIK_AGENT_CONTROL_PHONES: undefined }],
    ["dos permitidos", { ALLOWED_PHONES: "59170000000,59170000001" }],
    ["dos controlados", { PLUSMEDIK_AGENT_CONTROL_PHONES: "59170000000,59170000001" }],
    ["otros contactos", { PLUSMEDIK_AGENT_CONTROL_PHONES: "59170000001" }],
    ["permitido inválido", { ALLOWED_PHONES: "abc" }],
    ["control inválido", { PLUSMEDIK_AGENT_CONTROL_PHONES: "591 70000000" }],
    ["número corto", { ALLOWED_PHONES: "1234567" }],
    ["comodín", { ALLOWED_PHONES: "*" }],
  ])("rechaza %s", (_name, overrides) => {
    expect(resolveTextPilotGate({ ...scoped, ...overrides })).toEqual({
      enabled: true, ready: false, reason: "PILOT_SCOPE_MISSING_OR_MISMATCH"
    });
  });
  it("un valor erróneo no desactiva la protección silenciosamente", () => {
    expect(resolveTextPilotGate({ ...scoped, PLUSMEDIK_TEXT_PILOT_GUARD: "onn" })).toEqual({
      enabled: true, ready: false, reason: "INVALID_FLAG"
    });
  });
});
