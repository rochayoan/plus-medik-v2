import { describe, expect, it, vi } from "vitest";
import { ANSWER_TEXTS, answerFromKnowledge, assertSafeAnswerTexts, detectTopics, findStudyMentions, lazyKnowledge, MAX_STUDIES, ttlCache, UnsafeAnswerTextError, type KnowledgeAnswer, type Topic } from "../src/knowledge-answers.js";
import { KnowledgeService } from "../src/knowledge/index.js";
import { normalizeStudyKey } from "../src/consensus.js";
import type { CatalogStudy } from "../src/types.js";
import { branch, faq, iso, item, MemoryStore, payment, policy, preparation, schedule, STUDY_A, STUDY_B, STUDY_INACTIVE, T0 } from "./support/knowledge-fixtures.js";

// Respuestas con conocimiento APROBADO, sin base de datos: detección de tema, identificación del estudio, plantillas y la regla central: NADA se inventa. Todos los datos son
// fixtures de PRUEBA. La integración con el manejador está en tests/text-handler-knowledge.test.ts y, contra PostgreSQL real, en tests/knowledge-answers-e2e.test.ts.

const study = (id: string, name: string, aliases: string[] = [], active = true): CatalogStudy => ({ id, code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs: 999, active });
const CATALOG: CatalogStudy[] = [
  study(STUDY_A, "ESTUDIO ALFA DE PRUEBA", ["alfa"]),
  study(STUDY_B, "ESTUDIO BETA DE PRUEBA", ["beta", "tsb"]),
  study("55555555-5555-4555-8555-555555555555", "GLUCOSA DE PRUEBA", ["glucosa"]),
  study("66666666-6666-4666-8666-666666666666", "GLUCOSA POSTPRANDIAL DE PRUEBA", ["glucosa postprandial"]),
  study("77777777-7777-4777-8777-777777777777", "GAMMA UNO DE PRUEBA", ["gamma"]),
  study("88888888-8888-4888-8888-888888888888", "GAMMA DOS DE PRUEBA", ["gamma"]),
  study(STUDY_INACTIVE, "ESTUDIO INACTIVO DE PRUEBA", ["inactivo"], false)
];
const GLU = "55555555-5555-4555-8555-555555555555";
const GLU_POST = "66666666-6666-4666-8666-666666666666";

const make = (items: unknown[], options: { catalog?: CatalogStudy[] | "throws"; now?: Date } = {}) => {
  const store = new MemoryStore({ revision: 1, items });
  const now = options.now ?? T0;
  const service = new KnowledgeService({ store, now: () => now, revisionCheckMs: 15_000, maxStaleMs: 300_000 });
  const loadCatalog = vi.fn(async () => { if (options.catalog === "throws") throw new Error("catálogo caído"); return options.catalog ?? CATALOG; });
  return { store, service, loadCatalog, now, items, ask: (text: string) => answerFromKnowledge(text, { service, loadCatalog, now: () => now }) };
};

// Verificación de hechos: todo número de la respuesta sale de un registro aprobado que la respalda (o es la fecha local del propio día consultado).
const numbersIn = (text: string) => text.match(/\d+/g) ?? [];
function factCheck(answer: KnowledgeAnswer, items: unknown[], extraAllowed: string[] = []) {
  const used = new Set(answer.refs.map((ref) => `${ref.kind}|${ref.key}`));
  const allowed = new Set([...numbersIn(JSON.stringify(items.filter((entry) => used.has(`${(entry as { kind: string }).kind}|${(entry as { key: string }).key}`)).map((entry) => (entry as { payload: unknown }).payload))), ...extraAllowed.flatMap(numbersIn)]);
  const stray = numbersIn(answer.body).filter((number) => !allowed.has(number));
  expect(stray, `números sin respaldo: ${stray.join(",")}\n${answer.body}`).toEqual([]);
}

