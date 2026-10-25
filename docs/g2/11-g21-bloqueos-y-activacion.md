# G2.1 · Bloqueos y condiciones de activación; condiciones para iniciar G3

## 1. Bloqueos (nada de esto se tocó)

| Sistema | Bloqueo | Efecto hoy | Qué lo desbloquea |
| --- | --- | --- | --- |
| **CRM** | Contrato `POST /api/internal/agent/review-case` apagado (`PLUSMEDIK_AGENT_REVIEW_INGEST_ENABLED=false`); el CRM no ingiere aún los mensajes del agente (`409 message_not_ingested`); su webhook propio sin registrar | La **derivación a una persona está bloqueada** y el manejador nunca la confirma | G5: outbox + emisor en este repo; CRM operativo con token exclusivo; decisión del dueño sobre qué basta para prometer |
| **CRM** | Mensajes enviados desde el CRM llegan con `origin: cloud_api` y no pausan al agente; endpoints `attention/status|action` sin implementar aquí | Una recepcionista que escriba desde el CRM no pausa la IA | G5 (pausa manual por operación) antes de que el CRM habilite su envío |
| **Kapso** | Suscripción de eventos no verificada (¿llegan los entrantes de texto y los salientes de la pausa humana?). El formato real de `text`/`interactive` no está verificado con capturas | No se sabe si el modo de texto recibiría mensajes ni si la pausa humana funcionaría | Verificarlo con un número de prueba |
| **Kapso** | Ventana de 24 h de WhatsApp: responder fuera de ella puede exigir una plantilla aprobada | Las respuestas a textos viejos se descartan (>10 min) por diseño; no se verificó la regla de Meta | Verificar con Kapso/Meta |
| **Supabase** | Las **siete** migraciones sin aplicar (las 5 de Phase 6 desde G1, la 6 de G2.0 y la 7 de G2.1); mapeo HTTP real de PostgREST (`PT404/PT409/PT410/PT422`) sin verificar; versión de PostgreSQL sin confirmar | Sin migraciones el modo turnos falla cerrado (no responde) y producción sigue sin deduplicación/lease/pausa (hallazgo de G1) | Staging con las 7, RPC reales por HTTP |
| **Laboratorio** | Textos no aprobados (son borradores) | El manejador no debe activarse | Aprobación de los 6 textos |
| **Dueño** | Despliegue de producción y variables sin confirmar | — | Confirmación en Vercel |

## 2. Riesgos propios de G2.1

| # | Riesgo | Severidad | Estado |
| --- | --- | --- | --- |
| R1 | **Bucles con bots**: un contacto que sea un bot o autorespuesta provocaría un intercambio sin fin (cada texto recibe respuesta). No hay límite por contacto | **Alta** si se activa | **Condición de activación**: tope de respuestas conversacionales por contacto y ventana (G7 lo contemplaba; se adelanta como requisito de G2.1-activación, con una prueba) |
| R2 | Clasificador por palabras: falsos positivos/negativos (p. ej. un síntoma escrito sin las palabras previstas recibe el texto genérico `fallback`, que no da consejo ni promete nada) | Media | Diseño conservador: lo ambiguo nunca recibe información, solo la petición de la foto; ampliar con datos reales en G3 |
| R3 | "Recuperable" depende de que el mensaje se reentregue (límite de privacidad) | Media | Documentado; el recuperador lo cierra y queda para atención |
| R4 | Coste/lat. por turno de texto: 4–6 RPC a Supabase por mensaje, sin modelos | Baja | Sin gasto de IA |
| R5 | El texto de un mensaje largo queda en memoria durante el turno y en el cuerpo de la petición | Baja | Nunca se persiste ni se registra |
| R6 | El cuerpo de un botón (`interactive`) y el pie de foto no se leen | Baja | Fuera de alcance |
| R7 | Clasificar `resultado`/`convenio`/`seguro` como información puede derivar de más cuando el paciente solo saluda con esas palabras | Baja | Con la derivación bloqueada solo recibe `handoff_unavailable` |

## 3. Condiciones para ACTIVAR G2.1 (en números de prueba; nada se activó)

Orden estricto (como en G1: primero migraciones, después banderas):

- [ ] Despliegue de producción y variables confirmados; ninguna bandera de G1/G2 definida.
- [ ] Supabase de ensayo: aplicar **las 7 migraciones** y llamar las RPC reales por HTTP (claim, reserva, `busy`, `superseded`, liberación, pausa); mapeo de errores y versión de PostgreSQL verificados.
- [ ] Los 6 textos de `DRAFT_TEXTS` aprobados por el laboratorio (y pasan la guarda de cifras).
- [ ] **Tope de respuestas por contacto** implementado y probado (R1).
- [ ] Kapso confirmado: entrantes de texto y salientes humanos llegan al webhook del agente.
- [ ] En producción (tras migrar): `REQUIRE_AUDIT_GUARD=on`, luego `PLUSMEDIK_CONTACT_HMAC_KEY`, `PLUSMEDIK_HUMAN_CONTROL=on`, y solo entonces `PLUSMEDIK_TURNS=on` y `PLUSMEDIK_TEXT_HANDLER=on` con `ALLOWED_PHONES` de 1–2 números del equipo.
- [ ] Guion manual de pruebas: saludo → respuesta; duplicado → una respuesta; dos textos seguidos → orden correcto; pausa humana → silencio; reactivación; texto médico → solo el aviso; "quiero un asesor" → `handoff_unavailable` (nunca la confirmación).
- [ ] La derivación **permanece bloqueada**.

## 4. Condiciones para iniciar G3 (políticas, horarios, preparación)

G3 puede **diseñarse y construirse offline en paralelo** (no depende de activar nada), pero no responder pacientes hasta que se cumpla la sección 3. Para empezar G3 hace falta:

1. **Fuente y dueño de los datos**: quién del laboratorio aprueba horarios, sucursales, políticas y preparación, en qué formato los entrega, y cómo se actualizan (carga controlada o desde el CRM). *Es el bloqueo real de G3: hoy no existe ningún dato.*
2. La estructura de conocimiento de `docs/g0/02` (tablas versionadas `APPROVED`) aprobada, y su migración 8 numerada después de la 7.
3. Decisión sobre la **política de ausencia de dato** ("a confirmar", nunca "sin preparación") y sobre qué se responde fuera del horario de atención humana.
4. El clasificador: decidir si se mantiene por reglas o se añade uno con modelo (esto requeriría presupuesto de pruebas con modelos reales; el gasto nuevo previo superó el tope: pide autorización y tope nuevos).
5. La plataforma de G3 reutiliza **sin cambios** `guarded-turn`/`turns`: un nuevo manejador sustituye a `createTextHandler`; las respuestas fundamentadas usan `stale: NEWER_TURN` o `NONE` según el caso. La verificación de hechos (cada cifra/hora del texto enviado proviene de un registro aprobado) es la prueba central de G3.
6. R1 resuelto (el tope por contacto es prerrequisito de cualquier respuesta automática más rica).
