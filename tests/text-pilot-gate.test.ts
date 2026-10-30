import { describe, expect, it } from "vitest";
import { resolveTextPilotGate } from "../src/text-pilot-gate.js";

const pilot = "59170000000";
const scoped = { PLUSMEDIK_TEXT_PILOT_GUARD: "on", PLUSMEDIK_AGENT_CONTROL_PHONES: pilot };
const ready = { enabled: true, ready: true, pilotPhone: pilot };

describe("puerta de piloto de texto sin afectar fotos de otros pacientes", () => {
  it("apagada o ausente conserva el comportamiento anterior", () => {
    expect(resolveTextPilotGate({})).toEqual({ enabled: false, ready: true });
    expect(resolveTextPilotGate({ PLUSMEDIK_TEXT_PILOT_GUARD: "off" })).toEqual({ enabled: false, ready: true });
  });
  it("acepta un único teléfono piloto con ALLOWED_PHONES sin límite", () => {
    expect(resolveTextPilotGate(scoped)).toEqual(ready);
    expect(resolveTextPilotGate({ ...scoped, ALLOWED_PHONES: "" })).toEqual(ready);
  });
  it("no obliga a eliminar a otros pacientes de ALLOWED_PHONES", () => {
    expect(resolveTextPilotGate({
      ...scoped, ALLOWED_PHONES: "59170000001,59170000000,59170000002"
    })).toEqual(ready);
    expect(resolveTextPilotGate({
      ...scoped, ALLOWED_PHONES: "+59170000000", PLUSMEDIK_AGENT_CONTROL_PHONES: "+59170000000"
    })).toEqual(ready);
  });
  it.each([
    ["control ausente", { PLUSMEDIK_AGENT_CONTROL_PHONES: undefined }],
    ["control con dos números", { PLUSMEDIK_AGENT_CONTROL_PHONES: "59170000000,59170000001" }],
    ["control malformado", { PLUSMEDIK_AGENT_CONTROL_PHONES: "591 70000000" }],
    ["teléfono piloto excluido por filtro existente", { ALLOWED_PHONES: "59170000001" }],
    ["whitelist global con entrada malformada", { ALLOWED_PHONES: "59170000000,abc" }],
    ["control corto", { PLUSMEDIK_AGENT_CONTROL_PHONES: "12345" }],
    ["comodín", { ALLOWED_PHONES: "*" }],
  ])("falla cerrado: %s", (_name, overrides) => {
    expect(resolveTextPilotGate({ ...scoped, ...overrides })).toEqual({
      enabled: true, ready: false, reason: "PILOT_SCOPE_MISSING_OR_MISMATCH"
    });
  });
  it("un flag inválido no desactiva silenciosamente el aislamiento", () => {
    expect(resolveTextPilotGate({ ...scoped, PLUSMEDIK_TEXT_PILOT_GUARD: "onn" })).toEqual({
      enabled: true, ready: false, reason: "INVALID_FLAG"
    });
  });
});
