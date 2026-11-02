# G6.1 · Buffering nativo de Kapso (lotes de 15 s)

Kapso agrupa los mensajes de un contacto durante 15 segundos y los entrega en un solo POST (`batch: true`, `data[]`). El webhook **no agrega ningún otro buffer** (ni espera ni tabla en Supabase): solo interpreta lo que llegó junto.

## Qué hace el webhook con un lote

Dentro de un lote, los mensajes del **mismo contacto** son **una solicitud con una respuesta**:

1. **Deduplicación**: cada mensaje se reclama por su `message.id` (igual que antes). Un lote reentregado no se procesa dos veces.
2. **Textos**:
   - Sin sesiones de cotización, los textos seguidos se leen como un solo texto, en el orden en que se escribieron.
   - Con sesiones de cotización, cada texto conserva su clasificación (un texto médico o de información no se traga los estudios escritos al lado) y todos alimentan la misma sesión.
   - Solo participan los mensajes que esta ejecución reclamó: un duplicado o un claim fallido no se vuelve a leer ni se une a nada.
3. **Fotos**: cada foto conserva su propio análisis, su hash de duplicado y su cotización (o su entrada en la sesión).
4. **Una sola respuesta**: el último turno del lote responde. Los anteriores hacen su trabajo pero no reservan ni envían nada; su contenido se integra en un solo mensaje:
   - las cotizaciones, respuestas de conocimiento, avisos de foto ilegible y el aviso técnico se conservan, sin repetir textos idénticos;
   - los acuses/preguntas de la sesión de cotización («anoté tu foto», «¿cuál de estas opciones?») se descartan solo si otro acuse/pregunta de la sesión o una cotización más nueva del lote recoge el estado completo;
   - el turno que responde no cierra su propia corrida mientras haya respuestas de los demás por enviar (una corrida cerrada ya no admite la reserva de envío): sus cierres se aplazan y solo se aplican si el lote no tiene nada que enviar;
   - el turno que responde empieza DESPUÉS de que terminen los demás mensajes del lote: con sesiones de cotización, «listo» debe encontrar la solicitud ya abierta y sin turnos anteriores en proceso (si empezara a la vez, podría contestar «todavía no tengo estudios anotados»).
5. **Pausa humana**: se comprueba en la única reserva y en la confirmación final, como siempre.
6. **Tope de 5 respuestas cada 24 h**: la base lo aplica en la reserva de envío; un lote entero cuenta **una** respuesta.
7. **Rastro de conocimiento**: las referencias de conocimiento/preparación/datos por estudio se escriben en la corrida que **envía** el mensaje.

Un contacto con un solo mensaje sigue exactamente el flujo anterior.

## Migración 19 (obligatoria antes de desplegar)

`supabase/migrations/20261107000000_plusmedik_batch_fold.sql` agrega UNA función, `plusmedik_turn_fold`. Una corrida con el análisis ya registrado (`ANALYZED`) solo puede terminar enviando su propia respuesta o como fallo; la base prohíbe cerrarla «sin respuesta». Las demás fotos de un lote no envían nada, así que se terminan con `plusmedik_turn_fold`: `COMPLETED`, `send_state = NOT_APPLICABLE`, `error_code = BATCHED`. No envía, no reserva, no cancela un envío y no cuenta para el tope. Un fallo ya registrado se conserva.

Sin la migración aplicada, la llamada falla (se registra `audit_unavailable`) y las corridas de fotos de un lote quedan en `ANALYZED`: las sesiones de cotización las verían como «mensajes anteriores en proceso». Se aplica a mano, como las anteriores (ver `docs/g5/20-g51-aplicacion-de-migraciones.md`).

## Entrega simultánea del mismo lote

Todas las ejecuciones reclaman los mensajes de un contacto en el MISMO orden (el del lote), así que la base (un reclamo atómico por mensaje) concede el primero a una sola. La que lo encuentra ya EN CURSO en otra ejecución (reclamo «BUSY» o «IN_DOUBT») cede el resto de los mensajes de ese contacto y lo registra (`turn_batch_yield`, solo cantidades): la ganadora los atiende todos y responde una sola vez. Un mensaje ya TERMINADO («FINISHED», de una entrega anterior) no cede el grupo: los nuevos del mismo lote se siguen atendiendo. Antes cada ejecución se llevaba una parte de los mensajes y el paciente recibía dos respuestas.

## Propiedades verificadas de la migración 19

Verificadas contra PostgreSQL real con las 18 migraciones anteriores (`tests/batch-fold-db.test.ts`):

- Aditiva: una sola función; no crea, borra ni altera tablas, triggers ni vistas; no toca el esquema `crm`, el catálogo ni otras capas (huella de las demás tablas e instantánea del catálogo de columnas idénticas antes y después).
- Segura: SECURITY DEFINER con `search_path` vacío; solo `service_role` ejecuta (anon, authenticated y public reciben «permission denied»). Exige dueño + fence vigentes: un fence o dueño distintos se rechazan y no cambian nada.
- Idempotente: repetirla no cambia nada (ni `updated_at`); aplicar el archivo varias veces no cambia la función ni los datos.
- Compatible con los estados de una corrida: PROCESSING, ANALYZED, IGNORED y FAILED se cierran sin envío (el fallo y su código se conservan); con el envío reservado, aceptado, cancelado o cerrado no hace nada. Nunca cancela ni habilita un envío; contra la reserva de la misma corrida gana exactamente una.
- Pausa humana: una corrida plegada no cuenta como bloqueada y conserva su marca si la pausa llegó antes; las pendientes siguen bloqueándose y la reserva del turno que responde se deniega.
- Tope diario: una corrida plegada no ocupa cupo; lo ya enviado sigue contando.
- Recuperador y vista de fases: una corrida plegada no es candidata (queda CLOSED_NO_SEND); si el recuperador actuó antes, el plegado se rechaza (lease perdido).
- Sin interbloqueos al plegar, pausar, reservar y recuperar a la vez sobre el mismo contacto (la función bloquea solo la corrida; el orden contacto → corridas de las demás se respeta).

## Dónde está

- `src/turn-batch.ts`: unión de textos y fusión de respuestas (funciones puras).
- `src/turns.ts` (`processTurns`, `processContactBatch`): claim de todos los mensajes y despacho.
- `src/guarded-turn.ts` (`absorb`, `skip`): trabajo sin envío para los turnos que no responden.
- `src/audit.ts` (`foldTurn`) y `supabase/migrations/20261107000000_plusmedik_batch_fold.sql`.
- `api/kapso/webhook.ts`: solo el cableado de `foldTurn`.
- `src/kapso-webhook.ts`: sin cambios (ya leía `batch`/`data[]`).

## Fuera de alcance

- Los contactos que quedan fuera de la puerta del piloto (solo si `PLUSMEDIK_TEXT_PILOT_GUARD` está activa) siguen en la ruta anterior de fotos, sin turnos ni tope.
- Si Kapso entrega el MISMO lote dos veces A LA VEZ, solo UNA ejecución lo atiende y responde una sola vez (ver «Entrega simultánea del mismo lote»). Si la ejecución dueña muere con su lease vigente (hasta ~2 min), los mensajes de ese contacto no se reprocesan hasta que venza: Kapso solo reintenta si no recibe 200 y el webhook responde de inmediato, así que en la práctica no hay quien lo reintente (límite heredado de la política de ACK).
- La evidencia del análisis de cada foto queda en la corrida de esa foto; el mensaje que contiene su cotización lo envía la corrida del último mensaje del lote.
- Si el mensaje combinado supera ~3900 caracteres se descartan primero los textos que no son cotización.
