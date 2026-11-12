import { normalizeStudyKey } from "./consensus.js";

// Temas por los que un paciente suele preguntar sin saber el nombre del estudio («tiroides», «hígado», «anemia»). Cuando el catálogo no tiene un estudio con ese nombre, el agente OFRECE los estudios
// relacionados que SÍ existen en el catálogo (con su precio) para que el paciente elija cuáles necesita; no interpreta síntomas ni diagnostica.
//   · `triggers`: palabras (sin tildes) que nombran el tema. Debe estar la palabra completa en lo que escribió el paciente.
//   · `phrases`: frases para BUSCAR cada estudio en el catálogo (el mismo resolvedor de siempre): lo que el catálogo no tenga no se ofrece; nunca se devuelve un precio ni un id desde aquí.
// Es una semilla de estudios habituales por tema, pendiente de la revisión de la doctora (se puede ampliar o cambiar aquí sin tocar nada más).
export interface StudyTopic {
  name: string;
  triggers: readonly string[];
  phrases: readonly string[];
}

export const STUDY_TOPICS: readonly StudyTopic[] = [
  { name: "tiroides", triggers: ["tiroides", "tiroideo", "tiroidea", "tiroideos", "tiroideas", "tiroidal", "tiroidales"], phrases: ["tsh", "t4 libre", "t3 libre", "anti tpo"] },
  { name: "azúcar", triggers: ["azucar"], phrases: ["glucosa", "hemoglobina glicosilada hb a1c"] },
  { name: "lípidos", triggers: ["lipidos", "lipidico", "lipidica", "lipidograma", "grasas", "grasa"], phrases: ["colesterol total", "colesterol hdl", "colesterol ldl", "trigliceridos"] },
  { name: "hígado", triggers: ["higado", "hepatico", "hepatica", "hepaticas", "hepaticos"], phrases: ["transaminasa got", "transaminasa gpt", "bilirrubina total y fracciones", "fosfatasa alcalina", "ggt"] },
  { name: "riñón", triggers: ["rinon", "rinones", "renal", "renales"], phrases: ["creatinina", "urea", "acido urico", "examen general de orina"] },
  { name: "anemia", triggers: ["anemia"], phrases: ["hemograma completo", "ferritina", "hierro serico"] }
];

const byTrigger = new Map<string, StudyTopic>();
for (const topic of STUDY_TOPICS) for (const trigger of topic.triggers) byTrigger.set(normalizeStudyKey(trigger), topic);

// El tema que nombra un texto corto («tiroides», «los de la tiroides»), o undefined. Un texto largo es una conversación, no el nombre de un tema.
export function topicOf(text: string): StudyTopic | undefined {
  const tokens = normalizeStudyKey(text.slice(0, 120)).split(" ").filter(Boolean);
  if (tokens.length === 0 || tokens.length > 5) return undefined;
  for (const token of tokens) {
    const topic = byTrigger.get(token);
    if (topic) return topic;
  }
  return undefined;
}
