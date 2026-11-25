# Fotos de recetas: coordinación entre la lectura y las reglas de cotización

Actualizado el 25-nov-2026. Es para quien trabaja en la **lectura de las imágenes** de recetas, y para su asistente de código.

La idea es simple: tú haces que la foto se lea bien; nosotros, que una vez leída el agente sepa qué cotizar. Trabajamos en paralelo y sin pisarnos.

## División del trabajo

| Parte | Quién | Archivos principales |
|---|---|---|
| Lectura de la imagen: lectores, consenso, juez, tipo de documento, líneas y grupos | Lectura (tú) | `src/ai.ts`, `src/consensus.ts`, `src/judge.ts`, `src/document-signal.ts`, `src/line-groups.ts` |
| Búsqueda semántica de un estudio leído en el catálogo | Lectura (tú); avisas si falta un alias o un estudio | `src/catalog-shadow.ts` |
| Reglas de decisión compartidas entre texto y foto | Reglas (nosotros) | `src/study-choice.ts` |
| Conectar las reglas al resultado de la foto y armar la lista de opciones | Reglas (nosotros); avisamos antes de tocar | `src/analyze.ts` (`labRuleFor`), `src/quote-options.ts`, `src/whatsapp-quote.ts` |
| Información del laboratorio: alias, estudios, precios y preparación | Reglas (nosotros) | base de datos (`lab_tests`, `lab_test_aliases`) y scripts de carga |

`src/analyze.ts` lo tocamos los dos: quien lo vaya a cambiar avisa antes.

## Qué decide ya la foto con las reglas del laboratorio

Desde los PR #78 y #79, cuando un estudio **se leyó con certeza** y el modelo duda entre opciones del catálogo, la foto decide igual que la cotización por texto (`decideFromReading` en `src/study-choice.ts`, contraste `LAB_RULE` en `src/analyze.ts`):

- **Versiones del mismo estudio sin método:** la más barata. Por ejemplo, «TSH» → ECLIA (Bs 90).
- **Total o libre sin especificar:** el TOTAL. Por ejemplo, «T4».
- **Clase de anticuerpo sin especificar:**
  - IgG + IgM; por ejemplo, toxoplasma y citomegalovirus;
  - salvo el anticore, que cotiza el TOTAL.
- **Sangre u otra muestra:** la de sangre, salvo que el documento declare otra muestra.
- **Elecciones fijas del laboratorio:**

  | Pedido | Se cotiza |
  |---|---|
  | chagas | HAI |
  | HCG | cualitativa |
  | ionograma | ionograma 1 |
  | coagulograma | TP+INR, APTT y fibrinógeno |
  | vitamina D | 25 (OH) FIA |
  | colesterol | total |
  | micológico | directo KOH |
  | panel respiratorio | el de 20 patógenos |
  | galactomanano | antígeno ELISA |
  | herpes | tipo 1 y 2 |
  | antígeno de superficie / HBsAg | prueba rápida |
  | anti-HBs | prueba rápida |

- **El mismo examen con otro nombre:** urea = BUN (se cotiza UREA). ANA, giardia y anti-CCP: el más barato, salvo que la receta escriba el método.
- **Línea igual al nombre de una opción:** si la línea es exactamente el nombre de una de las opciones («GLUCOSA», «AMONIO»), se cotiza esa.
- **Carga viral:** solo entra si la receta la nombra.
- **Datos que solo tiene el paciente:** no se elige nada; se muestran las opciones con su precio y se le pide el dato.
  - Cultivo de secreción: la zona (todas cuestan Bs 90).
  - Microalbuminuria: 24 horas u ocasional (las dos cuestan Bs 150).
  - Biopsia: el tamaño de la muestra; se muestra «desde Bs 500», sin lista, y la doctora confirma el precio.

Sigue en duda, **a propósito**, la que hay entre estudios distintos: hepatitis B antígeno o anticore, FSH o LH, HAI chagas o toxo. Ahí el médico especifica y **la lectura tiene que captarlo**.

## Notas para la lectura

Son casos reales de producción que quedaron en duda por cómo se leyó la línea, no por falta de regla. Las reglas no pueden ayudar aquí:

- **«FSH/LH» en una línea:** son dos hormonas distintas. Deben salir como **dos estudios**, no como una duda entre FSH y LH.
- **«HAI» sin decir chagas o toxo (6 casos):** quedaron en duda entre HAI CHAGAS y HAI TOXO.
  - Si la receta nombra los dos, son dos estudios.
  - Si solo dice «HAI», hay que ver qué dice al lado.
- **Una línea que solo dice «IgM» (2 casos):** el modelo dudó entre unos 50 estudios. Probablemente la lectura cortó el nombre del estudio, por ejemplo el «Toxo» o el «CMV» de otra columna.
- **Glucosa o insulina postprandial (1 caso):** revisar si la línea mezcla dos estudios, como una curva de glucosa e insulina.
- **Hepatitis B:** el médico especifica el marcador:
  - antígeno de superficie (HBsAg);
  - anticore (anti-HBc);
  - antígeno e;
  - anticuerpo de superficie (anti-HBs).

  La lectura debe conservar esas palabras. Si solo llega «Hepatitis B», no se puede cotizar solo.
- **Copiar la línea tal cual:** si la lectura es exactamente el nombre de un estudio del catálogo, se cotiza ese aunque el modelo dude. Conviene no agregar ni quitar palabras a la línea.

## Cómo reportar un error de foto

Primero mira si el agente **leyó bien** el texto. Eso decide de quién es el arreglo:

| Lo que ves | De quién es | Qué hacer |
|---|---|---|
| Leyó mal, se saltó una línea o no reconoció el documento | Lectura | Se arregla en la lectura |
| Leyó bien, pero no encontró el estudio en el catálogo | Reglas: falta un alias o el estudio | Nos lo pasas con lo que dice la receta |
| Leyó bien y lo encontró, pero eligió otra versión o lo dejó en duda | Reglas | Nos lo pasas; lo decidimos con el laboratorio |
| Leyó bien y no estás seguro | Los dos | Nos lo pasas igual |

Cada reporte lleva:

1. El id de la conversación y la fecha, sin datos del paciente.
2. Lo que dice la receta, tal cual.
3. Lo que leyó el agente.
4. Lo que cotizó o dejó en duda.
5. Lo que debió cotizar, si lo sabes.

## Coordinación

- **Ramas y PR:** cada uno trabaja en su propia rama desde `main` y abre un PR.
- **`src/analyze.ts`:** quien lo vaya a cambiar avisa antes.
- **Base de datos:** se cambia solo con script, primero en modo prueba, y con `--apply` para escribir. El modelo es `scripts/apply-lab-answers-24nov.ts`.
- **Pruebas de las reglas:** `tests/reglas-fotos.test.ts` y `tests/reglas-lab-25nov.test.ts`. Si un cambio de lectura las rompe, avísanos antes de cambiarlas.