describe("detectTopics: qué se pregunta", () => {
  const topicsOf = (text: string) => detectTopics(text).map((topic) => (topic.kind === "HOURS" ? `HOURS:${topic.service}` : topic.kind === "POLICY" ? `POLICY:${topic.topic}` : topic.kind));
  const cases: Array<[string, string[]]> = [
    ["¿a qué hora abren?", ["HOURS:OFFICE"]], ["cuál es el horario de atención", ["HOURS:OFFICE"]], ["hasta que hora atienden hoy", ["HOURS:OFFICE"]], ["HORARIO!!", ["HOURS:OFFICE"]],
    ["horario de toma de muestras", ["HOURS:SAMPLE_COLLECTION"]], ["a qué hora entregan los resultados", ["HOURS:RESULTS_PICKUP"]], ["horario de toma a domicilio", ["HOURS:HOME_SAMPLING"]], ["horario de toma de muestras y entrega de resultados", ["HOURS:SAMPLE_COLLECTION", "HOURS:RESULTS_PICKUP"]],
    ["dónde están ubicados", ["LOCATION"]], ["su dirección por favor", ["LOCATION"]], ["tienen sucursales", ["LOCATION"]], ["cómo llego", ["LOCATION"]],
    ["aceptan tarjeta", ["PAYMENT"]], ["se puede pagar con qr", ["PAYMENT"]], ["pagan en efectivo", ["PAYMENT"]], ["métodos de pago", ["PAYMENT"]],
    ["cuándo entregan los resultados", ["POLICY:RESULTS_DELIVERY"]], ["cuando salen mis resultados", ["POLICY:RESULTS_DELIVERY"]], ["hacen toma a domicilio", ["POLICY:HOME_SAMPLING"]], ["emiten factura", ["POLICY:INVOICING"]],
    ["trabajan con convenio", ["POLICY:CONVENIOS"]], ["aceptan mi seguro", ["POLICY:CONVENIOS"]], ["puedo agendar una cita", ["POLICY:APPOINTMENTS"]],
    ["necesito ayuno para la glucosa", ["PREPARATION"]], ["cómo debo prepararme", ["PREPARATION"]], ["tengo que ir en ayunas", ["PREPARATION"]],
    ["horario y dirección", ["HOURS:OFFICE", "LOCATION"]], ["dirección, horario y formas de pago", ["HOURS:OFFICE", "LOCATION", "PAYMENT"]],
    ["hola", []], ["gracias", []], ["tienen estacionamiento", []], ["cuánto cuesta", []]
  ];
  for (const [text, expected] of cases) it(`«${text}» → ${expected.join(", ") || "ningún tema"}`, () => expect(topicsOf(text)).toEqual(expected));

  it("se acota a 3 temas, ignora mayúsculas/tildes/signos y no falla con textos enormes", () => {
    expect(detectTopics("horario, dirección, pago con tarjeta, factura, convenio y ayuno")).toHaveLength(3);
    expect(topicsOf("¿¿HORARIO??   DE   ATENCIÓN")).toEqual(["HOURS:OFFICE"]);
    expect(detectTopics("x".repeat(500_000))).toEqual([]);
  });
});

describe("findStudyMentions: solo coincidencias exactas con el catálogo", () => {
  const ids = (text: string, catalog = CATALOG) => findStudyMentions(text, catalog).studies.map((s) => s.id).sort();
  it("nombre normalizado o alias aprobado como palabras completas, sin importar tildes ni mayúsculas", () => {
    expect(ids("¿Necesito ayuno para el ESTUDIO ALFA de prueba?")).toEqual([STUDY_A]);
    expect(ids("ayuno para alfa")).toEqual([STUDY_A]);
    expect(ids("ayuno para beta y para TSB")).toEqual([STUDY_B]);
    expect(ids("ayuno para alfa y beta")).toEqual([STUDY_A, STUDY_B].sort());
  });
  it("no coincide dentro de otra palabra, ni con estudios inactivos, ni con frases demasiado cortas", () => {
    expect(ids("alfabeto")).toEqual([]);
    expect(ids("prealfa")).toEqual([]);
    expect(ids("ayuno para inactivo")).toEqual([]);
    expect(ids("ayuno", [study("99999999-9999-4999-8999-999999999999", "ab", ["ab"])])).toEqual([]);
    expect(ids("")).toEqual([]);
  });
  it("la frase más específica gana ('glucosa postprandial' no se confunde con 'glucosa'); la más corta sola identifica la corta", () => {
    expect(ids("ayuno para glucosa postprandial")).toEqual([GLU_POST]);
    expect(ids("ayuno para glucosa")).toEqual([GLU]);
  });
  it("un alias que pertenece a más de un estudio es AMBIGUO y no identifica a ninguno", () => {
    const result = findStudyMentions("ayuno para gamma", CATALOG);
    expect(result.studies).toEqual([]);
    expect(result.ambiguous).toEqual(["gamma"]);
  });
});

