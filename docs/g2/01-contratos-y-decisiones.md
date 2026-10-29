# G2.0 · 01 Contratos y decisiones de diseño

Todo lo de este documento está implementado y probado **solo en local y offline** (PostgreSQL efímero, Kapso y modelos simulados). Nada se aplicó a Supabase ni se activó.

## 1. Modelo: un turno ES una corrida

Un **turno** es un mensaje entrante de un contacto (imagen, texto u otro). No se creó ningún mecanismo paralelo: cada turno es una fila de `plusmedik_audit_runs` y hereda, sin reimplementarlos, el claim atómico, el lease con fencing, la reserva de envío, la comprobación final, la recuperación y la pausa humana de Phase 6. La migración 6 solo agrega lo que **no existía**: orden entre turnos del mismo contacto, exclusión de envíos simultáneos al mismo paciente y descarte de respuestas obsoletas.

```
mensaje entrante ─► beginTurn (claim del turno: lease + número de secuencia del contacto; pausa humana → no se procesa)
                       │  (en un lote: UNO por UNO, en el orden del mensaje)
                       ▼
                 TRABAJO del turno  (imagen: motor de recetas SIN cambios · texto/otro: manejador inyectado)
                       │   produce: nada │ respuesta {cuerpo, tipo, política}
                       ▼
                 reserveSend ─► reserved │ busy (esperar y reintentar, con tope) │ superseded (descartar) │ blocked │ lost │ closed
                       ▼
                 confirmSend (pausa humana, lo más cerca posible de Kapso) ─► proceed
                       ▼
                 sendText (Kapso) ─► recordReply ACCEPTED │ UNKNOWN (jamás se reenvía)
```

## 2. Qué garantiza cada pieza

| Problema | Mecanismo | Dónde | Garantía |
| --- | --- | --- | --- |
| **Mismo mensaje entregado dos veces** (reintento de Kapso, doble webhook) | Claim atómico por `message_id` | `plusmedik_audit_claim_run` (existente), invocado por `plusmedik_turn_claim` | Una sola corrida y un solo propietario; el segundo recibe `busy`/`finished`/`in_doubt` y no hace nada |
| **Ejecución muerta o dormida que revive** | Lease + fence | existente | La ejecución antigua recibe PT410 al reservar/escribir: no puede enviar |
| **Dos respuestas al mismo mensaje** | Reserva de envío de una sola concesión; un envío incierto no se reenvía | existente | Un mensaje, a lo sumo una respuesta |
| **Dos mensajes consecutivos del contacto procesados a la vez** | Cada turno se reclama aparte (secuencia por contacto) y su reserva se serializa por contacto | **nuevo** `plusmedik_turn_claim` / `plusmedik_turn_reserve_send` | Numeración densa sin huecos ni repetidos (probado con 8 claims simultáneos) |
| **Dos respuestas al mismo paciente cruzándose en Kapso** | **Un solo envío en vuelo por contacto**: mientras otro turno del contacto tiene su envío `RESERVED` y vigente, la reserva devuelve `busy` | **nuevo** | Los envíos al mismo contacto nunca se solapan (probado: máximo 1 llamada simultánea a Kapso por contacto) |
| **Respuesta obsoleta** | Política `NEWER_TURN`: si un turno MÁS NUEVO del contacto ya reservó o envió su respuesta, esta se descarta (`CANCELLED`, `SUPERSEDED`) | **nuevo** | La respuesta vieja nunca llega después de la nueva |
| **Pausa humana** | `claim` no procesa a un contacto pausado; la pausa bloquea turnos pendientes; la reserva y la comprobación final la vuelven a consultar | existente (las funciones nuevas la **delegan**) | Probado en 5 momentos (antes, durante el trabajo, en la reserva, entre la reserva y el envío, reactivación) |
| **Orden de numeración dentro de un lote** | `extractIncomingTurns` ordena por el instante del mensaje; `processTurns` hace los claims secuencialmente antes del trabajo en paralelo | **nuevo** | `seq` respeta el orden en que el paciente escribió |

## 3. Contrato SQL (migración 6 · `20261025000000_plusmedik_turns.sql`)

**No se aplica a Supabase.** Aditiva: no modifica las migraciones 1-5 (sus hashes están fijados en una prueba) y no toca `lab_tests`, `lab_test_aliases` ni el esquema `crm`.

