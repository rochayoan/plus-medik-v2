# G4.0 · Resultados, bloqueos, riesgos y condiciones de activación

## 1. Resultado de las pruebas (offline; PostgreSQL 18 efímero; sin servicios reales)

| Dato | Valor |
| --- | --- |
| `tsc --noEmit` | sin errores |
| Suite completa | **76 archivos / 2078 pruebas, todas en verde**, en **dos corridas completas consecutivas** (≈ 3,5 min). Las **1884** previas siguen pasando; **194 son nuevas** |
| Cambios a pruebas existentes | Solo apoyo: adaptador de pruebas (acepta las RPC nuevas y arreglos de texto), conteo/posición de migraciones (`knowledge-refs-db`, `reply-guard-db`), lista blanca de la guarda (`reply-guard`), banderas (`production-defaults`) y las **esperas** de `turns-e2e` / `turns` |
| Gasto / red | cero llamadas a modelos, Kapso o Supabase real |

| Archivo nuevo | Pruebas | Cubre |
| --- | --- | --- |
| `tests/quote-session.test.ts` | 74 | Comandos («listo»/«cancelar» y 20+ frases que NO lo son), estudios escritos (alias, relleno, «y» dentro de un nombre, ambiguo, sin resolver, retirado, sin aproximaciones), evaluación al cerrar (centavos exactos, precio vigente, estudio retirado, precios inválidos, prioridades), mensajes seguros |
| `tests/quote-session-turns.test.ts` | 24 | Traducción de lo que dijo el motor (completo/parcial/sin cotización), foto grande/mal formato/llena/repetida/ya analizada, fallas cerradas, esperas acotadas, replay, catálogo caído, sin manejador de texto = flujo de siempre |
| `tests/quote-session-db.test.ts` | 62 | SQL real: esquema/privilegios/inmutabilidad, 19 resultados inválidos (PT422), lease (PT410/PT404), idempotencia, foto repetida, tope, vencimiento, lectura `pending/ready/replay`, cierre que rechaza (PT409) todo lo que no sea exactamente lo identificado, cola de revisión, reenviar con arrastre, cancelar, turnos posteriores, concurrencia, aditividad |
| `tests/quote-session-e2e.test.ts` | 22 | Webhook + manejador + repositorios reales + PostgreSQL: varias fotos y texto → una cotización; nada de precios antes de «listo»; repetidos; ambiguo/sin resolver/parcial → sin precio y con caso en la cola; ilegible → reenviar → cotizar; precio y estudio retirado al cerrar; «listo» tras una foto lenta espera; idempotencia; cancelar; vencimiento; pausa humana; antibucles; fallas cerradas; privacidad |
| `tests/quote-session-boundaries.test.ts` | 9 | El flujo de recetas no las conoce; dónde pueden aparecer; sin modelos ni red; sin precios ni ids escritos; el cierre recarga el catálogo; cableado de la bandera |

### Pruebas de mutación (16 reglas críticas debilitadas a propósito; las 16 detectadas)
Cotizar con ítems dudosos o ilegibles (4 fallan) · cotizar de menos / de más (1+1) · no esperar a turnos anteriores (1) · no detectar la foto repetida (1) · no trasladar lo posterior (1) · cierre no idempotente (1) · ignorar lo ambiguo (1) · «listo» dentro de cualquier frase (8) · relleno en el interior de un nombre (4) · parcial del motor como identificado (1) · cerrar con catálogo en caché (1) · sesiones sin manejador de texto (1) · aceptar precio 0 (3) · automáticos dentro de la sesión (1) · no reintentar la espera (1). El script restaura desde copias y verifica; tras terminar se comprobó por texto cada punto mutado y se corrió la suite completa.

## 2. Fragilidad de `turns-e2e` (revisada y reducida)

| Causa raíz | Corrección |
| --- | --- |
| `vi.waitFor` sin opciones tiene **1 s** de tope: con 70+ archivos usando PostgreSQL en paralelo, una respuesta tarda más y la prueba fallaba aunque el sistema estuviera bien | Cinco esperas (4 en `turns-e2e`, 1 en `turns`) pasan a esperar la **condición** con tope de 60 s (`until`): una prueba sana termina igual de rápido |
| Una prueba esperaba **100 ms fijos** para que un primer mensaje llegara al manejador antes del segundo; bajo carga el orden podía invertirse | Espera el **hecho** (`calls === 1`) |
| Esperar «salió el envío» y afirmar enseguida «estado `SENT_ACCEPTED`»: el estado se asienta un instante *después* del envío | Espera el **estado** final |

Antes: 3 fallas en una corrida completa (G3.2) y 1 en la primera corrida de G4.0; después: **0 fallas en 3 corridas completas consecutivas** (2 tras el último ajuste). No se puede demostrar que haya desaparecido del todo: quedan sleeps de 150–250 ms que *simulan* la duración de un envío (no son esperas del resultado) y los demás archivos usan `settle`.

## 3. Bloqueos (nada de esto se hizo)