describe("respuestas: horarios", () => {
  const OFFICE = [branch("branch-prueba"), schedule()];

  it("responde con el horario aprobado, agrupado por día, con la sucursal; sin 'hoy' ni 'ahora' si no hay excepción ni se pregunta por ello", async () => {
    const t = make(OFFICE);
    const answer = (await t.ask("¿cuál es el horario?"))!;
    expect(answer.body).toBe(["*SUCURSAL DE PRUEBA* — Horario de atención", "Lunes: 08:00 a 12:00 y 14:00 a 18:00", "Sábado: 09:00 a 11:00", ANSWER_TEXTS.noScheduleOtherDays].join("\n"));
    expect(answer.status).toBe("ANSWERED");
    expect(answer.refs.map((ref) => ref.key).sort()).toEqual(["branch-prueba", "schedule:branch-prueba:office"]);
    factCheck(answer, t.items);
  });

  it("'ahora/hoy': agrega si está abierto en este momento según la zona horaria del horario (lunes 11:00 local = abierto)", async () => {
    const open = (await make(OFFICE).ask("¿están abiertos ahora? ¿a qué hora cierran?"))!;
    expect(open.body).toContain(ANSWER_TEXTS.nowOpen);
    const closed = (await make(OFFICE, { now: new Date("2026-11-02T17:00:00Z") }).ask("¿abren ahora? horario"))!; // 13:00 local
    expect(closed.body).toContain(ANSWER_TEXTS.nowClosed);
  });

  it("una excepción del día (feriado) se informa con su nota; el horario especial también", async () => {
    const holiday = (await make(OFFICE, { now: new Date("2026-11-09T15:00:00Z") }).ask("horario"))!;
    expect(holiday.body).toContain("Hoy (2026-11-09): cerrado — FERIADO DE PRUEBA");
    factCheck(holiday, OFFICE, ["2026-11-09"]);
    const special = (await make(OFFICE, { now: new Date("2026-11-10T14:00:00Z") }).ask("horario"))!;
    expect(special.body).toContain("Hoy (2026-11-10): 10:00 a 11:00");
  });

  it("servicios distintos: toma de muestras y entrega de resultados usan SU horario; si no está aprobado no se usa el de oficina", async () => {
    const items = [branch(), schedule(), schedule({ key: "schedule:branch-prueba:muestras", payload: { branchKey: "branch-prueba", service: "SAMPLE_COLLECTION", timezone: "America/La_Paz", weekly: [{ day: 2, opens: "07:00", closes: "09:00" }] } })];
    const samples = (await make(items).ask("horario de toma de muestras"))!;
    expect(samples.body).toContain("Horario de toma de muestras");
    expect(samples.body).toContain("Martes: 07:00 a 09:00");
    expect(samples.body).not.toContain("Lunes");
    expect(await make(items).ask("a qué hora entregan los resultados")).toBeUndefined();
  });

  it("varias sucursales: cada una con su horario; si de una falta el horario, se dice que de otras no hay información (no se inventa ni se copia el de la otra)", async () => {
    const items = [branch("branch-a"), branch("branch-b"), schedule({ key: "schedule:a", payload: { branchKey: "branch-a", service: "OFFICE", timezone: "America/La_Paz", weekly: [{ day: 3, opens: "08:00", closes: "09:00" }] } })];
    const answer = (await make(items).ask("horario"))!;
    expect(answer.body.match(/\*SUCURSAL DE PRUEBA\*/g)).toHaveLength(1);
    expect(answer.body).toContain("Miércoles: 08:00 a 09:00");
    expect(answer.body).toContain(ANSWER_TEXTS.noOtherHours);
    expect(answer.refs.map((ref) => ref.key).sort()).toEqual(["branch-a", "schedule:a"]);
  });

  it("sin sucursal, horario vencido o sin horario: no hay respuesta (undefined) y NO se usan datos de otro servicio", async () => {
    expect(await make([schedule()]).ask("horario")).toBeUndefined();
    expect(await make([branch()]).ask("horario")).toBeUndefined();
    expect(await make([branch(), schedule({ validUntil: iso(-1) })]).ask("horario")).toBeUndefined();
    expect(await make([]).ask("horario")).toBeUndefined();
  });
});

