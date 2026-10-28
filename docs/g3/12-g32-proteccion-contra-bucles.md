# G3.2 · Protección contra bucles y exceso de respuestas

Todo local, offline y **apagado por defecto**. Nada se aplicó a Supabase real, no se envió nada por Kapso, no se llamó a ningún modelo, no se activó ninguna bandera, no hay commit/push/merge. No se tocó `CRM-PLUSMEDIK` ni el motor de recetas.

## 1. El problema

Desde G2.1/G3.1A cada texto recibe una respuesta. Un bot (otro negocio con autorrespuesta, un eco, un cliente con un fallo) que le escriba al laboratorio encadenaría respuestas sin fin: gasto, ruido y riesgo reputacional. Antes de activar el manejador de texto hace falta un tope y un corte de bucles que **no dependa de buena voluntad del código de la respuesta**.

## 2. Diseño: tres capas

```
mensaje de texto ─► [3] ¿parece automático o es eco de nuestros textos? ─ sí ─► sin respuesta (turno cerrado NO_REPLY, auditado)
                          │ no
                          ▼
                 manejador de G2.1/G3.1A  ──►  respuesta + FIRMA (código cerrado: categoría y temas)
                          │
                          ▼
   [1] reserva de envío con guarda  (plusmedik_turn_reserve_send_guarded, UNA transacción, bajo el bloqueo del contacto)
        precedencia (la decide la función de turnos de siempre):  ya reservada → pausa humana/bloqueo → busy → superseded
        después, solo si iba a reservar:   supresión vigente → ráfaga → repetición → tope por ventana
                          │
          reserved ─► comprobación final ─► Kapso          limited ─► corrida CANCELLED con motivo; NO se envía
```

| Capa | Dónde | Qué hace |
| --- | --- | --- |
| 1. Reserva con guarda | Migración 10 (SQL) | Decide y registra de forma atómica: tope por contacto y ventana, ráfaga, repetición, supresión temporal |
| 2. Cableado | `guarded-turn.ts`, `audit.ts`, `turns.ts` | Pasa la configuración y la firma a la reserva; `limited` ⇒ no se envía |
| 3. Mensajes automáticos | `reply-guard.ts` + `text-handler.ts` | Autorrespuestas y ecos no reciben respuesta |

### Qué se limita y qué NO
- **Se limita** solo lo conversacional: turnos de **texto u otros** con envíos `conversation` o `technical_issue`.
- **Nunca se limita** un turno de **imagen** ni una cotización (`quoted`, `no_quote`): quien envía su receta siempre recibe su cotización (probado, también con el contacto suprimido).

### Señales (ninguna lee el texto del paciente)
| Señal | Regla | Efecto |
| --- | --- | --- |
| Tope | Cualquiera de 1–4 reglas `{ventana s, máx}` sobre envíos concedidos (`RESERVED/ACCEPTED/UNKNOWN`) | `limited / RATE_LIMITED`. Ventana **deslizante**: se libera sola |
| Ráfaga | ≥ N mensajes de **texto** entrantes del contacto en W s (cuenta el actual) | Supresión temporal + evento `LOOP_SUSPECTED` |
| Repetición | La misma **firma** (p. ej. `INFO_REQUEST:HOURS`) ya concedida ≥ N veces en W s | Supresión temporal + evento `REPEAT_SUSPECTED` |
| Automático / eco | Frases de autorrespuesta (lista conservadora) o prefijo de nuestros propios textos | Sin respuesta, antes de clasificar (una «emergencia» dentro de una autorrespuesta no es un paciente) |

Valores iniciales (`DEFAULT_REPLY_GUARD`, ajustables con `PLUSMEDIK_REPLY_GUARD_CONFIG`): 8 respuestas/10 min y 40/día; ráfaga de 8 mensajes/min; misma respuesta 3 veces/15 min; supresión de 15 min.

### Compatibilidad con lo existente
- **Idempotencia**: una reserva ya concedida se repite igual aunque el contacto esté en el tope (no se limita a sí misma); un mensaje limitado queda cerrado (`closed`) y el mismo `message_id` no se vuelve a evaluar.
- **Concurrencia**: se evalúa y reserva bajo el mismo bloqueo del contacto (contacto → corrida, como G2.0). 8 turnos simultáneos compiten por 3 huecos y pasan exactamente 3 (probado en la base real).
- **Pausa humana**: va primero. Un contacto pausado recibe `blocked` (`HUMAN_PAUSED`), no `limited`, sin eventos de guarda; limitar no pausa ni toca la atención humana; el reset **no** levanta la pausa.
- **Fencing**: sin lease vigente (otra generación) → `PT410`, no se reserva nada. `busy` y `superseded` conservan su significado y su precedencia.
- Con `p_guard` nulo la función **es** la reserva de turnos (delegación; probado).

