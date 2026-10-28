# G0 · 04 Invariantes y roadmap por subfases

## 1. Invariantes (no se pueden debilitar en ninguna fase)

Se derivan del código y de los README actuales. Cada fase debe demostrar con pruebas que los conserva; una fase que los debilite se rechaza o se rediseña.

**Seguridad y exactitud**

1. **Falla cerrada.** Ante duda, error o dato ausente: no se cotiza lo dudoso, no se responde un hecho no aprobado, no se envía. Objetivo de producto `WRONG_AUTO = 0`.
2. **Los modelos leen/clasifican; el código decide.** Ningún modelo fija un precio, un código ni un hecho del laboratorio. Los precios salen solo de `lab_tests.price_bs` (tarifa Paciente salvo decisión explícita).
3. **El catálogo se lee, no se escribe en runtime.** Escrituras solo por scripts con `--apply` explícito y vista previa.
4. **El paciente solo ve `publicQuote`** (estudios, precios, "Total de los estudios cotizados"). Pendientes, bloqueos, motivos y UUID quedan en `internal`/CRM.
5. **Un alias aprobado es decisión del laboratorio**; las decisiones comerciales (perfiles, variantes por defecto, AM/PM, paquete vs suma) no se codifican sin su aprobación.

**Entrega, idempotencia y concurrencia (hoy en la rama phase6)**

6. **Webhook autenticado:** HMAC-SHA256 sobre el cuerpo crudo, tiempo constante, 401 sin secreto o firma válida.
7. **ACK 200 inmediato y trabajo en segundo plano**, sin cambiar la política de reintentos de Kapso sin un diseño explícito.
8. **Un mensaje, un procesamiento:** claim atómico por `message_id`, lease con fencing; toda escritura presenta `owner + fence`.
9. **Un solo envío por resultado:** reserva de envío concedida una vez bajo bloqueo de fila, confirmación inmediatamente antes de llamar a Kapso, y **un envío de resultado incierto jamás se reintenta**. Un mensaje no enviado se concilia; uno duplicado no se deshace.
10. **Atención humana:** una persona escribiendo desde WhatsApp Business pausa la IA para ese contacto hasta una reactivación explícita; sin clave de contacto o sin auditoría disponible, falla cerrado (no responde).

**Datos y operación**

11. **Privacidad por diseño:** logs solo con códigos y enumeraciones (teléfono enmascarado), auditoría sin imágenes, teléfonos ni texto clínico, `contact_key` por HMAC con clave dedicada. Todo dato clínico retenido (p. ej. el outbox) tiene dueño, acceso mínimo y vencimiento.
12. **Evidencia inmutable y transaccional** de lo que se analizó y se dijo (con versión de configuración, huella de catálogo y versión de cada registro de conocimiento).
13. **Modo offline y guarda de gasto:** ninguna prueba hace llamadas reales; las validaciones con modelos exigen `PLUSMEDIK_AUTHORIZE_PAID_CALLS` y un presupuesto autorizado. Hoy el tope vigente está superado (US$1,5894 de US$1,50): se requiere una nueva autorización antes de cualquier prueba paga.
14. **Aislamiento entre repositorios:** el CRM es el panel administrativo y nunca contiene el motor; el agente no escribe en el esquema `crm` ni el CRM en las tablas del agente. Se hablan solo por los contratos internos con tokens exclusivos y sin compartir secretos, claves HMAC ni credenciales de Kapso.

## 2. Principios de implementación del roadmap

- **Todo nuevo comportamiento nace apagado** (bandera con el valor exacto `on`), se prueba en offline y se activa primero para `ALLOWED_PHONES`.
- **Una migración por fase**, aditiva, ensayada en un branch/staging de Supabase antes de producción. Nada de SQL en G0.
- **Cada fase termina con:** pruebas (positivos, negativos, variaciones), `npm run check` en verde, documento actualizado, y una lista de lo que quedó sin verificar (como ya se hace en las fases 4x).
- **Mejoras por causa raíz**, no por receta; ningún valor del laboratorio se hardcodea.

## 3. Roadmap

Tamaño relativo: S (días) · M (1-2 semanas) · L (varias semanas), sin comprometer fechas. Las fases G2-G6 se activan de forma independiente con banderas.

