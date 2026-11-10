# Textos fijos del agente — para aprobación del laboratorio

> GENERADO por `npx tsx scripts/agent-config.ts texts --write` a partir del código. No editar a mano: para cambiar un texto, editar la constante indicada y regenerar.
> Estado: **BORRADORES sin aprobar**. Ninguno contiene cifras, importes, plazos ni horarios (el constructor del manejador lo rechaza). Solo los marcados abajo prometen a una persona, y solo se envían con el caso ya registrado en el CRM.
> Son los textos de la ruta determinista (siempre disponible y usada como respaldo). La conversación con el modelo se configura en `src/system-prompt.ts`.
> Los marcadores entre llaves (`{study}`, `{max}`…) los rellena el sistema con datos aprobados o del catálogo.

## Conversación (`src/text-handler.ts` · `DRAFT_TEXTS`)

| Clave | Cuándo se usa | Texto actual (BORRADOR) | Aprobado por / fecha |
| --- | --- | --- | --- |
| `greeting` | Saludo cuando el paciente solo saluda. | ¡Hola! 👋 Soy la recepcionista virtual de PlusMedik. ¿En qué puedo ayudarte? Escríbeme los estudios que necesitas y te paso la cotización, o envíame una foto de tu receta si la tienes. | |
| `send_recipe` | Pide la foto de la receta cuando el mensaje es un pedido de cotización sin foto. | Con gusto te ayudo a cotizar. Escríbeme los nombres de los estudios que necesitas o, si la tienes a mano, envíame una foto de tu receta. | |
| `fallback` | Mensaje que no se entiende ni se puede derivar. | Con gusto te ayudo. ¿Qué estudio necesitas o qué te gustaría saber? Puedes escribirme su nombre o, si prefieres, enviar una foto de tu receta. | |
| `handoff_confirmed` | Confirma la derivación a una persona. SOLO se envía con el caso ya registrado en el CRM. | Recibimos tu solicitud. Una persona del equipo la revisará y te escribirá por este chat. | |
| `handoff_unavailable` | Se envía cuando la derivación no se pudo registrar: no promete a una persona. | Recibimos tu consulta. Un asesor la revisará y te atenderá lo antes posible por este chat. | |
| `medical_unavailable` | Consulta médica sin caso registrado: sin orientación médica y aviso de urgencias. | Recibimos tu mensaje. No puedo darte orientación médica por este chat. Si es una urgencia, comunícate con los servicios de emergencia de tu localidad. | |
| `medical_handoff_confirmed` | Consulta médica con caso registrado: conserva el aviso de urgencias y promete a una persona. | Recibimos tu mensaje. No puedo darte orientación médica por este chat. Si es una urgencia, comunícate con los servicios de emergencia de tu localidad. Una persona del equipo revisará tu mensaje y te escribirá por este chat. | |

## Sesión de cotización (`src/quote-session.ts` · `QUOTE_TEXTS`)

| Clave | Cuándo se usa | Texto actual (BORRADOR) | Aprobado por / fecha |
| --- | --- | --- | --- |
| `added_image` | Acuse al recibir una foto. | Recibí tu foto. | |
| `added_text` | Acuse al anotar estudios escritos. | Anoté lo que escribiste. | |
| `more_hint` | Indica que puede enviar más y que escriba LISTO para cotizar. | Puedes enviar otra foto o escribir más estudios. Cuando termines, escribe LISTO y te paso la cotización. | |
| `uncertain_note` | Aviso de que algo no se identificó con certeza. | Hay algo que no pude identificar con certeza; te lo indicaré al cotizar. | |
| `duplicate_image` | Foto repetida: no se cuenta dos veces. | Esa foto ya la tenía, no la conté dos veces. Cuando termines, escribe LISTO. | |
| `full` | Se alcanzó el máximo de mensajes de la solicitud. | Ya tengo muchos mensajes en esta solicitud. Escribe LISTO para cotizar lo que tengo. | |
| `empty` | Escribió LISTO sin estudios anotados. | Todavía no tengo estudios anotados. Envíame la foto de tu receta o escribe los nombres de los estudios y después escribe LISTO. | |
| `resend` | Algunas fotos no se pudieron leer. | No pude leer algunas de tus fotos. Envíalas de nuevo (más claras y completas) o escribe los estudios, y después escribe LISTO. | |
| `review` | Estudios inciertos: no se da precio y no se promete a una persona. | No pude identificar con certeza algunos estudios de tu solicitud, así que no te doy un precio para no equivocarme. Puedes enviar una foto más clara o escribir el nombre exacto del estudio. | |
| `review_confirmed` | Estudios inciertos con el caso ya registrado en el CRM: promete a una persona. | No pude identificar con certeza algunos estudios de tu solicitud, así que no te doy un precio para no equivocarme. Una persona del equipo la revisará y te escribirá por este chat. | |
| `cancelled` | Solicitud cancelada por el paciente. | Listo, borré tu solicitud. Cuando quieras, envíame una nueva foto o escribe los estudios. | |
| `nothing_to_cancel` | Quiso cancelar sin solicitud abierta. | No tenías ninguna solicitud abierta. | |
| `waiting` | Aún se procesan mensajes anteriores. | Sigo procesando tus mensajes anteriores. Escribe LISTO de nuevo en un momento. | |
| `repeated_note` | Aviso de estudios repetidos contados una vez. | Si repetiste algún estudio, lo conté una sola vez. | |
| `unreadable_image` | Imagen ilegible. | No pude leer esa imagen. Envíala de nuevo como foto, clara y completa. | |
| `identified_so_far` | Encabezado de la lista de estudios anotados (los nombres salen del catálogo). | Estudios anotados: | |
| `confirm_done` | Pregunta si eso es todo, tras anotar estudios escritos sin pedir cotizar. «SÍ» o «LISTO» cotiza. | ¿Eso es todo? Responde SÍ y te paso la cotización, o envíame los estudios que falten. | |
| `ask_option_intro` | Introduce las opciones numeradas cuando un nombre corresponde a varios estudios del catálogo. | Para uno de los estudios tengo varias opciones: | |
| `ask_option_outro` | Indica cómo elegir una opción (número o nombre exacto). | Responde con el número o escribe el nombre exacto del estudio. | |
| `ask_unresolved` | Pide el nombre exacto o una foto cuando algo no se pudo identificar. No promete a nadie. | No pude identificar con certeza algunos estudios. Escribe el nombre exacto de cada uno o envía una foto de tu receta. Si no los encuentras, escribe LISTO y dejaré tu solicitud en revisión. | |
| `choose_invalid` | La opción respondida no existe en la lista. | No encontré esa opción. Responde con el número de la lista o escribe el nombre exacto del estudio. | |
| `not_done` | El paciente dijo que aún falta algo: se espera lo que envíe. | De acuerdo, sigo esperando. Envíame los estudios que faltan y después responde SÍ o escribe LISTO. | |

