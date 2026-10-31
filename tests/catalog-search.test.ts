import { describe, expect, it } from "vitest";
import { mentionsKnownStudy, searchCatalog } from "../src/catalog-search.js";
import { CATALOG, COLESTEROL, COLESTEROL_LDL, CREATININA, GLUCOSA, GLUCOSA_POST, HEMOGRAMA, ORINA, TRIGLICERIDOS, TSH_ECLIA, VITAMINA_D_INACTIVA } from "./support/study-catalog.js";

// Búsqueda aproximada en el catálogo: la herramienta del intérprete. Determinista y sin red.

const top = (query: string) => searchCatalog(query, CATALOG)[0];

describe("searchCatalog", () => {
  it("un nombre o alias exacto puntúa 1 y va primero", () => {
    expect(top("glucosa")).toMatchObject({ score: 1 });
    expect(top("glucosa")!.study.id).toBe(GLUCOSA.id);
    expect(top("hemograma completo")!.study.id).toBe(HEMOGRAMA.id);
    expect(top("EGO")!.study.id).toBe(ORINA.id);
    expect(top("Triglicéridos")!.study.id).toBe(TRIGLICERIDOS.id);
  });

  it("tolera errores de ortografía, letras faltantes y plurales", () => {
    expect(top("glucoza")!.study.id).toBe(GLUCOSA.id);
    expect(top("glucoza")!.score).toBeGreaterThan(0.7);
    expect(top("emograma")!.study.id).toBe(HEMOGRAMA.id);
    expect(top("trigliseridos")!.study.id).toBe(TRIGLICERIDOS.id);
    expect(top("hemogramas")!.study.id).toBe(HEMOGRAMA.id);
    expect(top("kolesterol")!.study.id).toBe(COLESTEROL.id);
    expect(top("hemogramacompleto")!.study.id).toBe(HEMOGRAMA.id);
  });

  it("entiende abreviaturas conocidas por los sinónimos", () => {
    expect(top("bh")!.study.id).toBe(HEMOGRAMA.id);
    expect(top("BH")!.score).toBe(1);
    expect(top("biometria hematica")!.study.id).toBe(HEMOGRAMA.id);
  });

  it("ignora palabras de relleno del pedido", () => {
    expect(top("quiero cotizar un hemograma por favor")!.study.id).toBe(HEMOGRAMA.id);
    expect(top("el examen de la glucosa")!.study.id).toBe(GLUCOSA.id);
  });

  it("una consulta corta devuelve varios candidatos para que se decida entre ellos", () => {
    const ids = searchCatalog("glucosa", CATALOG).map((hit) => hit.study.id);
    expect(ids).toEqual(expect.arrayContaining([GLUCOSA.id, GLUCOSA_POST.id]));
    const tsh = searchCatalog("tsh", CATALOG).map((hit) => hit.study.id);
    expect(tsh.length).toBeGreaterThanOrEqual(2);
    expect(tsh).toContain(TSH_ECLIA.id);
    const colesterol = searchCatalog("colesterol", CATALOG).map((hit) => hit.study.id);
    expect(colesterol).toEqual(expect.arrayContaining([COLESTEROL.id, COLESTEROL_LDL.id]));
  });

  it("no inventa: lo que el catálogo no tiene no devuelve nada", () => {
    for (const query of ["tomografia", "resonancia magnetica", "xyzabc", "rayos x", "", "   ", "de la el"]) expect(searchCatalog(query, CATALOG), query).toEqual([]);
    expect(top("creatinina")!.study.id).toBe(CREATININA.id);
  });

  it("nunca devuelve un estudio inactivo", () => {
    expect(searchCatalog("vitamina d", CATALOG).some((hit) => hit.study.id === VITAMINA_D_INACTIVA.id)).toBe(false);
    expect(searchCatalog("vitamina d 25 oh", CATALOG)).toEqual([]);
  });

  it("respeta el límite y el puntaje mínimo, y es determinista", () => {
    expect(searchCatalog("glucosa", CATALOG, { limit: 1 })).toHaveLength(1);
    expect(searchCatalog("colesterol", CATALOG, { minScore: 0.99 }).every((hit) => hit.score >= 0.99)).toBe(true);
    const first = searchCatalog("colesterol", CATALOG).map((hit) => `${hit.study.id}:${hit.score}`);
    const second = searchCatalog("colesterol", CATALOG).map((hit) => `${hit.study.id}:${hit.score}`);
    expect(second).toEqual(first);
  });

  it("el resultado no trae precios en ningún campo que se entregue al modelo", () => {
    const hit = top("hemograma")!;
    expect(Object.keys(hit).sort()).toEqual(["score", "study", "via"]);
  });

  it("una consulta enorme no rompe nada", () => {
    expect(() => searchCatalog("hemograma ".repeat(5000), CATALOG)).not.toThrow();
  });
});

describe("mentionsKnownStudy: puerta barata", () => {
  it("detecta un estudio del catálogo dentro de una frase, aun con errores", () => {
    expect(mentionsKnownStudy("cotizame un hemograma y glucosa", CATALOG)).toBe(true);
    expect(mentionsKnownStudy("necesito la glucoza", CATALOG)).toBe(true);
  });
  it("no se dispara con charla ni con preguntas sin estudios", () => {
    for (const text of ["hola buenas tardes", "gracias por la informacion", "quiero saber si abren hoy", ""]) expect(mentionsKnownStudy(text, CATALOG), text).toBe(false);
  });
});
