import { availableSections, validateBusinessData, type DataSection } from "./conversation-facts.js";
import { detectTopics, type KnowledgeAnswer } from "./knowledge-answers.js";
import { BUSINESS_DATA } from "./system-prompt.js";

// Datos comerciales que se mantienen por GIT (src/system-prompt.ts → BUSINESS_DATA; ver docs/configuracion/repositorio-sin-aprobacion.md): ubicación (sede, dirección, referencia y mapa) y horario
// GENERAL de atención. La herramienta lab_info del agente los consulta ANTES que la base de conocimiento versionada (G3), que es un mecanismo heredado y puede tener datos más viejos.
// Solo responde lo que está CONFIRMADO y vigente: una sección pendiente o vencida no se usa y la pregunta sigue por el camino de siempre. No toca precios, plazos, preparación ni nada clínico.

const LOCATION_SECTIONS = ["SUCURSALES", "NEGOCIO"] as const;
const HOURS_SECTIONS = ["HORARIOS"] as const;

const sections = (): readonly DataSection[] => validateBusinessData(BUSINESS_DATA).sections;

export function answerFromBusinessData(question: string, now: Date = new Date(), source: readonly DataSection[] = sections()): KnowledgeAnswer | undefined {
  const topics = detectTopics(question);
  const wantsLocation = topics.some((topic) => topic.kind === "LOCATION");
  // Solo el horario GENERAL (oficina): el de la toma de muestras, por ejemplo, no está en estos datos.
  const { usable } = availableSections(source, now);
  const byId = new Map(usable.map((section) => [section.id, section]));
  // «¿Hay que sacar cita?»: el horario general confirmado dice si hace falta; solo se contesta desde aquí si esa sección menciona la cita.
  const appointmentsCovered = /cita/i.test(byId.get("HORARIOS")?.text ?? "");
  const isAppointments = (topic: (typeof topics)[number]) => topic.kind === "POLICY" && topic.topic === "APPOINTMENTS";
  const wantsHours = topics.some((topic) => (topic.kind === "HOURS" && topic.service === "OFFICE") || (isAppointments(topic) && appointmentsCovered));
  // Cualquier otro tema pedido en el mismo mensaje (pagos, políticas, preparación…) sigue por el conocimiento aprobado.
  const others = topics.filter((topic) => topic.kind !== "LOCATION" && !(topic.kind === "HOURS" && topic.service === "OFFICE") && !(isAppointments(topic) && appointmentsCovered));
  if ((!wantsLocation && !wantsHours) || others.length > 0) return undefined;

  const wanted = [...(wantsLocation ? LOCATION_SECTIONS : []), ...(wantsHours ? HOURS_SECTIONS : [])];
  const found = wanted.map((id) => byId.get(id)).filter((section): section is DataSection => section !== undefined);
  // La ubicación necesita al menos la sede; el horario, su sección. Si falta lo principal, no se responde desde aquí.
  if (wantsLocation && !byId.has("SUCURSALES")) return undefined;
  if (wantsHours && !byId.has("HORARIOS")) return undefined;
  if (found.length === 0) return undefined;

  return {
    body: found.map((section) => `${section.title}\n${section.text}`).join("\n\n"),
    refs: [],
    status: "ANSWERED",
    topics: topics.map((topic) => topic.kind),
    unavailable: []
  };
}
