import { describe, expect, it } from "vitest";
import { looksLikeList, resolvePastedList, splitPastedList } from "@/lib/paste";
import { createStudySearch } from "@/lib/search";
import { studies } from "./fixtures";

const search = createStudySearch(studies);
const ids = (query: string, limit?: number) => search.search(query, limit).map((study) => study.id);

describe("búsqueda local", () => {
  it("encuentra por prefijo mientras se escribe", () => {
    expect(ids("hemo")).toEqual(expect.arrayContaining(["hemo", "hba1c"]));
    expect(ids("glic")[0]).toBe("gli");
  });

  it("una sigla o alias exacto va primero", () => {
    expect(ids("tsh")[0]).toBe("tsh");
    expect(ids("BUN")[0]).toBe("ure");
    expect(ids("TGO")[0]).toBe("got");
  });

  it("ignora tildes, mayúsculas y puntuación", () => {
    expect(ids("TRIGLICÉRIDOS")[0]).toBe("tri");
    expect(ids("perfil lipídico")[0]).toBe("lip");
  });

  it("varias palabras acotan el resultado", () => {
    expect(ids("hemoglobina glic")[0]).toBe("hba1c");
    expect(ids("transaminasa alt")[0]).toBe("gpt");
  });

  it("busca por código", () => {
    expect(ids("HEM01")[0]).toBe("hemo");
  });

  it("tolera errores de tipeo en palabras largas", () => {
    expect(ids("creatinna")).toContain("cre");
  });

  it("un alias compartido devuelve todos los estudios que lo usan", () => {
    expect(ids("pcr").slice(0, 2).sort()).toEqual(["pcr-a", "pcr-b"]);
  });

  it("consulta vacía no devuelve nada y respeta el límite", () => {
    expect(ids("   ")).toEqual([]);
    expect(ids("t", 3)).toHaveLength(3);
  });
});

describe("pegar lista", () => {
  it("separa por líneas, comas, punto y coma y viñetas, quitando numeración y repetidos", () => {
    expect(splitPastedList("1. Hemograma\n2) Glicemia; TSH, tsh\n• Perfil lipídico.\n- EGO")).toEqual([
      "Hemograma", "Glicemia", "TSH", "Perfil lipídico", "EGO"
    ]);
  });

  it("no separa por barra: GOT/GPT queda como un texto", () => {
    expect(splitPastedList("GOT/GPT, urea")).toEqual(["GOT/GPT", "urea"]);
  });

  it("detecta cuándo un pegado es una lista y no una búsqueda", () => {
    expect(looksLikeList("hemograma, glicemia")).toBe(true);
    expect(looksLikeList("hemograma completo")).toBe(false);
  });

  it("lo exacto (nombre o alias) entra seguro; lo demás ofrece opciones; lo inexistente se marca", () => {
    const items = resolvePastedList("hemograma\nglucosa\npcr\ncolest\nxyzzy", studies, search);
    expect(items).toEqual([
      { kind: "sure", text: "hemograma", studyId: "hemo" },
      { kind: "sure", text: "glucosa", studyId: "gli" },
      { kind: "choose", text: "pcr", candidateIds: ["pcr-a", "pcr-b"] },
      { kind: "choose", text: "colest", candidateIds: expect.arrayContaining(["col"]) },
      { kind: "not_found", text: "xyzzy" }
    ]);
  });

  it("un prefijo nunca se da por seguro aunque haya un solo candidato", () => {
    const [item] = resolvePastedList("creatin", studies, search);
    expect(item).toEqual({ kind: "choose", text: "creatin", candidateIds: ["cre"] });
  });
});
