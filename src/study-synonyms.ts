import { normalizeStudyKey } from "./consensus.js";

// Nombres habituales, abreviaturas y sinónimos de estudios que un paciente escribe (G5.9). Cada GRUPO reúne frases que los laboratorios usan para nombrar lo mismo: «bh» = «biometría hemática» =
// «hemograma». El grupo NO es un estudio: es una lista de frases para BUSCAR en el catálogo. Quien decide qué estudio es (y cuánto cuesta) sigue siendo lab_tests:
//   · cada frase se busca con el mismo resolvedor EXACTO del motor (nombre o alias aprobado de un estudio activo); una frase que el catálogo no tiene no produce nada;
//   · si las frases del grupo llegan a estudios DISTINTOS del catálogo (p. ej. «hemograma» y «hemograma completo» son dos estudios), el resultado es ambiguo y se le pregunta al paciente;
//   · nunca se devuelve un id, un precio ni un nombre: solo frases.
// La lista es una semilla de abreviaturas estándar; el laboratorio la completa mejor con alias aprobados en el catálogo (lab_test_aliases), que el resolvedor ya usa. No hay aquí ninguna
// equivalencia clínica dudosa: ante la duda la frase NO se incluye («examen de orina» o «heces» nombran estudios distintos según el laboratorio).
export const STUDY_SYNONYM_GROUPS: ReadonlyArray<readonly string[]> = [
  ["hemograma completo", "hemograma", "biometria hematica", "bh", "cuadro hematico", "hematologia completa"],
  ["glucosa", "glucosa en ayunas", "glucosa basal", "glucosa en sangre", "glicemia", "glucemia", "azucar en sangre"],
  ["tgo", "ast", "got", "aspartato aminotransferasa", "transaminasa glutamico oxalacetica", "transaminasa oxalacetica"],
  ["tgp", "alt", "gpt", "alanina aminotransferasa", "transaminasa glutamico piruvica", "transaminasa piruvica"],
  ["vsg", "vhs", "eritrosedimentacion", "velocidad de sedimentacion globular", "velocidad de sedimentacion"],
  ["examen general de orina", "ego", "uroanalisis", "orina completa", "general de orina"],
  ["urocultivo", "cultivo de orina"],
  ["hemoglobina glicosilada", "hemoglobina glicada", "hba1c", "a1c", "hb a1c"],
  ["acido urico", "uricemia"],
  ["nitrogeno ureico", "bun"],
  ["antigeno prostatico especifico", "antigeno prostatico", "psa"],
  ["perfil lipidico", "perfil de lipidos", "lipidograma"],
  ["tiempo de protrombina", "protrombina", "tp"],
  ["tiempo de tromboplastina parcial", "tiempo parcial de tromboplastina", "tpt", "ttpa"],
  ["grupo sanguineo y factor rh", "grupo sanguineo", "grupo y factor", "grupo sanguineo y rh", "tipificacion sanguinea"],
  ["hormona estimulante de tiroides", "tirotropina", "tsh"],
  ["tiroxina libre", "t4 libre", "t4l"],
  ["proteina c reactiva", "pcr"],
  ["gonadotropina corionica humana", "beta hcg", "bhcg", "hcg"],
  ["colesterol total", "colesterol"],
  ["creatinina serica", "creatinina en sangre", "creatinina sanguinea"],
  ["hierro serico", "sideremia"]
];

const groups: ReadonlyArray<readonly string[]> = STUDY_SYNONYM_GROUPS.map((group) => [...new Set(group.map(normalizeStudyKey))]);
const byPhrase = new Map<string, number[]>();
groups.forEach((group, index) => {
  for (const phrase of group) byPhrase.set(phrase, [...(byPhrase.get(phrase) ?? []), index]);
});

// Las demás frases con las que se nombra lo mismo (ya normalizadas, sin la frase consultada). Vacío si no hay ninguna.
export function synonymsOf(phrase: string): string[] {
  const key = normalizeStudyKey(phrase);
  const out = new Set<string>();
  for (const index of byPhrase.get(key) ?? []) for (const other of groups[index]!) if (other !== key) out.add(other);
  return [...out];
}
