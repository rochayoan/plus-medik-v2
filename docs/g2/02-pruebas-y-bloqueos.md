# G2.0 · 02 Pruebas, bloqueos y condiciones para iniciar G2.1

## 1. Resultado de las pruebas (todo offline, sin servicios reales)

| Dato | Valor |
| --- | --- |
| Árbol | `feat/g2-turnos` = `origin/main` (`dfa98da`) + cambios de G2.0 sin commit; `npm ci` limpio |
| Entorno | Windows 10, Node 24.15, PostgreSQL 18 efímero (127.0.0.1, destruido al terminar), sin `.env`, `PLUSMEDIK_OFFLINE=1`, red bloqueada |
| `tsc --noEmit` | sin errores |
| `vitest run` completo | **55 archivos / 1430 pruebas, todas en verde** (≈ 71 s). Las **1347 originales** de G1 siguen pasando; **83 son nuevas** |
| Estabilidad | Las tres suites nuevas se repitieron dos veces seguidas: 83/83 ambas veces. Un fallo intermitente de la propia prueba (orden de dos claims concurrentes) apareció en una corrida completa, se diagnosticó y se corrigió |
| Gasto / red | cero llamadas a modelos, a Kapso o a Supabase; ningún proceso `postgres` quedó activo |

Las 1347 existentes sufrieron **solo tres ajustes de aserción** (no de comportamiento): tres pruebas afirmaban por posición que la migración 5 era "la última" (`files.slice(-2)`); ahora afirman por posición absoluta (`slice(3, 5)`), con los mismos hashes fijados. Una prueba nueva fija además los hashes de las **cinco** migraciones anteriores, de modo que cualquier modificación de ellas rompería la suite.

### Pruebas nuevas

| Archivo | Pruebas | Qué demuestra |
| --- | --- | --- |
| `tests/turns-db.test.ts` | 31 | Migración 6 contra PostgreSQL real (ver abajo) |
| `tests/turns.test.ts` | 31 | Coordinación en TypeScript con repositorio simulado: clasificación y orden de mensajes, modo turnos para imagen y texto, fallo cerrado, `busy`/`superseded`/pausa, lotes, y el cliente Supabase |
| `tests/turns-e2e.test.ts` | 21 | Webhook real + procesamiento real + repositorios reales + las 6 migraciones en PostgreSQL real; Kapso y manejadores simulados |

**`turns-db` (SQL real):** reaplicar la migración sin error ni pérdida de datos · RLS y privilegios (service_role solo lee; anon/authenticated/otros sin acceso a tablas ni funciones) · `SECURITY DEFINER` con `search_path` vacío · inmutabilidad y secuencia de uno en uno (incluso para el propietario) · numeración 1,2,3 por contacto y 8 claims simultáneos → 1..8 sin huecos ni repetidos · reintento idéntico y duplicado no consumen secuencia · toma de lease conserva el número · contacto pausado no recibe turno · argumentos inválidos (PT422, sin eco de valores) · llamada **como la hace el cliente** (solo argumentos con nombre, sin `p_max_attempts`) · camino heredado sin turnos intacto · tipo `conversation` · `busy` / idempotencia / lease vencido no bloquea / contactos independientes / dos reservas simultáneas → exactamente una · fencing (PT410) · obsolescencia con `NEWER_TURN` y sin ella, turnos más nuevos aún sin responder o cerrados sin respuesta, orden de decisión · pausa en la reserva y en la comprobación final, reactivación · comparación texto a texto de las dos funciones redefinidas con sus originales (la única diferencia es `'conversation'`) · hashes de las 5 migraciones anteriores · la migración no toca catálogo, `crm.*`, ni borra nada.

**`turns-e2e` (escenarios):** texto con manejador (una respuesta, `conversation`, y el texto del paciente **no aparece en ninguna tabla ni log**) · sin manejador todo igual que hoy · sin modo turnos igual que antes · mismo mensaje dos veces a la vez + una tercera → manejador una vez, una respuesta · ejecución colgada + reclamo del lease vencido + la antigua revive → una respuesta y la antigua no envía · envío incierto → no se reintenta y no bloquea · **respuesta obsoleta descartada** · **cotización lenta no se descarta aunque un texto posterior ya respondió** · **tres respuestas listas a la vez nunca se solapan en Kapso** (máximo 1 simultánea) · contactos distintos sí en paralelo · lote desordenado se numera por instante del mensaje · audio con manejador · manejador sin respuesta · manejador que falla (sin el texto del error) · pausa antes / durante / entre reserva y envío / reactivación · base caída al reclamar (no responde) o al reservar (no envía; recuperable) · ejecución que no termina nunca.

### Verificación de que las pruebas detectan fallos (mutación)

Se desactivó a propósito la regla "un solo envío en vuelo por contacto" en la migración: **4 pruebas fallaron** (3 de SQL: el `busy`, las dos reservas simultáneas y el orden de decisión; y 1 de extremo a extremo: la de Kapso sin solapes) y se restauró la migración byte a byte. Además, la primera ejecución de las pruebas de extremo a extremo destapó un defecto real que las pruebas de SQL no cubrían (el cliente omite `p_max_attempts`): se corrigió dándole valor por defecto y se añadió la prueba de SQL que faltaba.

## 2. Mecanismos de Phase 6 reutilizados (no reconstruidos)