describe("respuestas: sucursales, pagos, políticas y preguntas frecuentes", () => {
  it("sucursales: nombre, dirección, mapa, teléfono y notas aprobados; avisa si alguna no está disponible", async () => {
    const items = [item({ kind: "BRANCH", key: "branch-uno", payload: { name: "SUCURSAL UNO DE PRUEBA", address: "DIRECCION UNO DE PRUEBA", mapsUrl: "https://mapa.example/prueba", phone: "+591 7000 0001", notes: "NOTA DE PRUEBA" } }), branch("branch-dos", { validUntil: iso(-1) })];
    const t = make(items);
    const answer = (await t.ask("¿dónde están ubicados?"))!;
    expect(answer.body).toBe(["*SUCURSAL UNO DE PRUEBA*", "DIRECCION UNO DE PRUEBA", "https://mapa.example/prueba", "Teléfono: +591 7000 0001", "NOTA DE PRUEBA", "", ANSWER_TEXTS.noOtherBranches].join("\n"));
    factCheck(answer, items);
  });

  it("pagos: lo aceptado y lo NO aceptado tal como lo aprobó el laboratorio; avisa si falta un método (vencido)", async () => {
    const items = [payment("efectivo"), payment("tarjeta", false), payment("qr", true, { validUntil: iso(-1) })];
    const answer = (await make(items).ask("¿aceptan tarjeta o efectivo?"))!;
    expect(answer.body).toContain("Aceptamos: METODO EFECTIVO DE PRUEBA");
    expect(answer.body).toContain("No aceptamos: METODO TARJETA DE PRUEBA");
    expect(answer.body).toContain(ANSWER_TEXTS.noOtherMethods);
    expect(answer.body).not.toContain("QR");
  });

  it("políticas por tema reconocido: título y cuerpo aprobados; un tema sin política aprobada no se responde", async () => {
    const items = [policy({ key: "policy:resultados", payload: { topic: "RESULTS_DELIVERY", title: "ENTREGA DE RESULTADOS DE PRUEBA", body: "CUERPO DE PRUEBA" } })];
    const answer = (await make(items).ask("¿cuándo entregan los resultados?"))!;
    expect(answer.body).toBe("*ENTREGA DE RESULTADOS DE PRUEBA*\nCUERPO DE PRUEBA");
    expect(answer.refs).toEqual([{ kind: "POLICY", key: "policy:resultados", version: 1, contentHash: "a".repeat(64) }]);
    expect(await make(items).ask("¿emiten factura?")).toBeUndefined();
  });

  it("preguntas frecuentes por etiqueta EXACTA: una sola coincidencia responde; varias o ninguna, no (no se elige)", async () => {
    const one = make([faq("faq:uno", ["estacionamiento"]), faq("faq:dos", ["mascotas"])]);
    expect((await one.ask("¿tienen estacionamiento?"))!.body).toBe("*PREGUNTA DE PRUEBA*\nRESPUESTA DE PRUEBA");
    expect(await one.ask("¿tienen estacionamiento y mascotas?")).toBeUndefined();
    expect(await one.ask("¿tienen ascensor?")).toBeUndefined();
    expect(await make([faq("faq:uno", ["estacionamiento"], { validUntil: iso(-1) })]).ask("¿tienen estacionamiento?")).toBeUndefined();
  });

  it("las preguntas frecuentes no compiten con un tema reconocido: 'horario' siempre usa el horario, aunque exista una FAQ con esa etiqueta", async () => {
    const t = make([branch(), schedule(), faq("faq:horario", ["horario"])]);
    const answer = (await t.ask("horario"))!;
    expect(answer.body).toContain("Lunes: 08:00 a 12:00");
    expect(answer.refs.some((ref) => ref.kind === "FAQ")).toBe(false);
  });
});

