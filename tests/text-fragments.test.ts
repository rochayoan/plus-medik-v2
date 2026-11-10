import { describe, expect, it, vi } from "vitest";
import { normalizeStudyKey } from "../src/consensus.js";
import { continuesStudyName, joinStudyFragments } from "../src/text-fragments.js";
import { mergeContactTurns } from "../src/turn-batch.js";
import type { IncomingTurn } from "../src/turns.js";
import type { CatalogStudy } from "../src/types.js";

// Nombres de estudios partidos entre mensajes de un mismo lote de Kapso («quiero cotizar» + «hemograma» + «completo»): se reconstruyen ANTES de interpretar, pero solo cuando el fragmento es parte del
// nombre de un estudio. Lo que NO se debe unir (comandos, salud, otra intención, estudios que ya se reconocen solos) es la mitad de estas pruebas.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const study = (n: number, name: string, aliases: string[], priceBs: number): CatalogStudy => ({ id: uuid(n), code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active: true });
const catalog: CatalogStudy[] = [
  study(1, "HEMOGRAMA COMPLETO", ["hemograma"], 45),
  study(2, "GLUCOSA EN AYUNAS", ["glucosa"], 30.5),
  study(3, "COLESTEROL TOTAL", ["colesterol"], 25),
  study(4, "TSH", ["tsh"], 80),
  study(7, "CREATININA SERICA", ["creatinina"], 20),
  study(8, "CREATININA EN ORINA", ["creatinina"], 22)
];

describe("continuesStudyName: cuándo un fragmento es la continuación del nombre de un estudio", () => {
  it.each([
    // el caso real y sus variantes
    ["hemograma", "completo"],
    ["Hemograma", "Completo!"],
    ["glucosa", "en ayunas"],
    ["quiero cotizar hemograma", "completo"],
    ["colesterol", "total"],
    // la unión también aclara una ambigüedad: «creatinina» podía ser dos estudios
    ["creatinina", "en orina"],
    ["creatinina", "sérica"]
  ])("«%s» + «%s» -> se unen", (current, next) => {
    expect(continuesStudyName(current, next, catalog)).toBe(true);
  });

  it.each([
    // el fragmento siguiente ya reconoce un estudio por sí solo: es otra petición
    ["quiero cotizar", "hemograma"],
    ["hemograma", "glucosa"],
    ["hemograma", "y glucosa"],
    ["glucosa", "hemograma completo"],
    ["hemograma", "creatinina"],
    // comandos y respuestas de la solicitud abierta: nunca se pegan a un estudio
    ["hemograma", "listo"],
    ["hemograma", "eso es todo"],
    ["hemograma", "cancelar"],
    ["hemograma", "sí"],
    ["hemograma", "no"],
    ["hemograma", "2"],
    ["listo", "completo"],
    ["sí", "completo"],
    // otras intenciones: salud, una persona, información, cortesía, saludo
    ["glucosa", "me duele el pecho"],
    ["hemograma", "quiero hablar con una persona"],
    ["hemograma", "¿a qué hora abren?"],
    ["hemograma", "gracias"],
    ["hola", "completo"],
    ["hemograma", "hola"],
    // el fragmento no es parte del nombre de ningún estudio reconocido
    ["tsh", "completo"],
    ["quiero cotizar", "completo"],
    ["hemograma", "urgente"],
    // sin el enlace «en» el catálogo no reconoce «glucosa ayunas»: no se adivina nada
    ["glucosa", "ayunas"],
    ["hemograma", "completo por favor para el lunes"],
    ["hemograma", ""],
    ["hemograma", "en"],
    ["hemograma", "..."]
  ])("«%s» + «%s» -> NO se unen", (current, next) => {
    expect(continuesStudyName(current, next, catalog)).toBe(false);
  });

  it("unir nunca hace perder un estudio que el mensaje anterior ya identificaba", () => {
    // «glucosa tsh» ya identifica dos estudios; «completo» no pertenece a ninguno de los dos
    expect(continuesStudyName("glucosa tsh", "completo", catalog)).toBe(false);
  });

  it("con un catálogo vacío no se une nada", () => {
    expect(continuesStudyName("hemograma", "completo", [])).toBe(false);
  });
});