| Sistema | Bloqueo | Efecto hoy |
| --- | --- | --- |
| **Supabase** | **Once** migraciones sin aplicar; sin staging autorizado; el mapeo HTTP real de PostgREST para las 4 RPC nuevas (`jsonb`, `text[]`, `numeric`, códigos `PT4xx`) sin verificar | Con la bandera y la 11 sin aplicar: fotos y estudios escritos responden el aviso técnico y no se cotiza nada (falla cerrado, probado) |
| **Laboratorio** | Textos de plantilla sin aprobar; sin decisión sobre cotización parcial dentro de una sesión; sin catálogo de alias ampliado | El resultado de una sesión es todo-o-nada; muchos nombres escritos quedarán «sin resolver» hasta ampliar alias |
| **Revisión humana** | **No existe** el flujo que consuma `plusmedik_quote_reviews`; la derivación a una persona sigue bloqueada (G5) | Los casos inciertos se registran pero nadie los ve; por eso el mensaje al paciente no promete una persona |
| **CRM** | Sin pantalla/lectura de la cola ni del resultado de las sesiones | Solo consulta SQL con `service_role` |
| **Kapso** | Sin verificar eventos de texto entrante/saliente ni la ventana de 24 h | Igual que G2.1 |
| **Dueño** | Despliegue de producción y variables sin confirmar | — |

## 4. Riesgos propios de G4.0

| # | Riesgo | Severidad | Mitigación / estado |
| --- | --- | --- | --- |
| R1 | **Más fricción**: el paciente de una sola foto ahora debe escribir «listo» (antes cotizaba al instante) | Media (producto) | Es el costo de «no cotizar antes de completar». Con la bandera apagada nada cambia. Alternativa a evaluar: cotizar solo al instante si llegó una única foto completa (decisión del laboratorio) |
| R2 | **Todo-o-nada**: una duda en un estudio retiene el precio de los demás (el flujo de una foto sola sí cotiza parcialmente) | Media | Deliberado para G4.0; G4.1 puede decidir cotización parcial con aviso explícito |
| R3 | **Frases de cierre**: «listo» exige un mensaje corto y sin negaciones; una variante no prevista no cierra | Baja | Lo no reconocido no cierra (falla seguro); la confirmación recuerda «escribe LISTO» |
| R4 | **Cierre sin entrega**: la sesión queda `QUOTED` aunque el envío se bloquee (p. ej. pausa humana entre ambos) | Baja | El resultado queda guardado y el envío auditado en la corrida; reenviar una cotización guardada es trabajo de G4.x |
| R5 | **Precio entre la carga del catálogo y el envío**: puede cambiar unos segundos | Baja | Se registra la huella del catálogo con el resultado |
| R6 | **Una foto perdida** (la ejecución murió tras anotarla): `listo` la ve como ilegible y pide reenviar | Baja | Probado; nunca se cotiza sin ella |
| R7 | **Cola sin consumidor y sin retención**: `plusmedik_quote_reviews` y las sesiones crecen sin purga (tablas inmutables) | Baja–media | Decisión de retención pendiente |
| R8 | **Texto escrito con relleno no previsto** («me gustaría saber el costo de…») queda sin resolver y va a revisión | Media (cobertura) | Seguro (nunca adivina); ampliar el relleno con casos reales |
| R9 | **Costo**: cada texto candidato recarga el catálogo (caché de 60 s en el cableado); cada «listo» lo recarga fresco | Baja | Acotado |
| R10 | **Hash de la foto** se guarda para detectar repetidas | Baja (privacidad) | Resumen irreversible del archivo, sin contenido; se puede reemplazar por HMAC si se prefiere |

## 5. Condiciones para ACTIVAR G4.0 (en números de prueba; nada se activó)

Orden estricto (primero migraciones, después banderas):
- [ ] Lo de **G2.1 §3**, **G3.1A §5** y **G3.2 §4** (turnos, textos aprobados, guarda de respuestas).
- [ ] Las **once** migraciones aplicadas y validadas en un Supabase de ensayo por HTTP real (en especial `plusmedik_quote_session_close` con `jsonb`/`numeric`/`text[]`).
- [ ] **Textos de `QUOTE_TEXTS` aprobados** por el laboratorio, y decisión sobre R1 y R2.
- [ ] Catálogo con **alias aprobados** suficientes (los nombres escritos solo se resuelven por nombre o alias exacto).
- [ ] Definir **quién revisa** la cola (CRM/G5) antes de que los pacientes dependan de ella; hasta entonces el mensaje no promete nada.
- [ ] Guion manual con dos números del equipo: dos fotos + texto + «listo»; foto repetida; estudio ambiguo; foto ilegible → reenviar; «listo» inmediato tras una foto; cancelar; vencimiento; pausa humana.
- [ ] Orden de banderas: … → `PLUSMEDIK_TURNS` → `PLUSMEDIK_REPLY_GUARD` → `PLUSMEDIK_TEXT_HANDLER` → **`PLUSMEDIK_QUOTE_SESSIONS`** (la última; sin el manejador de texto no tiene efecto).

## 6. Qué sigue (no hecho aquí)
- Staging con las 11 migraciones y verificación HTTP.
- G4.1: aclaraciones por texto (elegir entre estudios ambiguos), cotización parcial con aviso, reenvío de una cotización guardada.
- Lectura de la cola de revisión por el CRM / flujo humano (G5).