| Objeto | Contrato |
| --- | --- |
| `plusmedik_contact_turns(contact_key pk, last_seq, …)` | Contador por contacto (clave HMAC, sin teléfono). Solo avanza de uno en uno (trigger); sin DELETE/TRUNCATE |
| `plusmedik_turns(run_id pk, contact_key, seq, turn_kind, …)` | Un turno por corrida. `turn_kind ∈ IMAGE/TEXT/OTHER`. Inmutable. **Sin contenido del mensaje** (una prueba verifica que no hay columnas de texto) |
| `plusmedik_turn_claim(p_message_id, p_media_id, p_owner, p_lease_seconds, p_schema_version, p_engine_version, p_flags, p_max_attempts default 3, p_contact_key, p_turn_kind)` | Envuelve `plusmedik_audit_claim_run`. Devuelve su resultado + `seq` y `turn_kind` cuando hay turno (`claimed`/`taken_over`). `paused`, `busy`, `in_doubt`, `finished`, `exhausted` no crean turno. PT422 si falta o es inválida la clave de contacto o el tipo. PT409 si el mensaje pertenece a otro contacto |
| `plusmedik_turn_reserve_send(p_run_id, p_owner, p_fence, p_kind, p_lease_seconds, p_stale_policy)` | Envuelve `plusmedik_audit_reserve_send`. Resultados: `reserved` · `blocked` (pausa/bloqueo) · `closed` · **`busy`** · **`superseded`**. PT410 lease perdido · PT404 no es un turno · PT422 argumentos inválidos. Idempotente para una reserva ya concedida (no vuelve a comprobar `busy` ni obsolescencia) |
| Tipo de envío `conversation` | Añadido a la restricción de `runs` y a `reserve_send`/`record_reply` |
| Redefiniciones | `plusmedik_audit_reserve_send` (de la migración 5) y `plusmedik_audit_record_reply` (de la 3): **la única diferencia con la versión anterior es el nuevo tipo `conversation`**. Se extrajeron programáticamente del código original y una prueba compara texto contra texto |

**Orden de bloqueo** (sin interbloqueos): fila del contacto en `plusmedik_contact_turns` → corrida. Ambas funciones nuevas toman primero la fila del contacto. La pausa humana (`register_human_message`) bloquea `attention_contacts → corridas` y nunca toca `plusmedik_contact_turns`, por lo que no puede cerrar un ciclo.

### Reglas exactas de `reserve_send` por turno (en este orden)

1. Argumentos válidos y turno existente (`PT422`/`PT404`).
2. Se bloquea la fila del contacto y luego la corrida (`PT410` si el lease no es el vigente).
3. Si la corrida ya no está `NOT_RESERVED` → se delega (reserva idempotente `reserved`, o `closed`; tipo distinto → `PT409`).
4. **`busy`**: existe otra corrida del mismo contacto con `send_state = RESERVED` y lease vigente. (Cuenta cualquier corrida del contacto, también las anteriores a la migración 6.) Un envío en vuelo cuyo lease ya venció **no** bloquea: es un resultado dudoso que el recuperador marcará `UNKNOWN`.
5. **`superseded`** (solo con `NEWER_TURN`): existe un turno con `seq` mayor del mismo contacto cuya corrida está `RESERVED`, `ACCEPTED` o `UNKNOWN`. Un turno más nuevo que todavía está analizando, o que se cerró sin respuesta, **no** hace obsoleta una respuesta (se evita que ambas se pierdan).
6. Se delega en la reserva existente (pausa humana, bloqueos previos, concesión).

Como mientras un envío está reservado ningún otro turno del contacto puede reservar (regla 4) y la comprobación y la reserva ocurren bajo el mismo bloqueo, **no se necesita una segunda comprobación de obsolescencia en `confirm_send`**: la confirmación existente (pausa humana) se reutiliza sin cambios.

## 4. Contrato TypeScript

| Pieza | Cambio |
| --- | --- |
| `src/audit.ts` (`AuditRepository`) | `claim(…, { contactKey, turnKind })` usa `plusmedik_turn_claim` y devuelve `seq`; `reserveSend(…, { stale })` usa `plusmedik_turn_reserve_send` y puede devolver `busy`/`superseded`; `recordIgnored(…, "NO_REPLY")` cierra un turno sin respuesta. **Sin opciones el comportamiento y los argumentos son exactamente los de antes** |
| `src/guarded-turn.ts` (nuevo) | La máquina `claim → trabajo → reserva → confirmación → Kapso → resultado` que vivía dentro de `handleImageMessage`, extraída **sin cambiar su comportamiento**. `beginTurn` (fase 1: claim) y `ClaimedTurn.run` (fase 2). Añade la espera acotada por `busy` (8 reintentos × 1,5 s por defecto) |
| `src/whatsapp-quote.ts` | `handleImageMessage` pasa a ser `runGuardedTurn(…, imageProducer(…))`. El trabajo de la imagen (descarga, análisis, evidencia, qué responder) es **el mismo código**, movido a `imageProducer` |
| `src/turns.ts` (nuevo) | `extractIncomingTurns` (clasifica y ordena), `processTurns` (claims secuenciales y trabajo en paralelo), `TurnHandlers` (manejadores inyectados), `producerFor` |
| `src/kapso-webhook.ts` | Con `deps.quote.turns` enruta por `processTurns`; sin él, el camino anterior intacto |
| `api/kapso/webhook.ts` + `.env.example` | `PLUSMEDIK_TURNS` (apagado por defecto). Encendida: exige claim obligatorio y clave de contacto; **sin manejadores** (solo imágenes por la coordinación) |

