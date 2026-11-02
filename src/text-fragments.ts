import { normalizeStudyKey } from "./consensus.js";
import { extractStudyRequests, parseSessionCommand, parseSessionReply } from "./quote-session.js";
import { classifyText } from "./text-handler.js";
import type { BatchUnit } from "./turn-batch.js";
import type { CatalogStudy } from "./types.js";

// Nombres de estudios partidos entre mensajes de un mismo lote de Kapso: «hemograma» + «completo», «glucosa» + «en ayunas», «creatinina» + «en orina».
//
// Cada mensaje de texto se interpreta por separado (así «glucosa», «tsh» y «listo» conservan su camino), pero un fragmento que por sí solo no dice nada («completo») queda huérfano: no es un estudio
// y se contesta como una pregunta suelta o, con el intérprete, como algo «sin resolver». Aquí se reconstruye el nombre ANTES de interpretar, con una regla estricta que evita unir intenciones distintas.
//
// Se une el fragmento siguiente al anterior SOLO si se cumplen TODAS estas condiciones:
//   1. ambos son textos sueltos y contiguos del lote (una foto entre medio, o un mensaje de otro tipo, lo impide);
//   2. ninguno es un comando o respuesta de la solicitud («listo», «cancelar», «sí», «no», «2»), ni habla de salud, pide a una persona, pregunta por información o saluda;
//   3. el fragmento siguiente es corto y por sí solo NO reconoce ningún estudio (ni uno ni varios posibles);
//   4. al unirlos, el catálogo reconoce un estudio cuyo nombre (o alias) CONTIENE todas las palabras del fragmento: el fragmento es parte del nombre de ese estudio y no otra cosa;
//   5. unir no pierde ningún estudio que el mensaje anterior ya identificaba por sí solo ni agrega nada sin resolver.
// Si algo falla (o el catálogo no se puede leer) no se une nada y todo sigue como antes. El texto unido lleva un espacio entre fragmentos (no un salto de línea: eso se leería como dos estudios).

const MAX_FRAGMENT_WORDS = 4;
// Palabras de enlace que no cuentan como contenido del fragmento («en ayunas», «de orina»).
const LINKING = new Set(["en", "de", "del", "la", "el", "los", "las", "y", "e", "con", "para", "por", "un", "una", "al", "a"]);

const words = (text: string): string[] => normalizeStudyKey(text).split(" ").filter(Boolean);
const contentWords = (text: string): string[] => words(text).filter((word) => !LINKING.has(word));

// Un texto que no puede ser parte de un nombre de estudio: comandos, respuestas de la solicitud y mensajes que van por otro camino.
function isOtherIntent(text: string): boolean {
  if (parseSessionCommand(text) || parseSessionReply(text)) return true;
  const category = classifyText(text);
  return category === "MEDICAL" || category === "HUMAN_REQUEST" || category === "INFO_REQUEST" || category === "GREETING";
}

function recognisedStudies(text: string, catalog: readonly CatalogStudy[]): { studies: CatalogStudy[]; unresolved: number; matchedIds: Set<string> } | undefined {
  const extraction = extractStudyRequests(text, catalog);
  if (!extraction) return undefined;
  const byId = new Map(catalog.map((study) => [study.id, study]));
  const studies = new Map(extraction.matched.map((study) => [study.id, study] as const));
  for (const group of extraction.result.ambiguous) for (const id of group) if (byId.has(id)) studies.set(id, byId.get(id)!);
  return { studies: [...studies.values()], unresolved: extraction.result.unresolved, matchedIds: new Set(extraction.matched.map((study) => study.id)) };
}

// ¿«next» es la continuación del nombre de un estudio que empezó en «current»? Función pura sobre el catálogo.
export function continuesStudyName(current: string, next: string, catalog: readonly CatalogStudy[]): boolean {
  const fragment = contentWords(next);
  if (fragment.length === 0 || words(next).length > MAX_FRAGMENT_WORDS) return false;
  if (isOtherIntent(current) || isOtherIntent(next)) return false;
  // el fragmento siguiente, solo, no reconoce nada: si ya fuera un estudio (o varios posibles) sería una petición propia y no se toca
  const alone = recognisedStudies(next, catalog);
  if (alone && alone.studies.length > 0) return false;

  const joined = recognisedStudies(`${current} ${next}`, catalog);
  if (!joined || joined.studies.length === 0) return false;
  // el fragmento es parte del nombre (o alias) de un estudio reconocido al unirlos
  const nameWords = new Set(joined.studies.flatMap((study) => [study.normalizedName, ...study.normalizedAliases].flatMap(words)));
  if (!fragment.every((word) => nameWords.has(word))) return false;
  // unir no pierde lo que el mensaje anterior ya identificaba, ni deja nada sin resolver que antes no lo estuviera
  const before = recognisedStudies(current, catalog);
  if (before && ![...before.matchedIds].every((id) => joined.matchedIds.has(id))) return false;
  if (joined.unresolved > (before?.unresolved ?? 0)) return false;
  return true;
}

const isLoneText = (unit: BatchUnit): boolean => unit.turn.kind === "TEXT" && typeof unit.turn.text === "string" && unit.members.length === 1;

// Reconstruye los nombres partidos entre unidades de texto contiguas de un contacto. Devuelve las mismas unidades, con las que se unieron convertidas en una sola (el último fragmento es el líder, como en
// mergeContactTurns). El catálogo solo se pide si hay al menos dos textos sueltos contiguos.
export async function joinStudyFragments(units: readonly BatchUnit[], loadCatalog: () => Promise<readonly CatalogStudy[]>): Promise<BatchUnit[]> {
  const adjacent = units.some((unit, index) => index > 0 && isLoneText(unit) && isLoneText(units[index - 1]!));
  if (!adjacent) return [...units];
  let catalog: readonly CatalogStudy[];
  try {
    catalog = await loadCatalog();
  } catch {
    return [...units];
  }
  const out: BatchUnit[] = [];
  for (const unit of units) {
    const previous = out[out.length - 1];
    if (previous && isLoneTextOrJoined(previous) && isLoneText(unit)) {
      const current = previous.turn.text!;
      let joins = false;
      try {
        joins = continuesStudyName(current, unit.turn.text!, catalog);
      } catch {
        joins = false;
      }
      if (joins) {
        out[out.length - 1] = { turn: { ...unit.turn, text: `${current} ${unit.turn.text}` }, members: [...previous.members, ...unit.members] };
        continue;
      }
    }
    out.push(unit);
  }
  return out;
}

// Un texto ya unido sigue siendo un texto (varios miembros) y puede seguir creciendo con otro fragmento.
const isLoneTextOrJoined = (unit: BatchUnit): boolean => unit.turn.kind === "TEXT" && typeof unit.turn.text === "string";
