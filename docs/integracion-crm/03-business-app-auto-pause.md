# Pausa automática de la IA cuando una asesora responde desde WhatsApp Business

La intervención es un mensaje SALIENTE con origin business_app, registrado por Kapso.
Solo afecta a los contactos que son pilotos conversacionales: el original y los dos adicionales.
Los otros pacientes y los mensajes del propio bot (cloud_api) no cambian.

La pausa de cada contacto dura 10 minutos desde la última intervención de una asesora.
Cada nuevo mensaje humano extiende el plazo. El siguiente mensaje entrante tras vencer
el plazo ejecuta una comprobación y reactivación ATÓMICA en Supabase, usando FOR UPDATE.
Esta reactivación es perezosa: sin un mensaje entrante, el estado persistido sigue pausado.
Las pausas manuales del CRM son independientes y no expiran por este mecanismo.

No se requiere nueva variable de entorno ni configuración del celular.
IMPORTANTE: la migración 20261105000000_plusmedik_human_idle_resume.sql
debe aplicarse a la base ANTES de desplegar el nuevo código, o los pilotos
quedarán silenciados (falla cerrado al no poder comprobar el vencimiento).

Pruebas: intervención desde WhatsApp Business, silencio dentro de 10 minutos,
reintervención humana que reinicia el plazo, primer mensaje después de 10 minutos
que obtiene respuesta, aislamiento entre contactos, no afectar pausas CRM.
