# G3.2 · Resultados, bloqueos, riesgos y condiciones de activación

## 1. Resultado de las pruebas (offline; PostgreSQL 18 efímero; sin servicios reales)

| Dato | Valor |
| --- | --- |
| `tsc --noEmit` | sin errores |
| Suite completa | **71 archivos / 1884 pruebas, todas en verde** (≈ 4 min). Las **1719** previas siguen pasando; **165 son nuevas** |
| Cambios a pruebas existentes | Solo `knowledge-refs-db` (la migración 9 ya no es la última: ahora «novena de diez»), `production-defaults` (+3 pruebas, 2 variables) y el adaptador de pruebas (acepta la función nueva) |
| Estabilidad | En una corrida de la suite completa fallaron 3 pruebas de `turns-e2e` (G2, anteriores a G3.2) por esperas con tiempo límite bajo la carga de 71 archivos en paralelo; el archivo pasa solo (21/21) y la suite completa se repitió en verde. **Fragilidad ya existente, no causada por G3.2**, pero conviene darle más holgura |
| Gasto / red | cero llamadas a modelos, Kapso o Supabase real |

| Archivo nuevo | Pruebas | Cubre |
| --- | --- | --- |
| `tests/reply-guard-db.test.ts` | 63 | SQL real: esquema/privilegios/inmutabilidad, 23 configuraciones inválidas, guarda nula ≡ reserva de turnos, imágenes y cotizaciones sin límite, tope y ventana deslizante, varias reglas, qué cuenta, idempotencia, concurrencia (8 turnos / 3 huecos), precedencia (pausa, `busy`, `superseded`), ráfaga, repetición, caducidad, reset, estado, aditividad |
| `tests/reply-guard.test.ts` | 82 | Configuración, firma, 21 autorrespuestas detectadas y 17 mensajes de pacientes que NO se confunden, eco de textos propios, manejador con/sin protección, cableado con turnos, repositorio, fronteras estáticas |
| `tests/reply-guard-e2e.test.ts` | 14 | Webhook + manejador + repositorios reales + PostgreSQL: apagada = G2.1, tope, recuperación por ventana y por operador, bucle «Hola/Hola», ráfaga, autorrespuestas, eco, conversación normal, receta cotizada pese al bloqueo, pausa humana, duplicados, concurrencia (10 simultáneos ≤ tope), falla cerrado, privacidad |
| (ampliados) `production-defaults`, `knowledge-refs-db` | +3 | Banderas apagadas, configuración inválida ⇒ sin texto, migración 10 |

### Pruebas de mutación (reglas críticas debilitadas a propósito)
| # | Regla debilitada | Resultado |
| --- | --- | --- |
| M1 | Sin precedencia de la pausa humana | **1** falla |
| M2 | El tope cuenta también lo cancelado | **1** falla |
| M3 | La supresión no caduca | **2** fallan |
| M4 | También limita imágenes (SQL) | **1** falla |
| M5 | Sin idempotencia (reevalúa una reserva concedida) | **2** fallan |
| M6 | El reset no reinicia el conteo | **3** fallan |
| M7 | La guarda se envía también para imágenes (TS) | **1** falla |
| M8 | `limited` aceptado de cualquier función | **1** falla |
| M9 | Detección de automáticos después de clasificar | **3** fallan |
| M10 | La ráfaga cuenta imágenes | **2** fallan |

**Incidente de proceso**: una primera ejecución del script de mutación se interrumpió dejando M4 aplicada en la migración (se detectó porque «M4 no aplica» en la repetición). Se restauró a mano, se verificó cada punto mutado por búsqueda de texto, se ejecutó M4 de nuevo y después **la suite completa** sobre los archivos finales.

## 2. Bloqueos (nada de esto se hizo)

| Sistema | Bloqueo | Efecto hoy |
| --- | --- | --- |
| **Supabase** | **Diez** migraciones sin aplicar; sin staging autorizado; el mapeo HTTP real de PostgREST para `plusmedik_turn_reserve_send_guarded` (argumento `jsonb`, códigos `PT4xx`) sin verificar | Con la bandera encendida y la 10 sin aplicar, **el texto no se responde** (falla cerrado, probado) |
| **Laboratorio** | Sin umbrales aprobados (qué es «demasiado» para sus pacientes); sin textos aprobados | Los valores iniciales son una propuesta conservadora, no una decisión |
| **CRM / operaciones** | Nadie opera aún `reset`/`status`; no hay pantalla ni alerta cuando hay un `LOOP_SUSPECTED` | Un bloqueo por bucle se levanta solo al caducar (≤ 24 h), pero nadie se entera |
| **Kapso** | Sin verificar cómo informa autorrespuestas (¿hay un indicador estructurado?), ni los reintentos de entrega | La detección es por frases y por conducta |
| **Dueño** | Despliegue de producción y variables sin confirmar | — |