Política de respuesta por tipo (decidida por quien produce la respuesta; la base solo la aplica):

| Respuesta | `stale` | Motivo |
| --- | --- | --- |
| Cotización o pedido de otra foto (imagen) | `NONE` | Nunca se descarta en silencio; la consolidación de varias imágenes es de G4 |
| Aviso técnico de una imagen | `NEWER_TURN` | Si el paciente ya escribió de nuevo, el aviso de error es obsoleto |
| Respuesta de un manejador de conversación | `NEWER_TURN` (o `NONE` si el manejador lo pide) | Una conversación contestada fuera de orden confunde |
| Aviso técnico de un manejador que falló | `NEWER_TURN` | ídem |

## 5. Decisiones y alternativas descartadas

| # | Decisión | Por qué | Alternativa descartada |
| --- | --- | --- | --- |
| D1 | Un turno **es** una corrida | Reutiliza todas las garantías de Phase 6 y la recuperación | Tabla de turnos independiente con su propio lease |
| D2 | **Funciones envolventes** (`turn_claim`, `turn_reserve_send`) que llaman a las existentes | No se reimplementan pausa, lease ni fencing; el cambio de riesgo queda aislado | Redefinir `claim_run`/`reserve_send` (se habría duplicado y alterado la lógica más delicada) |
| D3 | Obsoleta = "un turno más nuevo **ya reservó/envió**", no "existe uno más nuevo" | Si bastara con que exista, un turno más nuevo que luego se cierra sin respuesta dejaría **a ambos sin respuesta** | Descartar al llegar un turno más nuevo |
| D4 | `busy` = esperar acotado y reintentar en el cliente | No se bloquea una conexión de la base ni se mantiene una transacción abierta durante la llamada a Kapso | Bloqueo asesor de larga duración / cola en la base |
| D5 | Cotizaciones con `NONE` | Un precio no puede perderse por un mensaje posterior; la unión de varias fotos es de G4 | `NEWER_TURN` para todo |
| D6 | **El contenido del texto no se persiste ni se registra** (ni auditoría, ni tablas nuevas, ni logs) | Privacidad ya fijada en Phase 6 (no guardar texto clínico) | Guardar el texto para reintentos |
| D7 | Un texto/otro **sin manejador no se reclama** | Mantiene el comportamiento actual (se ignora) y no llena la auditoría de filas sin respuesta | Reclamar todo |
| D8 | `seq` es el **orden de llegada a la base**, no el de WhatsApp; en un lote se respeta el instante del mensaje | No hay forma fiable de ordenar entregas separadas y desordenadas de Kapso | Ordenar por `timestamp` en la base |
| D9 | `PLUSMEDIK_TURNS` implica el claim obligatorio y la clave del contacto (falla cerrado) | Sin claim no se puede demostrar exclusión | Responder de todos modos (política heredada) |
| D10 | Los claims de un lote van **uno por uno** y el trabajo en paralelo | Numeración correcta sin perder concurrencia en el trabajo caro | Todo en paralelo (el orden de `seq` dependería de la carrera) |

## 6. Límites conocidos (no se pretenden resolver en G2.0)

1. **`busy` agotado** (otro envío del contacto no se libera en ~12 s): el turno no responde y queda recuperable (se reclama con un reenvío del webhook) o, si nadie lo reclama, abandonado a los 15 min. Hoy no existe un "drenado" que retome turnos esperando.
2. **Orden de WhatsApp ≠ orden de llegada**: dos mensajes entregados desordenados por Kapso se numeran como llegaron.
3. **Carrera residual heredada** de F2.1: un mensaje humano posterior a la comprobación final no cancela un envío en curso.
4. **Un envío con resultado incierto** (`UNKNOWN`) se concilia a mano; no se reintenta.
5. **Los turnos que no son imágenes no registran evidencia de análisis**: sus corridas terminan con `evidence_recorded_at` nulo, que en Phase 6 significaba "brecha de auditoría". Hay que filtrarlas por `plusmedik_turns.turn_kind` en cualquier alarma futura.
6. **Los mensajes enviados desde el CRM** (`origin: cloud_api`) siguen sin pausar al agente (se cierra en G5).
7. **PostgREST real sin verificar** para los códigos nuevos (`PT404`/`PT422` del turno): la conversión PT###→HTTP está simulada por el adaptador de pruebas, igual que en las migraciones anteriores.