describe("respuestas: preparación de estudios (clínica)", () => {
  const PREP = [preparation(STUDY_A, { prepState: "HAS_PREPARATION", fastingHours: 8, instructions: "INSTRUCCION ALFA DE PRUEBA", collectionWindow: "VENTANA DE PRUEBA" }), preparation(STUDY_B, { prepState: "NO_PREPARATION_REQUIRED" })];

  it("indica EXACTAMENTE lo aprobado: ayuno, ventana e indicaciones; y 'no requiere preparación' solo si el laboratorio lo declaró", async () => {
    const t = make(PREP);
    const alfa = (await t.ask("¿necesito ayuno para alfa?"))!;
    expect(alfa.body).toBe(["*ESTUDIO ALFA DE PRUEBA*", "Ayuno: 8 horas", "Ventana de toma: VENTANA DE PRUEBA", "Indicaciones: INSTRUCCION ALFA DE PRUEBA"].join("\n"));
    expect(alfa.refs).toEqual([{ kind: "STUDY_PREPARATION", key: `study:${STUDY_A}`, version: 1, contentHash: "a".repeat(64) }]);
    factCheck(alfa, PREP);
    expect((await t.ask("preparación para beta"))!.body).toBe("*ESTUDIO BETA DE PRUEBA*: el laboratorio indica que no requiere preparación.");
  });

  it("singular: 'Ayuno: 1 hora'", async () => {
    const t = make([preparation(STUDY_A, { prepState: "HAS_PREPARATION", fastingHours: 1 })]);
    expect((await t.ask("ayuno para alfa"))!.body).toContain("Ayuno: 1 hora");
  });

  it("varios estudios: cada uno por separado, sin consolidar ('no puedo indicarte cómo combinarlas'); los que no tienen preparación aprobada se declaran sin información", async () => {
    const t = make([PREP[0]!]);
    const answer = (await t.ask("ayuno para alfa y beta"))!;
    expect(answer.body).toContain("*ESTUDIO ALFA DE PRUEBA*");
    expect(answer.body).toContain("No tengo la preparación de ESTUDIO BETA DE PRUEBA disponible por ahora.");
    expect(answer.body).toContain(ANSWER_TEXTS.prepNotCombined);
    expect(answer.body).not.toMatch(/máximo|maximo|el mayor|combin\w+ las? indicaciones/i);
    expect(answer.status).toBe("ANSWERED");
  });

  it("SIN registro aprobado NUNCA se dice 'no requiere preparación': no hay respuesta por conocimiento", async () => {
    const t = make([]);
    expect(await t.ask("¿necesito ayuno para alfa?")).toBeUndefined();
    const expired = make([preparation(STUDY_A, undefined, { validUntil: iso(-1) })]);
    expect(await expired.ask("ayuno para alfa")).toBeUndefined();
  });

  it("sin estudio identificable: se PIDE el nombre del estudio (no se adivina) y no se registra ninguna referencia", async () => {
    const answer = (await make(PREP).ask("¿necesito ayuno?"))!;
    expect(answer.body).toBe(ANSWER_TEXTS.askStudy);
    expect(answer.status).toBe("CLARIFY");
    expect(answer.refs).toEqual([]);
    const unknown = (await make(PREP).ask("ayuno para el estudio zeta"))!;
    expect(unknown.status).toBe("CLARIFY");
  });

  it("alias ambiguo o estudio inactivo: no se responde por ellos", async () => {
    const t = make([...PREP, preparation(STUDY_INACTIVE, { prepState: "NO_PREPARATION_REQUIRED" })]);
    expect((await t.ask("ayuno para gamma"))!.status).toBe("CLARIFY"); // ambiguo → pregunta cuál es, no adivina
    expect((await t.ask("ayuno para inactivo"))!.body).toBe(ANSWER_TEXTS.askStudy);
  });

  it("catálogo no disponible (falla o vacío) o más de 5 estudios: no hay respuesta por conocimiento", async () => {
    expect(await make(PREP, { catalog: "throws" }).ask("ayuno para alfa")).toBeUndefined();
    expect(await make(PREP, { catalog: [] }).ask("ayuno para alfa")).toBeUndefined();
    const many = Array.from({ length: MAX_STUDIES + 1 }, (_, i) => study(`aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa000${i}`, `ESTUDIO NUMERO${i} DE PRUEBA`, [`zeta${"x".repeat(i)}`]));
    const t = make(many.map((s) => preparation(s.id)), { catalog: many });
    expect(await t.ask(`ayuno para ${many.map((s) => s.normalizedAliases[0]).join(" ")}`)).toBeUndefined();
  });

  it("el catálogo solo se consulta cuando se pregunta por preparación", async () => {
    const t = make([...PREP, branch(), schedule()]);
    await t.ask("horario");
    await t.ask("ubicación");
    expect(t.loadCatalog).not.toHaveBeenCalled();
    await t.ask("ayuno para alfa");
    expect(t.loadCatalog).toHaveBeenCalledTimes(1);
  });

  it("no usa ni expone precios del catálogo", async () => {
    const answer = (await make(PREP).ask("ayuno para alfa"))!;
    expect(JSON.stringify(answer)).not.toMatch(/999|price|precio/i);
  });
});