### G1 · Convergencia y línea base — M

**(Actualizado por G1: la base ya está fusionada en `origin/main`; G1 verificó 1347 pruebas incluidas las de PostgreSQL real y dejó la rama `integration/g1-consolidacion`. Lo que sigue pendiente de G1 es solo la parte operativa: ensayar y aplicar migraciones, confirmar el despliegue y activar banderas en orden. Ver [../g1/](../g1/).)**
**Objetivo original:** una sola rama base verde que contenga el motor, el piloto y la base de seguridad (phase6).
**Trabajo:** decidir la ruta de integración (`origin/main` + `integration/fase5-cierre` + `feat/phase6-persistent-audit`); resolver los cambios sin commit del checkout actual; reinstalar dependencias donde falten; ejecutar la suite completa **incluidas las pruebas de base de datos con PostgreSQL local**; ensayar las 5 migraciones en un branch/staging (con autorización); configurar `REQUIRE_AUDIT_GUARD=on` y definir las variables del control humano; verificar en el número piloto una pausa y una reactivación reales; confirmar qué rama corre en Vercel; confirmar o retirar `handwrittenAuto: "on"`.
**Salida:** `npm run check` verde en la base; migraciones aplicadas en staging; runbook de despliegue actualizado.
**Depende de:** decisiones 1-3. **No incluye** funciones nuevas.

### G2 · Runtime de turnos — M/L

**Objetivo:** que cualquier mensaje entrante tenga el mismo tratamiento seguro que hoy tiene una imagen.
**Trabajo:** generalizar claim/lease/reserva de "imagen" a "turno" (cualquier `message.id` entrante) en una migración aditiva; router de eventos por tipo (texto, imagen, audio, PDF/documento, ubicación, reacción, otros) con política por tipo; tabla `plusmedik_conversations` mínima (estado enumerado, sin texto libre); bloqueo por `contact_key` para serializar turnos del mismo contacto; compositor de respuestas (plantillas) que reemplaza las constantes de `whatsapp-quote.ts`; acuse de recibo inmediato para recetas; respuesta fija a mensajes no soportados con oferta de persona; reglas deterministas de `HUMAN_REQUEST` y `OPT_OUT`.
**Salida:** ningún mensaje queda sin respuesta definida; imagen→cotización se comporta exactamente como antes (pruebas de no regresión).
**Depende de:** G1, texto aprobado de los mensajes fijos (decisión 5).

### G3 · Base de conocimiento — M/L (en paralelo con G2 tras definir el esquema)

**Objetivo:** responder horarios, ubicación, políticas y preparación solo desde registros aprobados.
**Trabajo:** migración `plusmedik_kb_*`, `plusmedik_study_prep`, perfiles; script de carga con vista previa y `--apply`; consulta de integridad contra `lab_tests`; clasificador de intención con esquema cerrado (configurable por `.env`); resolución de slots de fecha/sucursal/estudio; plantillas y verificador de hechos; handoff cuando no hay registro aprobado; "¿abierto ahora?" determinista con zona `America/La_Paz`.
**Salida:** batería offline de preguntas (positivas, negativas, variaciones, adversariales: ¿puedo tomar X antes de la prueba? ¿qué significa mi resultado?) con 0 hechos sin respaldo.
**Depende de:** datos reales del laboratorio (decisión 4); G2 para el envío.

### G4 · Cotización v2 — L

**Objetivo:** cotización completa y útil desde imágenes y texto.
**Trabajo:** sesión de cotización por contacto (varias imágenes, sin doble cobro); cotización desde texto reutilizando `shadowMatch` + verificador + `evaluatePartial`; preparación consolidada adjunta; vigencia con `catalogFingerprint`; caché del catálogo con invalidación (hoy se pide completo en cada imagen); interfaz `PriceBook` (solo Paciente); decisión sobre PDF/audio; contrato de cotización con el CRM si el dueño lo decide.
**Salida:** batería de recetas y textos sin regresión del 63/71 de referencia ni caída de precisión (100% en lo cotizado); validación con modelos reales solo con autorización y tope nuevo.
**Depende de:** G2, G3; decisiones 8-10 y 12.

### G5 · Handoff al CRM y control de atención — M/L

