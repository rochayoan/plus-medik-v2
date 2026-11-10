import { describe, expect, it, vi } from "vitest";
import { createLocationPhotoSender, MAX_CAPTION_CHARS } from "../src/location-photo.js";

const LINK = "https://maps.app.goo.gl/DU3r4eedeEWKHHZ2A";
function setup(over: { readPhoto?: () => Promise<Uint8Array | undefined>; sendImage?: ReturnType<typeof vi.fn> } = {}) {
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  let uploads = 0;
  const ports = {
    readPhoto: over.readPhoto ?? (async () => new Uint8Array([1, 2, 3])),
    upload: vi.fn(async () => `media-${++uploads}`),
    sendImage: over.sendImage ?? vi.fn(async () => ({ providerMessageId: "wamid.img" })),
    log: (event: string, data: Record<string, unknown>) => logs.push({ event, data })
  };
  return { send: createLocationPhotoSender(ports), ports, logs };
}

describe("foto de ubicación junto al link de Maps", () => {
  it("con el link del laboratorio sale UNA imagen con el texto como pie", async () => {
    const t = setup();
    const out = await t.send("59170000000", `Estamos en Calle Cuellar. ${LINK}`);
    expect(out).toEqual({ providerMessageId: "wamid.img" });
    expect(t.ports.sendImage).toHaveBeenCalledWith("59170000000", "media-1", `Estamos en Calle Cuellar. ${LINK}`);
  });
  it("sube la foto una sola vez y reutiliza el id", async () => {
    const t = setup();
    await t.send("59170000000", LINK);
    await t.send("59170000001", LINK);
    expect(t.ports.upload).toHaveBeenCalledTimes(1);
  });
  it("sin link de Maps (o con otro enlace) no hace nada: sale texto", async () => {
    const t = setup();
    expect(await t.send("59170000000", "Atendemos las 24 horas 😊")).toBeUndefined();
    expect(await t.send("59170000000", "mira https://example.com/mapa")).toBeUndefined();
    expect(t.ports.sendImage).not.toHaveBeenCalled();
  });
  it("un texto demasiado largo para un pie no lleva foto", async () => {
    const t = setup();
    expect(await t.send("59170000000", `${"x".repeat(MAX_CAPTION_CHARS)} ${LINK}`)).toBeUndefined();
  });
  it("sin foto disponible, responde como texto", async () => {
    const t = setup({ readPhoto: async () => undefined });
    expect(await t.send("59170000000", LINK)).toBeUndefined();
    expect(t.logs.at(-1)?.data.outcome).toBe("NO_PHOTO");
  });
  it("id caducado: sube de nuevo y reintenta una vez; si vuelve a fallar, texto", async () => {
    const sendImage = vi.fn().mockRejectedValueOnce(new Error("expired")).mockResolvedValueOnce({ providerMessageId: "wamid.2" });
    const ok = setup({ sendImage });
    expect(await ok.send("59170000000", LINK)).toEqual({ providerMessageId: "wamid.2" });
    expect(ok.ports.upload).toHaveBeenCalledTimes(2);
    const bad = setup({ sendImage: vi.fn().mockRejectedValue(new Error("down")) });
    expect(await bad.send("59170000000", LINK)).toBeUndefined();
    expect(JSON.stringify(bad.logs)).not.toContain("down");
  });
});
