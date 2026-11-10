// Un archivo Ogg/Opus ESTRUCTURALMENTE VÁLIDO, como el que WhatsApp entrega en una nota de voz: tres páginas Ogg (cabecera OpusHead con la marca de inicio de flujo, comentarios OpusTags y páginas de audio
// con la marca de fin de flujo), con el CRC de cada página calculado como exige el formato (polinomio 0x04C11DB7, sin reflejo ni XOR final). Los paquetes de audio son silencio de Opus (TOC 0xF8 +
// 0xFF 0xFE: trama CELT de banda completa y 20 ms). Sirve para probar el reconocimiento del formato y que los bytes lleguen intactos; no se decodifica aquí.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

export function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) & 0xff) ^ byte]!) >>> 0;
  return crc >>> 0;
}

const le32 = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
const le16 = (value: number) => [value & 0xff, (value >>> 8) & 0xff];
const text = (value: string) => [...Buffer.from(value, "utf8")];

function page(args: { headerType: number; granule: number; serial: number; sequence: number; packets: number[][] }): number[] {
  const segments: number[] = [];
  for (const packet of args.packets) {
    let remaining = packet.length;
    while (remaining >= 255) {
      segments.push(255);
      remaining -= 255;
    }
    segments.push(remaining);
  }
  const header = [...text("OggS"), 0, args.headerType, ...le32(args.granule), ...le32(0), ...le32(args.serial), ...le32(args.sequence), 0, 0, 0, 0, segments.length, ...segments];
  const body = args.packets.flat();
  const bytes = Uint8Array.from([...header, ...body]);
  const crc = oggCrc(bytes);
  bytes.set(le32(crc), 22);
  return [...bytes];
}

export function buildOggOpus(options: { comment?: string; packets?: number } = {}): Uint8Array<ArrayBuffer> {
  const serial = 0x1234abcd;
  const opusHead = [...text("OpusHead"), 1, 1, ...le16(312), ...le32(48_000), ...le16(0), 0];
  const vendor = text(options.comment ?? "plusmedik-test");
  const opusTags = [...text("OpusTags"), ...le32(vendor.length), ...vendor, ...le32(0)];
  const count = options.packets ?? 40;
  const audio = Array.from({ length: count }, () => [0xf8, 0xff, 0xfe]);
  const pages = [
    page({ headerType: 0x02, granule: 0, serial, sequence: 0, packets: [opusHead] }),
    page({ headerType: 0x00, granule: 0, serial, sequence: 1, packets: [opusTags] }),
    page({ headerType: 0x04, granule: 960 * count, serial, sequence: 2, packets: audio })
  ].flat();
  return Uint8Array.from(pages);
}

// Lee las páginas de un flujo Ogg y comprueba su CRC. Devuelve las páginas (tipo de cabecera y primer paquete) o lanza si algo no cuadra.
export function parseOgg(bytes: Uint8Array): Array<{ headerType: number; sequence: number; granule: number; firstPacket: Uint8Array }> {
  const pages: Array<{ headerType: number; sequence: number; granule: number; firstPacket: Uint8Array }> = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (Buffer.from(bytes.slice(offset, offset + 4)).toString("latin1") !== "OggS") throw new Error(`sin OggS en ${offset}`);
    const segmentCount = bytes[offset + 26]!;
    const segments = [...bytes.slice(offset + 27, offset + 27 + segmentCount)];
    const bodyLength = segments.reduce((sum, value) => sum + value, 0);
    const end = offset + 27 + segmentCount + bodyLength;
    const copy = Uint8Array.from(bytes.slice(offset, end));
    const stored = new DataView(copy.buffer).getUint32(22, true);
    copy.set([0, 0, 0, 0], 22);
    if (oggCrc(copy) !== stored) throw new Error(`CRC inválido en la página que empieza en ${offset}`);
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const firstLength = segments[0] === 255 ? bodyLength : segments[0]!;
    pages.push({ headerType: bytes[offset + 5]!, sequence: view.getUint32(18, true), granule: Number(view.getBigUint64(6, true)), firstPacket: bytes.slice(offset + 27 + segmentCount, offset + 27 + segmentCount + firstLength) });
    offset = end;
  }
  return pages;
}