describe("joinStudyFragments: las unidades de texto contiguas de un lote", () => {
  const text = (messageId: string, body: string, overrides: Partial<IncomingTurn> = {}): IncomingTurn => ({ messageId, from: "59170000000", kind: "TEXT", text: body, ...overrides });
  const image = (messageId: string): IncomingTurn => ({ messageId, from: "59170000000", kind: "IMAGE", mediaId: `media-${messageId}` });
  // como en modo sesión: cada texto es su propia unidad
  const unitsOf = (...turns: IncomingTurn[]) => mergeContactTurns(turns, () => true);
  const load = () => Promise.resolve(catalog);

  it("el caso real: «quiero cotizar» + «hemograma» + «completo» -> «quiero cotizar» queda aparte y «hemograma completo» es UN solo texto, con el último mensaje como líder", async () => {
    const out = await joinStudyFragments(unitsOf(text("m1", "quiero cotizar", { timestamp: 1 }), text("m2", "hemograma", { timestamp: 2 }), text("m3", "completo", { timestamp: 3 })), load);
    expect(out.map((unit) => unit.turn.text)).toEqual(["quiero cotizar", "hemograma completo"]);
    expect(out[1]!.members.map((member) => member.messageId)).toEqual(["m2", "m3"]);
    expect(out[1]!.turn).toMatchObject({ messageId: "m3", kind: "TEXT", timestamp: 3 });
    expect(out[0]!.members.map((member) => member.messageId)).toEqual(["m1"]);
  });

  it("el texto unido lleva un ESPACIO (un salto de línea se leería como dos estudios)", async () => {
    const [unit] = await joinStudyFragments(unitsOf(text("m1", "glucosa"), text("m2", "en ayunas")), load);
    expect(unit!.turn.text).toBe("glucosa en ayunas");
    expect(unit!.turn.text).not.toContain("\n");
  });

  it("un fragmento que sí es otro estudio no se pega: «hemograma» + «completo» + «y glucosa» -> dos solicitudes", async () => {
    const out = await joinStudyFragments(unitsOf(text("m1", "hemograma"), text("m2", "completo"), text("m3", "y glucosa")), load);
    expect(out.map((unit) => unit.turn.text)).toEqual(["hemograma completo", "y glucosa"]);
  });

  it("los comandos quedan solos: «hemograma» + «completo» + «listo» y «hemograma» + «sí»", async () => {
    expect((await joinStudyFragments(unitsOf(text("m1", "hemograma"), text("m2", "completo"), text("m3", "listo")), load)).map((unit) => unit.turn.text)).toEqual(["hemograma completo", "listo"]);
    expect((await joinStudyFragments(unitsOf(text("m1", "hemograma"), text("m2", "sí")), load)).map((unit) => unit.turn.text)).toEqual(["hemograma", "sí"]);
    expect((await joinStudyFragments(unitsOf(text("m1", "hemograma"), text("m2", "listo"), text("m3", "completo")), load)).map((unit) => unit.turn.text)).toEqual(["hemograma", "listo", "completo"]);
  });

  it("una fotografía entre los fragmentos impide la unión (no son contiguos) y la foto conserva su lugar", async () => {
    const out = await joinStudyFragments(unitsOf(text("m1", "hemograma"), image("p2"), text("m3", "completo")), load);
    expect(out.map((unit) => unit.turn.kind)).toEqual(["TEXT", "IMAGE", "TEXT"]);
    expect(out.map((unit) => unit.members.length)).toEqual([1, 1, 1]);
  });

  it("textos con otras intenciones se quedan como están", async () => {
    const out = await joinStudyFragments(unitsOf(text("m1", "glucosa"), text("m2", "me duele el pecho"), text("m3", "completo")), load);
    expect(out.map((unit) => unit.turn.text)).toEqual(["glucosa", "me duele el pecho", "completo"]);
  });

  it("un mensaje por contacto o sin textos contiguos NO consulta el catálogo", async () => {
    const spy = vi.fn(load);
    await joinStudyFragments(unitsOf(text("m1", "hemograma")), spy);
    await joinStudyFragments(unitsOf(text("m1", "hemograma"), image("p2")), spy);
    expect(spy).not.toHaveBeenCalled();
  });

  it("si el catálogo no se puede leer no se une nada y todo sigue como antes", async () => {
    const out = await joinStudyFragments(unitsOf(text("m1", "hemograma"), text("m2", "completo")), () => Promise.reject(new Error("sin catálogo")));
    expect(out.map((unit) => unit.turn.text)).toEqual(["hemograma", "completo"]);
  });

  it("no muta las unidades recibidas", async () => {
    const units = unitsOf(text("m1", "hemograma"), text("m2", "completo"));
    const snapshot = JSON.stringify(units);
    await joinStudyFragments(units, load);
    expect(JSON.stringify(units)).toBe(snapshot);
  });
});