describe("combinaciones y límites", () => {
  const ALL = [branch(), schedule(), payment("efectivo"), preparation(STUDY_A, { prepState: "HAS_PREPARATION", fastingHours: 8 })];

  it("varios temas en un mensaje: cada sección con su dato; lo que no tiene datos se declara 'no disponible' sin inventar", async () => {
    const answer = (await make(ALL).ask("horario, dirección y formas de pago"))!;
    expect(answer.body).toContain("Lunes: 08:00 a 12:00");
    expect(answer.body).toContain("Aceptamos: METODO EFECTIVO DE PRUEBA");
    expect(answer.body).toContain("*SUCURSAL DE PRUEBA*\nDIRECCION DE PRUEBA");
    expect(answer.status).toBe("ANSWERED");
    const partial = (await make([payment("efectivo")]).ask("horario y formas de pago"))!;
    expect(partial.body).toContain("Aceptamos:");
    expect(partial.body).toContain("Sobre los horarios no tengo información disponible por ahora.");
    expect(partial.status).toBe("PARTIAL");
    expect(partial.unavailable).toEqual([{ topic: "HOURS", reason: "NO_APPROVED_VERSION" }]);
  });

  it("si NADA tiene datos, no hay respuesta por conocimiento (el manejador usa su respuesta de siempre)", async () => {
    expect(await make([]).ask("horario, dirección y formas de pago")).toBeUndefined();
  });

  it("un mensaje sin tema ni etiqueta no consulta nada que responda", async () => {
    expect(await make(ALL).ask("hola buenas")).toBeUndefined();
  });

  it("una respuesta demasiado larga no se trunca ni se envía a medias", async () => {
    const huge = Array.from({ length: 60 }, (_, i) => item({ kind: "BRANCH", key: `branch-${i}`, payload: { name: `SUCURSAL ${"X".repeat(150)}`, address: "D".repeat(300), notes: "N".repeat(1500) } }));
    expect(await make(huge).ask("¿dónde están ubicados?")).toBeUndefined();
  });

  it("LA BASE CAÍDA (sin copia local): no hay respuesta por conocimiento", async () => {
    const t = make(ALL);
    t.store.failSnapshot = true;
    t.store.failRevision = true;
    expect(await t.ask("horario")).toBeUndefined();
  });

  it("FACT-CHECK general: en cada respuesta, todo número proviene de un registro aprobado que la respalda", async () => {
    const t = make([...ALL, preparation(STUDY_B, { prepState: "HAS_PREPARATION", fastingHours: 12, instructions: "INSTRUCCION BETA DE PRUEBA" })]);
    for (const question of ["horario", "¿dónde están?", "formas de pago", "ayuno para alfa y beta", "horario y ayuno para alfa"]) {
      const answer = (await t.ask(question))!;
      expect(answer, question).toBeDefined();
      factCheck(answer, t.items, ["2026-11-02"]);
    }
  });
});

describe("plantillas, caché y construcción diferida", () => {
  it("las plantillas fijas no llevan cifras, moneda ni promesas; configurar una con una cifra se rechaza", () => {
    expect(() => assertSafeAnswerTexts(ANSWER_TEXTS)).not.toThrow();
    for (const bad of ["Abrimos de 8 a 18", "Cuesta Bs 5", "Es gratis", "Hoy {oops}"]) expect(() => assertSafeAnswerTexts({ ...ANSWER_TEXTS, noOtherHours: bad }), bad).toThrow(UnsafeAnswerTextError);
    expect(() => assertSafeAnswerTexts({ ...ANSWER_TEXTS, noOtherHours: "" })).toThrow(UnsafeAnswerTextError);
  });

  it("ttlCache: una sola carga a la vez, reutiliza dentro del plazo y recarga pasado el plazo; un fallo no se queda en la caché", async () => {
    let clock = 0;
    let calls = 0;
    const load = ttlCache(async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 10)); if (calls === 3) throw new Error("falla"); return calls; }, 1000, () => clock);
    expect(await Promise.all([load(), load(), load()])).toEqual([1, 1, 1]);
    expect(calls).toBe(1);
    clock = 500; expect(await load()).toBe(1);
    clock = 1500; expect(await load()).toBe(2);
    clock = 3000; await expect(load()).rejects.toThrow("falla");
    expect(await load()).toBe(4);
  });

  it("lazyKnowledge: no construye el servicio hasta el primer uso y lo reutiliza", async () => {
    const factory = vi.fn(() => new KnowledgeService({ store: new MemoryStore({ revision: 1, items: [] }) }));
    const lazy = lazyKnowledge(factory);
    expect(factory).not.toHaveBeenCalled();
    await lazy.getPaymentMethods();
    await lazy.getBranches();
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