## 3. Riesgos propios de G3.2

| # | Riesgo | Severidad | Mitigación / estado |
| --- | --- | --- | --- |
| R1 | **Falso positivo de «automático»**: un paciente cuyo mensaje coincida con una frase de la lista no recibe respuesta | Baja–media | Lista conservadora y probada contra 17 mensajes de pacientes; solo ese mensaje queda sin respuesta (no suprime al contacto) y queda auditado `NO_REPLY` |
| R2 | **Falso negativo**: una autorrespuesta con otras palabras recibe respuesta | Media | Lo cubren el tope, la ráfaga y la repetición: el intercambio se corta, con a lo sumo unos pocos mensajes nuestros |
| R3 | **La repetición cuenta preguntas distintas con la misma firma** (p. ej. dos veces «horarios» con otra redacción) | Baja | Con 3 repeticiones en 15 min; la supresión caduca sola y el reset la levanta |
| R4 | **Silencio hacia un humano limitado**: no se le avisa | Media (experiencia) | Decisión deliberada: un aviso a un bot reabriría el bucle. Se puede añadir un único aviso por episodio, solo ante tope (no ante bucle), cuando el laboratorio apruebe el texto |
| R5 | **Un mensaje limitado no se reintenta** (la corrida queda cerrada) | Baja | La respuesta llegará al siguiente mensaje fuera del bloqueo; el flujo de cotización no se ve afectado |
| R6 | **Crecimiento de tablas** por un atacante que inunda | Baja | La bitácora solo guarda transiciones (≤ 1 por enfriamiento por contacto); marcas: una por respuesta enviada. Se necesitará retención/purga (las tablas son inmutables por diseño: requiere decisión) |
| R7 | **Reloj**: las ventanas usan la hora de la base | Baja | Una sola fuente de tiempo |
| R8 | **El tope cuenta por contacto, no globalmente**: muchos números atacantes a la vez no se limitan entre sí | Media | Fuera de alcance; un tope global requeriría otra decisión de producto |
| R9 | **Costo de la consulta**: ~4 consultas por reserva de texto con guarda | Baja | Índice parcial nuevo; solo texto, y bajo el bloqueo del contacto |

## 4. Condiciones para ACTIVAR G3.2 (en números de prueba; nada se activó)

Orden estricto (primero migraciones, después banderas):
- [ ] Todo lo de **G2.1 §3** y **G3.1A §5** (G3.2 era la condición «tope por contacto»).
- [ ] Las **diez** migraciones aplicadas y validadas en un Supabase de ensayo con las RPC reales por HTTP (en especial el argumento `jsonb` de `plusmedik_turn_reserve_send_guarded`, el resultado `limited` y `plusmedik_reply_guard_reset/status`).
- [ ] **Umbrales aprobados** por el laboratorio (o dejar los iniciales conscientemente) y un guion de prueba con dos números del equipo: tope, ráfaga, repetición, autorrespuesta, recuperación.
- [ ] **Quién opera** `reset` y `status` (CRM o script de operador) y cómo se entera de un `LOOP_SUSPECTED`.
- [ ] Decisión sobre retención de la bitácora.
- [ ] Orden de banderas: `REQUIRE_AUDIT_GUARD` → `PLUSMEDIK_CONTACT_HMAC_KEY` + `PLUSMEDIK_HUMAN_CONTROL` → `PLUSMEDIK_TURNS` → **`PLUSMEDIK_REPLY_GUARD`** (+ `…_CONFIG` si se ajusta) → `PLUSMEDIK_TEXT_HANDLER` → `PLUSMEDIK_KNOWLEDGE_ANSWERS`. La guarda va **antes** del manejador de texto; el código no impide encender el manejador sin ella (ambas son independientes y apagadas), por lo que es una regla de operación.

## 5. Qué sigue (no hecho aquí)
- Staging con las 10 migraciones y verificación HTTP real.
- Un aviso único y aprobado ante tope (no ante bucle), si el laboratorio lo quiere.
- Alertas/tablero de bucles y retención de tablas.
- **G5**: derivación real al CRM.
