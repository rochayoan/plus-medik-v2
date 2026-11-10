// Foto de ubicación: cuando la respuesta del agente lleva el link de Google Maps del laboratorio, sale UN solo mensaje: la foto «¿Dónde estamos?» con el texto (y el link) como pie. Así el paciente recibe
// el mapa, la dirección y el link juntos sin gastar dos mensajes. Es una capa de ENVÍO: no decide qué decir (eso sigue en el agente y en el conocimiento aprobado) y NUNCA bloquea la respuesta: ante
// cualquier fallo (sin foto, sin subida, sin red) quien llama envía el texto como siempre.

export const MAPS_LINK = /https:\/\/maps\.app\.goo\.gl\/[A-Za-z0-9_-]+/i;
// WhatsApp admite hasta 1024 caracteres en el pie de una imagen.
export const MAX_CAPTION_CHARS = 1000;
// El id de un medio subido a la nube de WhatsApp caduca (30 días): se vuelve a subir antes.
const MEDIA_TTL_MS = 14 * 24 * 3600 * 1000;

export interface LocationPhotoPorts {
  // Los bytes de la foto, o undefined si no está disponible (se responde solo con texto).
  readPhoto(): Promise<Uint8Array | undefined>;
  // Sube la foto y devuelve el id del medio.
  upload(bytes: Uint8Array): Promise<string>;
  sendImage(to: string, mediaId: string, caption: string): Promise<{ providerMessageId?: string }>;
  log(event: string, data: Record<string, unknown>): void;
  now?: () => number;
}

export type LocationPhotoSender = (to: string, body: string) => Promise<{ providerMessageId?: string } | undefined>;

export function createLocationPhotoSender(ports: LocationPhotoPorts): LocationPhotoSender {
  const now = ports.now ?? Date.now;
  let bytes: Uint8Array | undefined;
  let media: { id: string; at: number } | undefined;

  async function mediaId(force: boolean): Promise<string | undefined> {
    if (!force && media && now() - media.at < MEDIA_TTL_MS) return media.id;
    bytes ??= await ports.readPhoto();
    if (!bytes) return undefined;
    media = { id: await ports.upload(bytes), at: now() };
    return media.id;
  }

  return async (to, body) => {
    // Solo una respuesta corta con el link del laboratorio lleva la foto; cualquier otra sale como texto.
    if (!MAPS_LINK.test(body) || body.length > MAX_CAPTION_CHARS) return undefined;
    for (const force of [false, true]) {
      try {
        const id = await mediaId(force);
        if (!id) {
          ports.log("location_photo", { outcome: "NO_PHOTO" });
          return undefined;
        }
        const sent = await ports.sendImage(to, id, body);
        ports.log("location_photo", { outcome: "SENT" });
        return sent;
      } catch {
        // Un id caducado o una subida fallida: un único reintento subiendo de nuevo; luego, texto. Nunca el texto del error.
        media = undefined;
        ports.log("location_photo", { outcome: "FAILED", retry: !force });
      }
    }
    return undefined;
  };
}
