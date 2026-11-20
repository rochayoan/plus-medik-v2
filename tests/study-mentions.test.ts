import { describe, expect, it } from "vitest";
import { splitStudyMentions } from "../src/study-mentions.js";

// Cómo escriben los pacientes una lista de estudios (mensajes reales del 4 al 12 de noviembre y sus variantes): cada estudio debe quedar como UNA mención.

const split = (text: string, known: string[] = []) => splitStudyMentions(text, { isKnownName: (name) => known.includes(name) });

describe("separadores", () => {
  it.each([
    ["hemograma, glucosa y creatinina", ["hemograma", "glucosa", "creatinina"]],
    ["hemograma\nglucosa\ncreatinina", ["hemograma", "glucosa", "creatinina"]],
    ["- urea\n- acido urico\n• tsh", ["urea", "acido urico", "tsh"]],
    ["1. hemograma\n2) glucosa\n3- creatinina", ["hemograma", "glucosa", "creatinina"]],
    ["1. hemograma 2. glucosa 3. creatinina", ["hemograma", "glucosa", "creatinina"]],
    ["hemograma + glucosa / creatinina; urea", ["hemograma", "glucosa", "creatinina", "urea"]],
    ["hemograma - glucosa - urea", ["hemograma", "glucosa", "urea"]],
    ["glucosa o hemoglobina glicosilada", ["glucosa", "hemoglobina glicosilada"]],
    ["ferritina e hierro serico", ["ferritina", "hierro serico"]],
    ["Precio de los examen. Testosterona Total y Libre .", ["testosterona total", "testosterona libre"]]
  ])("«%s»", (text, expected) => {
    expect(split(text)).toEqual(expected);
  });
});

describe("la palabra común se reparte entre sus variantes (nunca se busca «libre», «c» o «igm» sueltos)", () => {
  it.each([
    ["Testosterona Total y Libre", ["testosterona total", "testosterona libre"]],
    ["PSA total y libre", ["psa total", "psa libre"]],
    ["bilirrubina total y directa", ["bilirrubina total", "bilirrubina directa"]],
    ["hepatitis b y c", ["hepatitis b", "hepatitis c"]],
    ["hepatitis a, b y c", ["hepatitis a", "hepatitis b", "hepatitis c"]],
    ["toxoplasma igg e igm", ["toxo igg", "toxo igm"]],
    ["Clamidia igg-igm", ["clamidia igg", "clamidia igm"]],
    ["rubeola igg/igm", ["rubeola igg", "rubeola igm"]],
    ["rubeola igg igm", ["rubeola igg", "rubeola igm"]],
    ["PSA total libre", ["psa total", "psa libre"]],
    ["colesterol total, hdl y ldl", ["colesterol total", "colesterol hdl", "colesterol ldl"]],
    ["glucosa en ayunas y postprandial", ["glucosa en ayunas", "glucosa postprandial"]],
    ["creatinina en sangre y en orina", ["creatinina en sangre", "creatinina en orina"]],
    ["zinc serico o plasmatico", ["zinc serico", "zinc plasmatico"]]
  ])("«%s»", (text, expected) => {
    expect(split(text)).toEqual(expected);
  });
  it("«orina» sola es un estudio, no una variante del anterior", () => {
    expect(split("hemograma y orina")).toEqual(["hemograma", "orina"]);
  });
  it("estudios distintos no heredan nada: «vitamina d y b12», «tsh, t4 libre y t3»", () => {
    expect(split("vitamina d y b12")).toEqual(["vitamina d", "b12"]);
    expect(split("tsh, t4 libre y t3")).toEqual(["tsh", "t4 libre", "t3"]);
  });
});

describe("nombres largos, abreviaturas y relleno", () => {
  it.each([
    ["Psa antigueno prostático específico total", ["psa total"]],
    ["Antígeno prostático específico libre", ["psa libre"]],
    ["Vph", ["hpv"]],
    ["virus del papiloma humano", ["hpv"]],
    ["Labo de nivel de zinc", ["zinc"]],
    ["nivel de zinc", ["zinc"]],
    ["dosaje de acido valproico", ["acido valproico"]],
    ["examen de orina por favor", ["orina"]]
  ])("«%s»", (text, expected) => {
    expect(split(text)).toEqual(expected);
  });
  it("la charla alrededor no es un estudio", () => {
    expect(split("Buenas tardes, quisiera saber si realizan el\nLabo de nivel de zinc y el\nCosto porfa")).toEqual(["zinc"]);
    expect(split("Buenas tarde disculpe quisiera saber cuándo me cuestan estos laboratorios.\nSi me los pudiera dar con los precios detallados \nGracias").length).toBeLessThanOrEqual(3);
  });
});

describe("un nombre que el catálogo conoce entero no se corta", () => {
  it("«bilirrubina total y fracciones», «grupo sanguineo y factor rh», «herpes 1 y 2 igg»", () => {
    expect(split("bilirrubina total y fracciones", ["bilirrubina total y fracciones"])).toEqual(["bilirrubina total y fracciones"]);
    expect(split("hemograma, grupo sanguineo y factor rh", ["grupo sanguineo y factor rh"])).toEqual(["hemograma", "grupo sanguineo y factor rh"]);
    expect(split("herpes 1 y 2 igg", ["herpes 1 y 2 igg"])).toEqual(["herpes 1 y 2 igg"]);
  });
  it("un panel nombrado sigue siendo una sola mención", () => {
    expect(split("perfil lipidico")).toEqual(["perfil lipidico"]);
    expect(split("perfil tiroideo y hemograma")).toEqual(["perfil tiroideo", "hemograma"]);
  });
});

describe("la lista real de 6 estudios (10-nov)", () => {
  it("cada línea es un estudio", () => {
    expect(split("Hemograma completo\nPsa antigueno prostático específico total\nPsa antigueno prostático libre \nTestosterona \nClamidia igg-igm\nVph"))
      .toEqual(["hemograma completo", "psa total", "psa libre", "testosterona", "clamidia igg", "clamidia igm", "hpv"]);
  });
});