### Nunca bloquear de forma permanente a un paciente legítimo
1. El tope es una ventana deslizante: se libera sola.
2. La supresión por bucle **caduca** (el enfriamiento está limitado a 24 h por una restricción de la tabla, no por convención).
3. Recuperación manual: `plusmedik_reply_guard_reset(contacto, operador)` levanta la supresión y **reinicia el conteo** (los envíos anteriores dejan de contar, nada se borra) y deja el evento `RECOVERED` con quién. Es solo para operadores: ni `src/` ni `api/` pueden nombrarla (probado estáticamente).
4. Las imágenes/cotizaciones nunca se limitan, así que el flujo principal del laboratorio sigue abierto.
5. No se envía ningún aviso «te respondo luego»: enviárselo a un bot reabriría el bucle. **Contrapartida**: un humano limitado no recibe explicación; verá respuesta en su siguiente mensaje fuera del bloqueo.

### Auditoría
- Cada mensaje bloqueado queda como corrida `CANCELLED/COMPLETED` con `send_block_reason` ∈ `RATE_LIMITED | SUPPRESSED | LOOP_SUSPECTED | REPEAT_SUSPECTED` (más `HUMAN_PAUSED`/`SUPERSEDED` como siempre).
- Bitácora inmutable `plusmedik_reply_guard_events` solo de **transiciones** (entrar en supresión, primer tope de una ventana, recuperación): no crece con cada mensaje de un bot que inunda.
- Consulta para operadores: `plusmedik_reply_guard_status(contacto)` (supresión vigente + últimos 20 eventos).
- **Privacidad**: solo códigos, contadores y la clave seudónima. Sin texto del paciente ni de la respuesta, sin teléfonos (probado con centinelas en logs y tablas).

## 3. Migración 10 `20261029000000_plusmedik_reply_guard.sql` (preparada, **no aplicada**)
Aditiva: 3 tablas (`marks`, `state`, `events`), 6 funciones (validación, reserva con guarda, reset, estado) y un índice parcial sobre `plusmedik_audit_runs`. No borra ni modifica nada anterior (las 9 previas, con hash fijado), no siembra datos, sin SQL dinámico. Marcas y bitácora inmutables; `state` solo lo cambian las funciones (y nunca > 24 h). Funciones `SECURITY DEFINER` con `search_path` vacío, ejecutables solo por `service_role`. Probada **solo** en PostgreSQL efímero.

## 4. Activación (todo apagado)
| Variable | Efecto |
| --- | --- |
| `PLUSMEDIK_REPLY_GUARD` (`on` exacto) | Enciende las tres capas. Solo tiene efecto con `PLUSMEDIK_TURNS=on` y `PLUSMEDIK_TEXT_HANDLER=on` |
| `PLUSMEDIK_REPLY_GUARD_CONFIG` (JSON, opcional) | Umbrales. **Inválida ⇒ el texto deja de responderse** (no se usan valores iniciales a escondidas) y se registra un código |

Con la guarda encendida y la migración 10 sin aplicar, la función no existe ⇒ la reserva falla ⇒ **no se envía** (falla cerrado, probado). Sin la bandera, el comportamiento es idéntico a G3.1A: ni siquiera se detectan automáticos (probado).

## 5. Archivos
Nuevos: `supabase/migrations/20261029000000_plusmedik_reply_guard.sql` · `src/reply-guard.ts` · `tests/reply-guard.test.ts` · `tests/reply-guard-db.test.ts` · `tests/reply-guard-e2e.test.ts` · `docs/g3/12-…` · `docs/g3/13-…`.
Modificados: `src/audit.ts` (`limited`, `guard` en `reserveSend`) · `src/guarded-turn.ts` (`replyGuard`, firma) · `src/turns.ts` (`signature`) · `src/text-handler.ts` (`loopProtection`) · `api/kapso/webhook.ts` y `.env.example` (2 variables en blanco) · `tests/support/postgrest-over-psql.ts` · `tests/knowledge-refs-db.test.ts` (la migración 9 ya no es la última) · `tests/production-defaults.test.ts`.
