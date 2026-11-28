// CONDICIONES DE LA FOTO, leídas de los METADATOS del archivo (sin decodificar píxeles, sin dependencias y sin modificar la imagen).
// Los celulares guardan la foto "acostada" y marcan en EXIF cómo girarla; una foto chica obliga a leer letras de pocos píxeles. Eso se le AVISA a los
// lectores y al juez con reglas generales (ver readingHints): la imagen que reciben es SIEMPRE la original, completa y sin recortes.
// Nada de esto decide ni autoriza nada: la integridad del documento (cortes, ilegibles, ocultamientos) la sigue evaluando document-signal.ts.

export interface PhotoQuality {
  format: "jpeg" | "png" | "webp" | "unknown";
  // Tamaño tal como se ve la foto (ya girada según EXIF), si se pudo leer.
  width?: number;
  height?: number;
  // Orientación EXIF (1 = normal; 2..8 = girada y/o en espejo). Solo JPEG.
  orientation?: number;
  rotationDegrees: 0 | 90 | 180 | 270;
  mirrored: boolean;
  lowResolution: boolean;
}

// Lado corto por debajo del cual las letras de una receta quedan con muy pocos píxeles (una hoja carta a menos de ~85 ppp). Es un aviso, no un bloqueo.
export const LOW_RESOLUTION_SHORT_SIDE = 720;

const ROTATION: Record<number, { degrees: 0 | 90 | 180 | 270; mirrored: boolean }> = {
  1: { degrees: 0, mirrored: false }, 2: { degrees: 0, mirrored: true }, 3: { degrees: 180, mirrored: false }, 4: { degrees: 180, mirrored: true },
  5: { degrees: 90, mirrored: true }, 6: { degrees: 90, mirrored: false }, 7: { degrees: 270, mirrored: true }, 8: { degrees: 270, mirrored: false }
};

const u16 = (bytes: Uint8Array, at: number, little: boolean) => (little ? bytes[at]! | (bytes[at + 1]! << 8) : (bytes[at]! << 8) | bytes[at + 1]!);
const u32 = (bytes: Uint8Array, at: number, little: boolean) =>
  little ? (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16)) + bytes[at + 3]! * 0x1000000 : bytes[at]! * 0x1000000 + ((bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!);
const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));

// Orientación del bloque EXIF (TIFF): IFD0, etiqueta 0x0112. Cualquier dato inconsistente → undefined.
function exifOrientation(bytes: Uint8Array, tiff: number, end: number): number | undefined {
  if (tiff + 8 > end) return undefined;
  const order = ascii(bytes, tiff, 2);
  if (order !== "II" && order !== "MM") return undefined;
  const little = order === "II";
  const ifd = tiff + u32(bytes, tiff + 4, little);
  if (ifd + 2 > end) return undefined;
  const count = u16(bytes, ifd, little);
  for (let index = 0; index < count; index++) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > end) return undefined;
    if (u16(bytes, entry, little) === 0x0112) {
      const value = u16(bytes, entry + 8, little);
      return value >= 1 && value <= 8 ? value : undefined;
    }
  }
  return undefined;
}

function readJpeg(bytes: Uint8Array): { width?: number; height?: number; orientation?: number } {
  const out: { width?: number; height?: number; orientation?: number } = {};
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return out;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) { at++; continue; }
    if (marker === 0xd9 || marker === 0xda) return out; // fin de imagen o comienzo de los datos comprimidos
    if (marker >= 0xd0 && marker <= 0xd7) { at += 2; continue; }
    const length = u16(bytes, at + 2, false);
    const segment = at + 4;
    const end = at + 2 + length;
    if (length < 2 || end > bytes.length) return out;
    if (marker === 0xe1 && ascii(bytes, segment, 6) === "Exif\0\0" && out.orientation === undefined) out.orientation = exifOrientation(bytes, segment + 6, end);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame && segment + 5 <= end) {
      out.height = u16(bytes, segment + 1, false);
      out.width = u16(bytes, segment + 3, false);
    }
    at = end;
  }
  return out;
}

