import type { Produced, TurnContext } from "./guarded-turn.js";
import type { IncomingTurn } from "./turns.js";

// Buffering nativo de Kapso (lotes de 15 s: batch:true + data[]). Kapso ya agrupa los mensajes; aquí NO hay otro buffer ni espera: solo se interpreta lo que llegó junto.
// Los mensajes del MISMO contacto dentro de un lote son UNA solicitud con UNA respuesta:
//   · varios textos seguidos se leen como un solo texto (en el orden en que se escribieron), salvo «listo», «cancelar», «sí», «no» o el número de una opción, que se quedan solos
//     porque solo significan algo como mensaje completo;
//   · las fotos siguen siendo un turno cada una (cada una conserva su análisis, su deduplicación y su cotización);
//   · todas las respuestas del lote salen en UN solo mensaje, enviado por el último turno (ver mergeProduced).
// Con un solo mensaje por contacto nada de esto aplica y el flujo es exactamente el de siempre.

// Un turno del lote para el procesamiento: el turno efectivo (puede ser la unión de varios textos) y los mensajes originales que lo forman, en orden. El último miembro es el «líder»:
// su messageId identifica el turno efectivo ante la auditoría; los demás miembros solo se reclaman (deduplicación) y se cierran sin respuesta.
export interface BatchUnit {
  turn: IncomingTurn;
  members: IncomingTurn[];
}

// Separa los turnos por contacto conservando el orden de llegada dentro de cada uno (y el orden en que aparece cada contacto por primera vez).
export function groupByContact<T extends { from: string }>(items: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.from);
    if (group) group.push(item);
    else groups.set(item.from, [item]);
  }
  return [...groups.values()];
}

// Une los textos seguidos del contacto en uno solo. `standalone(text)` marca los textos que no se unen (comandos y respuestas cortas de una solicitud abierta): cada uno corta la serie
// de textos que lo precede. Las fotos no cortan la serie. El texto unido toma el lugar del ÚLTIMO texto de su serie (así, en una sesión, es el que resume todo lo anotado), con su
// messageId e instante. El resultado conserva el orden de los turnos.
export function mergeContactTurns(turns: readonly IncomingTurn[], standalone: (text: string) => boolean): BatchUnit[] {
  const isMergeable = (turn: IncomingTurn) => turn.kind === "TEXT" && typeof turn.text === "string" && !standalone(turn.text);
  // Serie de cada texto unible: la serie cambia después de cada texto solitario.
  let run = 0;
  const runOf = new Map<IncomingTurn, number>();
  const runs = new Map<number, IncomingTurn[]>();
  for (const turn of turns) {
    if (turn.kind === "TEXT" && typeof turn.text === "string" && standalone(turn.text)) {
      run++;
      continue;
    }
    if (!isMergeable(turn)) continue;
    runOf.set(turn, run);
    const members = runs.get(run) ?? [];
    members.push(turn);
    runs.set(run, members);
  }
  const units: BatchUnit[] = [];
  for (const turn of turns) {
    const seriesId = runOf.get(turn);
    if (seriesId === undefined) {
      units.push({ turn, members: [turn] });
      continue;
    }
    const members = runs.get(seriesId)!;
    if (members[members.length - 1] !== turn) continue; // se emite en el lugar del último de su serie
    units.push({ turn: members.length === 1 ? turn : { ...turn, text: members.map((member) => member.text).join("\n") }, members });
  }
  return units;
}

// Las respuestas de varios turnos de un mismo contacto se envían como UN mensaje. Reglas:
//   · un acuse o pregunta de la sesión de cotización («anoté tu foto», «¿cuál de estas?») se descarta solo si otro acuse/pregunta de la sesión o una cotización MÁS NUEVA del lote ya recoge el estado completo;
//   · una respuesta GENÉRICA (la que solo pide escribir los estudios o enviar la receta: saludo, «con gusto te ayudo a cotizar», «¿sobre qué quieres saber?») se descarta si el lote trae cualquier otra
//     cosa más concreta —resumen de la solicitud, pregunta, cotización, aviso médico, atención humana, error—, lleguen antes o después: esa instrucción ya está resuelta. Si todo lo que hay es genérico, sale
//     solo la última (la más reciente), no varias;
//   · todo lo demás se conserva, en orden (cotizaciones, respuestas de conocimiento, avisos de foto ilegible, aviso técnico), sin repetir textos idénticos;
//   · el tipo de resultado es el de más peso (una cotización siempre manda); la respuesta nunca se descarta por «obsoleta» si lleva una cotización.
// `included[i]` indica si lo que produjo el turno i quedó dentro del mensaje.
const MAX_MESSAGE_CHARS = 3900;
const isSessionAck = (produced: Extract<Produced, { kind: "reply" }>) => produced.signature?.startsWith("QUOTE_") === true;