| Mecanismo | Cómo se reutiliza |
| --- | --- |
| Claim atómico e idempotente por `message_id` | `plusmedik_turn_claim` llama a `plusmedik_audit_claim_run` |
| Lease + fencing + latido | Sin cambios; cada turno es una corrida con lease |
| Reserva de envío (una sola concesión) y "un envío incierto no se reenvía" | `plusmedik_turn_reserve_send` llama a `plusmedik_audit_reserve_send` |
| Comprobación final (`confirm_send`) y pausa humana | Sin cambios; **ni siquiera se redefinió** `confirm_send` |
| Recuperación segura (`recover_stale`), vista de fases | Sin cambios; un turno descartado queda `CLOSED_NO_SEND` |
| Auditoría inmutable, telemetría, huella del catálogo | Sin cambios (las imágenes siguen registrando su evidencia) |
| Clave de contacto HMAC | La misma (`contactKeyOf`); sin ella no se responde |
| Motor de recetas y precios | **Cero cambios** en `analyze.ts`, lectores, juez, catálogo, `partial-auto.ts`, `uncertainty.ts`, etc. (comprobado con `git diff`). Las reglas de manuscritas no se tocaron: `ENGINE_FLAGS` del webhook idéntico |

Código tocado: `src/audit.ts`, `src/whatsapp-quote.ts` (la orquestación del envío se movió a `guarded-turn.ts`; el trabajo de la imagen es el mismo código, ahora `imageProducer`), `src/kapso-webhook.ts`, `api/kapso/webhook.ts`, `.env.example`, tres pruebas y el adaptador de pruebas. Nuevos: `src/guarded-turn.ts`, `src/turns.ts`, la migración 6 y las tres suites.

## 3. Riesgos

| # | Riesgo | Severidad | Estado / mitigación |
| --- | --- | --- | --- |
| R1 | **La migración 6 es la sexta sin aplicar**: producción sigue sin deduplicación/lease/pausa mientras no se apliquen las cinco de Phase 6 (hallazgo de G1) | Alta (heredado) | Sin cambio: G2.0 no empeora nada; `PLUSMEDIK_TURNS` apagada |
| R2 | Refactor de `handleImageMessage` hacia `guarded-turn.ts` | Media | Las 1347 pruebas previas (incluidas las de PostgreSQL real de extremo a extremo para imágenes) pasan sin cambios; los argumentos de `claim`/`reserveSend` en modo heredado son idénticos (probado con `toHaveBeenCalledWith` exacto) |
| R3 | `busy` agotado deja un turno sin respuesta | Media | Documentado (límite 1); en G2.1 decidir drenado o aviso |
| R4 | Obsolescencia descarta respuestas de conversación: si el manejador futuro respondiera algo imprescindible con `NEWER_TURN` se perdería | Media | El manejador puede pedir `stale: NONE`; política por tipo a fijar en G2.1 |
| R5 | Orden de `seq` = llegada a la base, no orden de WhatsApp | Baja-media | D8; en un lote se respeta el instante |
| R6 | PostgREST real no verificado para códigos nuevos | Media | Verificación en staging (condición de G2.1) |
| R7 | Filas de turnos sin evidencia de análisis (`evidence_recorded_at` nulo) pueden disparar alarmas de "brecha de auditoría" | Baja | Filtrar por `plusmedik_turns.turn_kind` |
| R8 | Un mensaje del CRM (`cloud_api`) no pausa al agente | Alta cuando el CRM envíe | G5 (sin cambios) |
| R9 | Los logs de turnos exponen contadores de espera (`turn_busy`) | Baja | Solo números, sin contenido ni teléfono |

## 4. Bloqueos para pasar de G2.0 a producción (nada de esto se hizo)

1. **Aplicar las 6 migraciones**, en orden, primero en staging (mismas condiciones que G1 §3, ahora con la migración 6).
2. **Verificar el mapeo HTTP real de PostgREST** (`PT404`, `PT409`, `PT410`, `PT422` de las funciones de turnos) y la versión de PostgreSQL de Supabase.
3. **Confirmar el despliegue de producción y sus variables** (pendiente desde G1): `PLUSMEDIK_TURNS` debe seguir **sin definir**.
4. **Confirmar que el webhook de Kapso recibe los eventos que se necesiten** (entrantes de texto/audio y salientes para la pausa humana).
5. **Texto aprobado por el laboratorio** para cualquier respuesta automática a mensajes que no sean imágenes (decisión 5 de G0): sin él no hay manejadores.

## 5. Condiciones para iniciar G2.1

G2.1 = primer manejador de conversación real (mínimo: acuse y derivación a persona) y su activación para números de prueba. Solo puede iniciar cuando:

- [ ] El dueño confirma el despliegue de producción y que ninguna bandera de G1/G2 está definida.
- [ ] Hay un Supabase de ensayo autorizado y las **seis** migraciones se aplican y se validan allí (RPC reales por HTTP, incluido el mapeo de errores).
- [ ] El dueño decide el texto de los mensajes fijos y el horario de atención humana que se promete.
- [ ] Se decide qué hacer con un turno cuya espera `busy` se agota (propuesta: aumentar el plazo según el tipo, y registrar `busy_timeout` como alarma; sin reenvío automático).
- [ ] Se fija la política `stale` por tipo de respuesta (propuesta: acuses y derivaciones `NONE`; respuestas informativas `NEWER_TURN`).
- [ ] Se confirma (con Kapso) la suscripción de eventos de texto/audio entrantes y de salientes (pausa humana).
- [ ] Presupuesto para pruebas con modelos reales **si** el manejador usa un clasificador (G2.1 puede empezar sin modelos: acuse fijo).

Qué hará G2.1 y qué **no**: añade el manejador mínimo, los textos aprobados y la activación acotada por `ALLOWED_PHONES`; **no** incluye políticas, horarios, preparación ni cotizaciones nuevas (G3/G4), ni el emisor al CRM (G5).
