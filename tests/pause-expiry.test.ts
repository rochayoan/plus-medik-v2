import { describe, expect, it, vi } from "vitest";
import { createPauseExpiry, DEFAULT_PAUSE_EXPIRY_HOURS, resolvePauseExpiryHours } from "../src/pause-expiry.js";

const KEY = "a".repeat(64);
const NOW = Date.parse("2026-11-11T21:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const build = (rows: unknown, options: { ok?: boolean; hours?: number; resume?: string; throws?: boolean } = {}) => {
  const resume = vi.fn(async () => (options.resume ?? "RESUMED") as "RESUMED" | "ALREADY_ACTIVE");
  const fetchFn = vi.fn(async () => {
    if (options.throws) throw new Error("red caída");
    return new Response(JSON.stringify(rows), { status: options.ok === false ? 500 : 200 });
  }) as unknown as typeof fetch;
  const expire = createPauseExpiry({ hours: options.hours ?? 12, attention: { resume }, baseUrl: "https://x.supabase.co", serviceKey: "k", fetchFn, now: () => NOW });
  return { expire, resume, fetchFn };
};

describe("vencimiento de la pausa humana", () => {
  it("reanuda un contacto pausado cuya última actividad humana pasó el plazo", async () => {
    const { expire, resume } = build([{ state: "HUMAN_PAUSED", last_human_event_at: hoursAgo(13) }]);
    expect(await expire(KEY)).toBe("RESUMED");
    expect(resume).toHaveBeenCalledWith(KEY, "AUTO_PAUSE_EXPIRED", "agent");
  });
  it("conserva la pausa si la persona escribió dentro del plazo", async () => {
    const { expire, resume } = build([{ state: "HUMAN_PAUSED", last_human_event_at: hoursAgo(2) }]);
    expect(await expire(KEY)).toBe("KEPT");
    expect(resume).not.toHaveBeenCalled();
  });
  it("no hace nada con un contacto activo o inexistente", async () => {
    expect(await build([{ state: "ACTIVE", last_human_event_at: hoursAgo(99) }]).expire(KEY)).toBe("NOT_PAUSED");
    expect(await build([]).expire(KEY)).toBe("NOT_PAUSED");
  });
  it("falla cerrado: sin fecha, con error de la base o de red, o con una clave inválida la pausa no se toca", async () => {
    const cases = [build([{ state: "HUMAN_PAUSED", last_human_event_at: null }]), build({}, { ok: false }), build([], { throws: true })];
    for (const { expire, resume } of cases) {
      expect(["KEPT", "UNKNOWN"]).toContain(await expire(KEY));
      expect(resume).not.toHaveBeenCalled();
    }
    const invalid = build([{ state: "HUMAN_PAUSED", last_human_event_at: hoursAgo(99) }]);
    expect(await invalid.expire("no-es-una-clave")).toBe("UNKNOWN");
    expect(invalid.fetchFn).not.toHaveBeenCalled();
  });
  it("la configuración: 12 h por defecto, número válido, apagado con off", () => {
    expect(resolvePauseExpiryHours({})).toBe(DEFAULT_PAUSE_EXPIRY_HOURS);
    expect(resolvePauseExpiryHours({ PLUSMEDIK_PAUSE_EXPIRY_HOURS: "24" })).toBe(24);
    expect(resolvePauseExpiryHours({ PLUSMEDIK_PAUSE_EXPIRY_HOURS: "off" })).toBeUndefined();
    expect(resolvePauseExpiryHours({ PLUSMEDIK_PAUSE_EXPIRY_HOURS: "abc" })).toBe(DEFAULT_PAUSE_EXPIRY_HOURS);
    expect(resolvePauseExpiryHours({ PLUSMEDIK_PAUSE_EXPIRY_HOURS: "9999" })).toBe(DEFAULT_PAUSE_EXPIRY_HOURS);
  });
});