**Objetivo:** que ningún caso no resuelto se pierda y que el CRM pueda pausar/reactivar la IA.
**Trabajo:** `plusmedik_handoff_outbox` (misma transacción que la evidencia); emisor idempotente hacia `/api/internal/agent/review-case`; procesador de reintentos con alerta de `DEAD`; endpoints `attention/status` y `attention/action` con función SQL de pausa manual; mensajes de revisión humana con horario real; pruebas contra un doble del receptor del CRM que reproduce el contrato (200/409/503/413/401), sin tocar el CRM real.
**Salida:** el mismo `eventId` nunca crea dos casos; un `409` se recupera cuando el CRM ingiere; pausa manual idempotente por `operationId`.
**Depende de:** G2, decisiones 5-7 y 11; **y de que el CRM ingiera mensajes** (dependencia externa) y active sus variables. Se prueba contra el doble hasta entonces.

### G6 · Bucle de correcciones — M

**Objetivo:** que el trabajo de los revisores mejore el motor sin entrenamiento automático.
**Trabajo:** vía de lectura de correcciones (preferentemente exportación revisada); tabla de candidatas; agrupación y conflictos; lista de trabajo del laboratorio; promoción a alias con las herramientas existentes; generador de casos de regresión sin datos personales; tablero de métricas incluyendo falsos AUTO.
**Salida:** una corrección aprobada se vuelve alias o caso de regresión con trazabilidad completa; ningún cambio automático en producción.
**Depende de:** G5 y de acordar con el CRM la vía de lectura (§7.5 del documento 03).

### G7 · Piloto endurecido y salida a producción — M

**Objetivo:** abrir más allá de `ALLOWED_PHONES` con control de riesgo y costo.
**Trabajo:** límites por contacto (mensajes/hora, imágenes/día) y presupuesto diario de IA aplicado en el runtime, con interruptor general (`kill switch`); alertas (DLQ, `SEND_UNKNOWN`, fallos de IA, latencia); recuperación periódica activa; prueba de carga y de caos (proveedor de IA caído, Supabase lento, Kapso duplicando eventos, humano escribiendo durante el análisis); runbook y guía de conciliación de `SEND_UNKNOWN`; despliegue por cohortes (lista blanca → porcentaje → general); revisión de privacidad y retención.
**Salida:** lista de verificación de salida firmada por el dueño; plan de reversa probado.
**Depende de:** todas las anteriores.

### Orden y paralelismo

```
G1 ──▶ G2 ──▶ G4 ──▶ G7
        │ ╲      ╲
        │  ╲      ╲─▶ G5 ──▶ G6 ──▶ G7
        └──▶ G3 ──▶ G4
```

G3 puede empezar junto con G2 una vez definido el esquema. G5 puede construirse contra el doble del CRM mientras el CRM completa su lado.

## 4. Qué NO está en este roadmap

- Cambios al CRM (aunque varias fases dependen de que el CRM haga su parte).
- Cambiar modelos o prompts de lectura "para ahorrar": solo con la batería y autorización.
- Pagos, pedidos, agendamiento de citas y resultados de laboratorio por WhatsApp: no se pidieron en G0; cada uno es un dominio de riesgo propio y requeriría su fase y su contrato.
- Entrenamiento o ajuste fino con correcciones.

## 5. Verificaciones pendientes antes de G5/G2 (no se pudieron hacer en G0)

| Qué | Por qué importa |
| --- | --- |
| Reglas vigentes de Meta/Kapso para mensajes fuera de la ventana de 24 h (plantillas aprobadas) | Un aviso de seguimiento humano fuera de ventana puede requerir una plantilla; no se verificó en la documentación |
| Que Kapso entregue el mismo evento al webhook del agente y al del CRM sin sustituirlo | Prerrequisito del CRM; hoy sin verificar |
| Qué evento exacto trae el eco de un mensaje enviado desde WhatsApp Business | La documentación de Kapso no lo precisa; la clasificación actual se apoya en `direction` + `origin` + estado |
| ~~Pruebas de la rama phase6 (incluida su base de datos efímera)~~ | Hechas en G1: 52 archivos, 1347 pruebas en verde con PostgreSQL 18 efímero |
| Rama desplegada en Vercel y variables reales | No visibles desde el repositorio |