## Respuestas con conocimiento aprobado (`src/knowledge-answers.ts` · `ANSWER_TEXTS`)

| Clave | Cuándo se usa | Texto actual (BORRADOR) | Aprobado por / fecha |
| --- | --- | --- | --- |
| `hoursTitle` | Título de cada horario; {service} = nombre del servicio. | {service} | |
| `noOtherHours` | — | De otras sucursales no tengo ese horario disponible por ahora. | |
| `noOtherBranches` | — | De otras sucursales no tengo datos disponibles por ahora. | |
| `noOtherMethods` | — | Puede haber otros métodos de pago de los que no tengo información disponible por ahora. | |
| `paymentTitle` | — | Métodos de pago | |
| `accepted` | — | Aceptamos | |
| `notAccepted` | — | No aceptamos | |
| `unavailableTopics` | Aviso de los temas sin dato aprobado; {topics} = lista de temas. | Sobre {topics} no tengo información disponible por ahora. | |
| `askStudy` | Pide el nombre del estudio para indicar la preparación. | Para indicarte la preparación necesito el nombre del estudio. ¿Cuál es? También puedes enviarme una foto de tu receta. | |
| `noPreparation` | — | el laboratorio indica que no requiere preparación. | |
| `prepMissing` | No hay preparación aprobada para el estudio; {study}. | No tengo la preparación de {study} disponible por ahora. | |
| `prepNotCombined` | — | Estas indicaciones son por cada estudio; no puedo indicarte cómo combinarlas. | |
| `prepAmbiguous` | — | No pude identificar con certeza uno de los estudios que mencionas, por lo que no te indico su preparación. | |
| `noScheduleOtherDays` | — | No hay horario registrado para los demás días. | |
| `nowOpen` | — | En este momento: abierto. | |
| `nowClosed` | — | En este momento: cerrado. | |
| `todayClosed` | — | Hoy ({date}): cerrado | |
| `today` | — | Hoy ({date}): {hours} | |
| `studyAmbiguous` | — | No pude identificar con certeza uno de los estudios que mencionas, por lo que no te indico sus datos. | |
| `askStudyInfo` | Pide el nombre del estudio para plazo o muestra. | Para indicártelo necesito el nombre del estudio. ¿Cuál es? También puedes pedírmelo después de cotizar tu receta. | |
| `turnaroundLabel` | — | Tiempo de entrega | |
| `turnaroundMissing` | No hay plazo aprobado para el estudio; {study}. | No tengo el tiempo de entrega de {study} disponible por ahora. | |
| `upTo` | — | hasta {max} {unit} | |
| `between` | — | entre {min} y {max} {unit} | |
| `hoursUnit` | — | horas | |
| `daysUnit` | — | días | |
| `businessDays` | — | hábiles | |
| `calendarDays` | — | calendario | |
| `fromCollection` | — | contado desde la toma de la muestra | |
| `fromReceipt` | — | contado desde la recepción de la muestra en el laboratorio | |
| `sampleLabel` | — | Tipo de muestra | |
| `requirementsLabel` | — | Requisitos | |
| `noSpecialRequirements` | — | el laboratorio indica que no tiene requisitos especiales. | |
| `sampleMissing` | No hay muestra ni requisitos aprobados; {study}. | No tengo el tipo de muestra ni los requisitos de {study} disponibles por ahora. | |
| `contextIntro` | Introduce los datos de los estudios de la última cotización. | Sobre los estudios de tu última cotización: | |
| `hourUnit` | — | hora | |
| `dayUnit` | — | día | |
| `businessDayOne` | — | hábil | |

