import MiniSearch from "minisearch";
import { normalizeStudyKey } from "@core/consensus";
import type { ClientStudy } from "./catalog-types";

export interface StudySearch {
  search(query: string, limit?: number): ClientStudy[];
}

const tokenize = (text: string): string[] => normalizeStudyKey(text).split(" ").filter(Boolean);

// Índice en memoria del navegador: se construye una vez por catálogo y responde en milisegundos sin tocar el servidor.
export function createStudySearch(studies: ClientStudy[]): StudySearch {
  const byId = new Map(studies.map((study) => [study.id, study]));
  // Coincidencia exacta con nombre normalizado, alias o código: siempre primero.
  const exact = new Map<string, string[]>();
  const addExact = (key: string, id: string) => {
    if (!key) return;
    const ids = exact.get(key) ?? [];
    if (!ids.includes(id)) exact.set(key, [...ids, id]);
  };
  for (const study of studies) {
    addExact(normalizeStudyKey(study.normalizedName || study.name), study.id);
    addExact(normalizeStudyKey(study.name), study.id);
    for (const alias of study.aliases) addExact(normalizeStudyKey(alias), study.id);
    if (study.code) addExact(normalizeStudyKey(study.code), study.id);
  }

  const index = new MiniSearch<{ id: string; name: string; aliases: string; code: string }>({
    fields: ["name", "aliases", "code"],
    tokenize,
    processTerm: (term) => term || null,
    searchOptions: {
      boost: { code: 3, name: 2, aliases: 1.5 },
      prefix: true,
      fuzzy: (term) => (term.length >= 5 ? 0.2 : false)
    }
  });
  index.addAll(studies.map((study) => ({ id: study.id, name: study.name, aliases: study.aliases.join(" "), code: study.code ?? "" })));

  return {
    search(query, limit = 8) {
      const key = normalizeStudyKey(query);
      if (!key) return [];
      const ordered: string[] = [...(exact.get(key) ?? [])];
      // Todas las palabras deben aparecer (prefijo/fuzzy); si nada coincide, se relaja a cualquiera.
      let hits = index.search(key, { combineWith: "AND" });
      if (hits.length === 0) hits = index.search(key, { combineWith: "OR" });
      for (const hit of hits) if (!ordered.includes(hit.id as string)) ordered.push(hit.id as string);
      return ordered.slice(0, limit).map((id) => byId.get(id)!).filter(Boolean);
    }
  };
}