export function mergeProduced(items: readonly Produced[]): { produced: Produced; included: boolean[] } {
  const included = items.map(() => false);
  const replies = items.flatMap((produced, index) => (produced.kind === "reply" ? [{ produced, index }] : []));
  if (replies.length === 0) return { produced: { kind: "none" }, included };

  // Un acuse o pregunta de la sesión solo se descarta si lo sustituye una respuesta MÁS NUEVA que recoge el estado completo de la sesión (otro acuse/pregunta de la sesión o una cotización).
  // Si lo único que sigue es otra cosa (p. ej. una respuesta de información), la pregunta pendiente se conserva: si no, el paciente nunca vería las opciones.
  const coversSession = (produced: Extract<Produced, { kind: "reply" }>) => isSessionAck(produced) || produced.result === "quoted";
  const afterAcks = replies.filter((reply, position) => !(isSessionAck(reply.produced) && replies.slice(position + 1).some((later) => coversSession(later.produced))));
  // Lo genérico solo se queda si no hay nada más concreto; y entonces, solo lo más reciente.
  const concrete = afterAcks.filter((reply) => reply.produced.generic !== true);
  const afterGeneric = concrete.length > 0 ? concrete : afterAcks.slice(-1);
  let kept = afterGeneric;
  // Sin repetir el mismo texto (p. ej. varios avisos idénticos de «tipo de mensaje no soportado»).
  const seen = new Set<string>();
  kept = kept.filter((reply) => {
    const key = reply.produced.body.trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Tope de WhatsApp: si no cabe todo, se descartan primero los mensajes que no son cotizaciones (los más antiguos antes); una cotización nunca se recorta.
  const length = (list: typeof kept) => list.reduce((sum, reply) => sum + reply.produced.body.length + 2, 0);
  while (kept.length > 1 && length(kept) > MAX_MESSAGE_CHARS) {
    const droppable = kept.findIndex((reply) => reply.produced.result !== "quoted");
    if (droppable < 0) break;
    kept = kept.filter((_, position) => position !== droppable);
  }
  for (const reply of kept) included[reply.index] = true;
  // Lo que se descartó por repetido sigue «incluido»: su mismo texto ya va en el mensaje. Lo que se descartó por el tope de longitud o por un acuse sustituido, no.
  const keptBodies = new Set(kept.map((reply) => reply.produced.body.trim()));
  for (const reply of afterGeneric) if (!included[reply.index] && keptBodies.has(reply.produced.body.trim())) included[reply.index] = true;

  if (kept.length === 1) return { produced: kept[0]!.produced, included };

  const parts = kept.map((reply) => reply.produced);
  const result = parts.some((p) => p.result === "quoted") ? "quoted"
    : parts.every((p) => p.result === "technical_issue") ? "technical_issue"
    : parts.some((p) => p.result === "conversation") ? "conversation"
    : parts[parts.length - 1]!.result;
  const signature = [...parts].reverse().find((p) => p.signature)?.signature;
  return {
    produced: {
      kind: "reply",
      body: parts.map((p) => p.body.trim()).join("\n\n"),
      result,
      processingStatus: parts.some((p) => p.processingStatus === "FAILED") ? "FAILED" : "COMPLETED",
      // Una cotización o un aviso que no admite descarte (stale NONE) obliga a enviar el mensaje completo.
      stale: parts.some((p) => (p.stale ?? "NONE") === "NONE") ? "NONE" : "NEWER_TURN",
      // Solo es «silenciosa» si TODO lo que lleva lo es (varios audios fallidos juntos); con algo más, el aviso se conserva.
      ...(parts.every((p) => p.quiet === true) ? { quiet: true as const } : {}),
      ...(signature ? { signature } : {})
    },
    included
  };
}

// El turno que RESPONDE el lote no puede cerrar su propia corrida mientras haya respuestas de los demás por enviar: una corrida cerrada («sin respuesta», foto descartada) ya no admite la
// reserva de envío y esas respuestas se perderían (p. ej. foto + «gracias»). Sus cierres se aplazan: si al final el lote no tiene nada que enviar se aplican tal cual; si lo tiene, se
// omiten (la corrida termina con la reserva y el envío). Los demás registros (evidencia, sesión, fallo, rastro) se escriben de inmediato, como siempre.
const DEFERRED_STAGES: ReadonlySet<string> = new Set(["close", "image"]);

export function deferClosing(ctx: TurnContext): { ctx: TurnContext; flush(): Promise<void> } {
  const deferred: Array<() => Promise<boolean>> = [];
  return {
    ctx: {
      ...ctx,
      persist(stage, action) {
        if (!ctx.guarded || !DEFERRED_STAGES.has(stage)) return ctx.persist(stage, action);
        deferred.push(() => ctx.persist(stage, action));
        return Promise.resolve(true);
      }
    },
    async flush() {
      for (const apply of deferred.splice(0)) await apply();
    }
  };
}