function readWebp(bytes: Uint8Array): { width?: number; height?: number } {
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X" && bytes.length >= 30) return { width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)), height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) };
  if (chunk === "VP8 " && bytes.length >= 30) return { width: u16(bytes, 26, true) & 0x3fff, height: u16(bytes, 28, true) & 0x3fff };
  if (chunk === "VP8L" && bytes.length >= 25) {
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return {};
}

export function photoQualityOf(bytes: Uint8Array): PhotoQuality {
  let format: PhotoQuality["format"] = "unknown";
  let raw: { width?: number; height?: number; orientation?: number } = {};
  try {
    if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) { format = "jpeg"; raw = readJpeg(bytes); }
    else if (bytes.length >= 24 && ascii(bytes, 1, 3) === "PNG" && ascii(bytes, 12, 4) === "IHDR") { format = "png"; raw = { width: u32(bytes, 16, false), height: u32(bytes, 20, false) }; }
    else if (bytes.length >= 16 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") { format = "webp"; raw = readWebp(bytes); }
  } catch {
    raw = {};
  }
  const turn = ROTATION[raw.orientation ?? 1] ?? ROTATION[1]!;
  const valid = (value?: number) => (value !== undefined && value > 0 && value < 100_000 ? value : undefined);
  const w = valid(raw.width);
  const h = valid(raw.height);
  const sideways = turn.degrees === 90 || turn.degrees === 270;
  const width = sideways ? h : w;
  const height = sideways ? w : h;
  return {
    format,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(raw.orientation !== undefined ? { orientation: raw.orientation } : {}),
    rotationDegrees: turn.degrees,
    mirrored: turn.mirrored,
    lowResolution: width !== undefined && height !== undefined && Math.min(width, height) < LOW_RESOLUTION_SHORT_SIDE
  };
}

// Avisos generales para los lectores y el juez. Vacío si la foto no tiene nada que avisar: entonces el prompt es exactamente el de siempre.
export function readingHints(quality: PhotoQuality): string[] {
  const hints: string[] = [];
  if (quality.rotationDegrees !== 0) hints.push(`Según sus metadatos, la foto está girada ${quality.rotationDegrees}°: lee el texto en su orientación correcta y no omitas ni reordenes filas por la rotación.`);
  if (quality.mirrored) hints.push("Según sus metadatos, la foto está reflejada en espejo: lee el texto invirtiendo el reflejo; si una letra o número queda dudoso, no lo adivines.");
  if (quality.lowResolution) hints.push(`La foto tiene poca resolución (${quality.width}×${quality.height} px): letras y números pueden verse borrosos. Si no se distinguen con seguridad, no los completes: usa uncertainStudies.`);
  return hints;
}

// ───────────────────────────── condiciones VISTAS en la imagen (señal del documento) ─────────────────────────────
// Las dos pasadas de document-signal.ts (que ya miran la foto) informan cómo se ve: orientación del texto, legibilidad de la zona de estudios, desenfoque e
// iluminación. Se fusionan de forma conservadora (lo peor de las dos) y sirven para: (1) avisar al juez, (2) no relajar dudas de certeza si la foto no se ve
// bien y (3) con legibilidad POOR, tratar la zona como ilegible (revisión), igual que erasedOrIllegible.
export const PHOTO_ORIENTATIONS = ["UPRIGHT", "ROTATED_90", "ROTATED_180", "ROTATED_270", "UNCLEAR"] as const;
export const PHOTO_LEGIBILITY = ["GOOD", "REDUCED", "POOR"] as const;
export const PHOTO_LIGHTING = ["GOOD", "DIM", "GLARE", "UNEVEN"] as const;

export interface RawPhotoCondition {
  orientation: (typeof PHOTO_ORIENTATIONS)[number];
  legibility: (typeof PHOTO_LEGIBILITY)[number];
  blurry: boolean;
  lighting: (typeof PHOTO_LIGHTING)[number];
  notes: string;
}

export interface PhotoCondition {
  // Coinciden las dos pasadas; si no, UNCLEAR (salvo que ambas digan derecha).
  orientation: RawPhotoCondition["orientation"];
  // La peor de las dos.
  legibility: RawPhotoCondition["legibility"];
  blurry: boolean;
  // Lo que informó cualquiera de las dos (vacío si las dos dicen buena luz).
  lighting: Array<Exclude<RawPhotoCondition["lighting"], "GOOD">>;
  // true solo si las DOS pasadas informaron y la foto se ve bien: derecha, legible, nítida y con buena luz.
  clear: boolean;
  notes: string[];
}

// Fusión conservadora. Si alguna pasada no trae la condición (lecturas anteriores al campo), la foto queda sin evaluar: undefined.
export function fusePhotoCondition(a?: RawPhotoCondition, b?: RawPhotoCondition): PhotoCondition | undefined {
  if (!a || !b) return undefined;
  const rank = { GOOD: 0, REDUCED: 1, POOR: 2 } as const;
  const legibility = rank[a.legibility] >= rank[b.legibility] ? a.legibility : b.legibility;
  const orientation = a.orientation === b.orientation ? a.orientation : "UNCLEAR";
  const lighting = [...new Set([a.lighting, b.lighting].filter((value): value is Exclude<RawPhotoCondition["lighting"], "GOOD"> => value !== "GOOD"))];
  const blurry = a.blurry || b.blurry;
  return {
    orientation, legibility, blurry, lighting,
    clear: orientation === "UPRIGHT" && legibility === "GOOD" && !blurry && lighting.length === 0,
    notes: [a.notes, b.notes].map((note) => note.trim()).filter(Boolean)
  };
}

// Avisos generales para el juez a partir de lo que se VIO en la foto. Vacío si se ve bien o no se evaluó.
export function photoConditionHints(condition?: PhotoCondition): string[] {
  if (!condition || condition.clear) return [];
  const hints: string[] = [];
  const degrees = { ROTATED_90: 90, ROTATED_180: 180, ROTATED_270: 270 } as Record<string, number>;
  if (degrees[condition.orientation]) hints.push(`El texto de la foto se ve girado ${degrees[condition.orientation]}°: léelo en su orientación correcta y no omitas ni reordenes filas por la rotación.`);
  else if (condition.orientation === "UNCLEAR") hints.push("La orientación del texto no es clara: revisa cada fila en su orientación correcta antes de decidir.");
  if (condition.legibility !== "GOOD" || condition.blurry) hints.push("Partes de la foto se ven borrosas o poco legibles: si una letra, número o marca no se distingue con seguridad, no la completes ni la confirmes.");
  if (condition.lighting.length > 0) hints.push("La iluminación no es buena (poca luz, reflejos o luz desigual): no confundas sombras o reflejos con marcas o letras.");
  return hints;
}

// El bloque de avisos que se agrega al final de un prompt (vacío si no hay avisos).
export function hintsBlock(hints: readonly string[]): string {
  return hints.length === 0 ? "" : `\nCondiciones de esta foto (detectadas en el archivo, sin cambiar la imagen):\n${hints.map((hint) => `- ${hint}`).join("\n")}\n`;
}
