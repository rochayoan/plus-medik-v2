import { describe, expect, it } from "vitest";
import { KnowledgeService, scheduleStatusAt, type KnowledgeResult } from "../src/knowledge/index.js";
import { classificationOf, mentionsAmount, PAYLOAD_SCHEMAS } from "../src/knowledge/types.js";
import { branch, CATALOG, faq, iso, item, MemoryStore, payment, policy, preparation, schedule, STUDY_A, STUDY_B, STUDY_INACTIVE, STUDY_NO_RECORD, T0 } from "./support/knowledge-fixtures.js";

// Consulta del conocimiento aprobado SIN base de datos (almacén en memoria de pruebas). Todo dato es un fixture marcado como PRUEBA. La garantía contra la base real está en
// tests/knowledge-db.test.ts y tests/knowledge-e2e.test.ts.

const make = (items: unknown[], options: { revision?: number; clock?: { now: Date } } = {}) => {
  const store = new MemoryStore({ revision: options.revision ?? 1, items });
  const clock = options.clock ?? { now: T0 };
  const service = new KnowledgeService({ store, now: () => clock.now, revisionCheckMs: 15_000, maxStaleMs: 300_000 });
  return { store, service, clock };
};
const advance = (clock: { now: Date }, ms: number) => { clock.now = new Date(clock.now.getTime() + ms); };
const unavailableReason = (result: KnowledgeResult<unknown>) => (result.status === "UNAVAILABLE" ? result.reason : `AVAILABLE`);

describe("revalidación estricta de preparaciones: cero tolerancia a caché vieja", () => {
  const strict = (store: MemoryStore) => {
    let tick = 0;
    return new KnowledgeService({
      store,
      now: () => new Date(T0.getTime() + tick++), // el reloj avanza incluso después de un fetch exitoso
      revisionCheckMs: 0,
      maxStaleMs: 0
    });
  };

  it("una instantánea recién descargada es válida aunque pasen milisegundos hasta comprobarla", async () => {
    const store = new MemoryStore({ revision: 1, items: [branch()] });
    const service = strict(store);
    expect((await service.getBranches()).status).toBe("AVAILABLE");
    expect(store.snapshotCalls).toBe(1);
    expect((await service.getBranches()).status).toBe("AVAILABLE"); // revalidó la revisión
    expect(store.revisionCalls).toBeGreaterThan(0);
  });

  it("ante caída de revisión NO reutiliza caché con maxStaleMs=0, aunque antes haya sido válida", async () => {
    const store = new MemoryStore({ revision: 1, items: [branch()] });
    const service = strict(store);
    expect((await service.getBranches()).status).toBe("AVAILABLE");
    store.failRevision = true;
    expect(await service.getBranches()).toMatchObject({ status: "UNAVAILABLE", reason: "STORE_UNAVAILABLE" });
    store.failRevision = false;
    expect((await service.getBranches()).status).toBe("AVAILABLE");
  });

  it("varios lectores de la misma verificación reciben su resultado, sin caducar por el tick del reloj", async () => {
    const store = new MemoryStore({ revision: 1, items: [branch()] });
    store.snapshotDelayMs = 5;
    const service = strict(store);
    const results = await Promise.all(Array.from({ length: 4 }, () => service.getBranches()));
    expect(results.map((r) => r.status)).toEqual(["AVAILABLE", "AVAILABLE", "AVAILABLE", "AVAILABLE"]);
    expect(store.snapshotCalls).toBe(1);
  });
});

describe("conocimiento no disponible: nunca se inventa", () => {
  it("sin ninguna versión aprobada, TODA consulta devuelve un resultado estructurado 'no disponible'", async () => {
    const { service } = make([]);
    expect(await service.getBranches()).toEqual({ status: "UNAVAILABLE", reason: "NO_APPROVED_VERSION", kind: "BRANCH" });
    expect(await service.getBranch("branch-x")).toEqual({ status: "UNAVAILABLE", reason: "NO_APPROVED_VERSION", kind: "BRANCH", key: "branch-x" });
    expect(await service.getSchedule({ branchKey: "branch-x", service: "OFFICE" })).toMatchObject({ status: "UNAVAILABLE", reason: "NO_APPROVED_VERSION", kind: "SCHEDULE" });
    expect(await service.getScheduleStatus({ branchKey: "branch-x", service: "OFFICE" })).toMatchObject({ status: "UNAVAILABLE", kind: "SCHEDULE" });
    expect(await service.getPolicy("RESULTS_DELIVERY")).toMatchObject({ status: "UNAVAILABLE", reason: "NO_APPROVED_VERSION", kind: "POLICY" });
    expect(await service.getPaymentMethods()).toEqual({ status: "UNAVAILABLE", reason: "NO_APPROVED_VERSION", kind: "PAYMENT_METHOD" });
    expect(await service.getFaq("faq:x")).toMatchObject({ status: "UNAVAILABLE", reason: "NO_APPROVED_VERSION", kind: "FAQ" });
    expect(await service.findFaqByTag("x")).toMatchObject({ status: "UNAVAILABLE", reason: "NO_APPROVED_VERSION" });
    const prep = await service.getStudyPreparation([STUDY_A], CATALOG);
    expect(prep.status).toBe("UNAVAILABLE");
    expect(prep.items[0]!.result).toMatchObject({ status: "UNAVAILABLE", reason: "NO_APPROVED_VERSION", kind: "STUDY_PREPARATION" });
  });

  it("un resultado no disponible no trae datos ni texto: solo estado, razón, tipo y clave", async () => {
    const { service } = make([]);
    const result = await service.getPolicy("X");
    expect(Object.keys(result).sort()).toEqual(["key", "kind", "reason", "status"]);
  });

  it("la ausencia de preparación NUNCA se convierte en 'no requiere preparación'", async () => {
    const { service } = make([preparation(STUDY_A)]);
    const prep = await service.getStudyPreparation([STUDY_A, STUDY_B], CATALOG);
    expect(prep.status).toBe("PARTIAL");
    const missing = prep.items.find((entry) => entry.studyId === STUDY_B)!;
    expect(missing.result).toMatchObject({ status: "UNAVAILABLE", reason: "NO_APPROVED_VERSION" });
    expect(JSON.stringify(missing)).not.toMatch(/NO_PREPARATION_REQUIRED|no requiere|sin preparaci/i);
  });
});

describe("caducidad y vigencia (se evalúan al usar el dato)", () => {
  it("vencido: no disponible (EXPIRED) aunque siga aprobado y en caché; pendiente de vigencia: NOT_YET_VALID", async () => {
    const { service } = make([policy({ validUntil: iso(1) }), faq("faq:futura", ["prueba"], { validFrom: iso(2), validUntil: iso(30) })]);
    expect((await service.getPolicy("PRUEBA")).status).toBe("AVAILABLE");
    expect(unavailableReason(await service.getFaq("faq:futura"))).toBe("NOT_YET_VALID");
  });

  it("la caducidad NO depende de la caché: la copia es de ayer, pero el dato caduca hoy y deja de entregarse en la siguiente consulta, sin recargar", async () => {
    const { service, store, clock } = make([policy({ validUntil: iso(1) })]);
    expect((await service.getPolicy("PRUEBA")).status).toBe("AVAILABLE");
    const loads = store.snapshotCalls;
    advance(clock, 86_400_000 - 1); // un instante antes
    // dentro del plazo de revisión no se consulta la base; pasado el plazo solo se pregunta la revisión
    expect((await service.getPolicy("PRUEBA")).status).toBe("AVAILABLE");
    advance(clock, 2);
    expect(unavailableReason(await service.getPolicy("PRUEBA"))).toBe("EXPIRED");
    expect(store.snapshotCalls).toBe(loads); // no hizo falta recargar
  });

  it("el límite es exacto: en el instante de caducidad ya no está disponible; en el de inicio sí", async () => {
    const { service, clock } = make([faq("faq:a", ["t"], { validFrom: iso(0), validUntil: iso(1) })]);
    expect((await service.getFaq("faq:a")).status).toBe("AVAILABLE"); // validFrom == ahora
    clock.now = new Date(Date.parse(iso(1)) - 1);
    expect((await service.getFaq("faq:a")).status).toBe("AVAILABLE");
    clock.now = new Date(Date.parse(iso(1)));
    expect(unavailableReason(await service.getFaq("faq:a"))).toBe("EXPIRED");
  });

  it("una lista con elementos vencidos entrega los vigentes e INFORMA los omitidos (la lista puede estar incompleta); si todos vencieron, EXPIRED", async () => {
    const { service } = make([payment("efectivo"), payment("qr", true, { validUntil: iso(-1) }), payment("tarjeta", false)]);
    const result = await service.getPaymentMethods();
    expect(result.status).toBe("AVAILABLE");
    if (result.status === "AVAILABLE") {
      expect(result.data.map((method) => method.method).sort()).toEqual(["efectivo", "tarjeta"]);
      expect(result.omitted).toEqual([{ key: "payment:qr", reason: "EXPIRED" }]);
      expect(result.provenance.map((entry) => entry.key).sort()).toEqual(["payment:efectivo", "payment:tarjeta"]);
    }
    const allExpired = make([payment("efectivo", true, { validUntil: iso(-1) }), payment("qr", true, { validUntil: iso(-2) })]);
    expect(unavailableReason(await allExpired.service.getPaymentMethods())).toBe("EXPIRED");
  });

  it("un elemento sin caducidad en la instantánea (dato corrupto) no se usa", async () => {
    const { service } = make([policy({ validUntil: null })]);
    expect(unavailableReason(await service.getPolicy("PRUEBA"))).toBe("INVALID_CONTENT");
  });
});

describe("contenido inválido: no se usa", () => {
  it("un contenido que no cumple el contrato, uno con importes o uno con claves de precio quedan como INVALID_CONTENT y se cuentan", async () => {
    const { service } = make([
      item({ kind: "FAQ", key: "faq:con-precio", payload: { question: "PREGUNTA DE PRUEBA", answer: "cuesta Bs 45" } }),
      item({ kind: "FAQ", key: "faq:clave-precio", payload: { question: "PREGUNTA DE PRUEBA", answer: "X", priceBs: 5 } }),
      item({ kind: "FAQ", key: "faq:forma", payload: { question: 5 } }),
      faq("faq:buena")
    ]);
    expect(unavailableReason(await service.getFaq("faq:con-precio"))).toBe("INVALID_CONTENT");
    expect(unavailableReason(await service.getFaq("faq:clave-precio"))).toBe("INVALID_CONTENT");
    expect(unavailableReason(await service.getFaq("faq:forma"))).toBe("INVALID_CONTENT");
    expect((await service.getFaq("faq:buena")).status).toBe("AVAILABLE");
    expect(service.rejectedCount).toBe(3);
  });

  it("un elemento mal formado en la instantánea no tumba a los demás", async () => {
    const { service } = make([{ basura: true }, null, 7, policy()]);
    expect((await service.getPolicy("PRUEBA")).status).toBe("AVAILABLE");
    expect(service.rejectedCount).toBe(3);
  });

  it("una preparación cuya clave no es la de su estudio se rechaza (no se puede entregar la de otro estudio)", async () => {
    const wrong = item({ kind: "STUDY_PREPARATION", key: `study:${STUDY_B}`, payload: { labTestId: STUDY_A, prepState: "HAS_PREPARATION", instructions: "INSTRUCCION DE PRUEBA" } });
    const { service } = make([wrong]);
    const prep = await service.getStudyPreparation([STUDY_B], CATALOG);
    expect(prep.items[0]!.result).toMatchObject({ status: "UNAVAILABLE", reason: "INVALID_CONTENT" });
  });

  it("los esquemas rechazan importes en todas las variaciones y respetan lo que no es un importe", () => {
    for (const text of ["Bs 45", "Bs. 45", "45 Bs", "45bs", "BOB 10", "$ 5", "$5", "5 USD", "USD 5", "45 bolivianos", "10 dólares", "10 dolares", "US$ 3"]) expect(mentionsAmount(text), text).toBe(true);
    for (const text of ["Calle 21 número 123", "Hasta 3 días hábiles", "Piso 2", "Atención sin cita", "Bsas"]) expect(mentionsAmount(text), text).toBe(false);
    expect(PAYLOAD_SCHEMAS.FAQ.safeParse({ question: "x", answer: "cuesta 45 Bs" }).success).toBe(false);
  });

  it("la clasificación sale del tipo: solo la preparación de estudios es clínica", () => {
    expect(["BRANCH", "SCHEDULE", "POLICY", "PAYMENT_METHOD", "FAQ"].map((kind) => classificationOf(kind as never))).toEqual(Array(5).fill("ADMINISTRATIVE"));
    expect(classificationOf("STUDY_PREPARATION")).toBe("CLINICAL");
  });
});

describe("procedencia (trazabilidad de cada respuesta)", () => {
  it("cada resultado disponible trae versión, aprobador, fecha y hash del contenido que lo respalda", async () => {
    const { service } = make([policy({ version: 3 })]);
    const result = await service.getPolicy("PRUEBA");
    expect(result.status).toBe("AVAILABLE");
    if (result.status === "AVAILABLE") expect(result.provenance).toEqual([{ kind: "POLICY", key: "policy:prueba", version: 3, approvedAt: iso(-30), approvedBy: "crm:approver-prueba", validUntil: iso(60), contentHash: "a".repeat(64) }]);
  });
});

describe("horarios: sucursal aprobada + horario aprobado + zona horaria", () => {
  const status = async (service: KnowledgeService, at: string) => {
    const result = await service.getScheduleStatus({ branchKey: "branch-prueba", service: "OFFICE" }, new Date(at));
    return result.status === "AVAILABLE" ? result.data : result;
  };

  it("abierto/cerrado según la zona horaria del horario (UTC-4 en las pruebas): lunes 11:00 abierto, 12:00 cerrado, 14:00 abierto, 18:00 cerrado", async () => {
    const { service } = make([branch(), schedule()]);
    expect(await status(service, "2026-11-02T15:00:00Z")).toMatchObject({ open: true, weekday: 1, localDate: "2026-11-02", source: "WEEKLY" });
    expect(await status(service, "2026-11-02T16:00:00Z")).toMatchObject({ open: false }); // 12:00 local: el cierre es exclusivo
    expect(await status(service, "2026-11-02T15:59:00Z")).toMatchObject({ open: true });
    expect(await status(service, "2026-11-02T18:00:00Z")).toMatchObject({ open: true }); // 14:00
    expect(await status(service, "2026-11-02T22:00:00Z")).toMatchObject({ open: false }); // 18:00
    expect(await status(service, "2026-11-03T15:00:00Z")).toMatchObject({ open: false, intervals: [] }); // martes: sin horario
  });

  it("la fecha local manda, no la UTC: lunes 23:30 local es martes en UTC pero sigue siendo lunes para el horario", async () => {
    const { service } = make([branch(), schedule()]);
    expect(await status(service, "2026-11-03T03:30:00Z")).toMatchObject({ weekday: 1, localDate: "2026-11-02", open: false });
  });

  it("las excepciones mandan sobre el horario semanal: feriado cerrado, y día con horario especial", async () => {
    const { service } = make([branch(), schedule()]);
    expect(await status(service, "2026-11-09T15:00:00Z")).toMatchObject({ open: false, source: "EXCEPTION", exceptionNote: "FERIADO DE PRUEBA", intervals: [] }); // lunes 9: feriado
    expect(await status(service, "2026-11-10T14:30:00Z")).toMatchObject({ open: true, source: "EXCEPTION", intervals: [{ opens: "10:00", closes: "11:00" }] }); // martes 10 abre excepcionalmente
    expect(await status(service, "2026-11-10T15:00:00Z")).toMatchObject({ open: false }); // 11:00 local: cierre exclusivo
  });

  it("sin horario aprobado, vencido, o con la sucursal retirada o vencida: NO disponible (no se asume ningún horario)", async () => {
    expect(unavailableReason(await make([branch()]).service.getScheduleStatus({ branchKey: "branch-prueba", service: "OFFICE" }))).toBe("NO_APPROVED_VERSION");
    expect(unavailableReason(await make([branch(), schedule({ validUntil: iso(-1) })]).service.getScheduleStatus({ branchKey: "branch-prueba", service: "OFFICE" }))).toBe("EXPIRED");
    expect(unavailableReason(await make([schedule()]).service.getScheduleStatus({ branchKey: "branch-prueba", service: "OFFICE" }))).toBe("NO_APPROVED_VERSION"); // sin sucursal
    expect(unavailableReason(await make([branch("branch-prueba", { validUntil: iso(-1) }), schedule()]).service.getScheduleStatus({ branchKey: "branch-prueba", service: "OFFICE" }))).toBe("EXPIRED");
    expect(unavailableReason(await make([branch(), schedule()]).service.getScheduleStatus({ branchKey: "branch-prueba", service: "HOME_SAMPLING" }))).toBe("NO_APPROVED_VERSION"); // otro servicio
  });

  it("zona horaria inexistente: el horario no se usa", async () => {
    const { service } = make([branch(), schedule({ payload: { branchKey: "branch-prueba", service: "OFFICE", timezone: "Mundo/Inexistente", weekly: [{ day: 1, opens: "08:00", closes: "12:00" }] } })]);
    expect(unavailableReason(await service.getScheduleStatus({ branchKey: "branch-prueba", service: "OFFICE" }))).toBe("INVALID_CONTENT");
    expect(scheduleStatusAt({ branchKey: "b", service: "OFFICE", timezone: "Mundo/Inexistente", weekly: [{ day: 1, opens: "08:00", closes: "12:00" }] }, T0)).toBeUndefined();
  });

  it("dos horarios vigentes del mismo servicio y sucursal: AMBIGUOUS (no se elige uno)", async () => {
    const { service } = make([branch(), schedule(), schedule({ key: "schedule:otro" })]);
    expect(unavailableReason(await service.getSchedule({ branchKey: "branch-prueba", service: "OFFICE" }))).toBe("AMBIGUOUS");
  });
});

describe("políticas, métodos de pago y preguntas frecuentes (administrativo)", () => {
  it("política por tema, pagos (aceptados y NO aceptados, tal como los aprobó el laboratorio) y preguntas por clave o etiqueta", async () => {
    const { service } = make([policy(), policy({ key: "policy:otra", payload: { topic: "OTRA", title: "OTRA DE PRUEBA", body: "CUERPO DE PRUEBA" } }), payment("efectivo"), payment("tarjeta", false), faq("faq:uno", ["horario", "prueba"]), faq("faq:dos", ["pago"])]);
    const pol = await service.getPolicy("OTRA");
    expect(pol.status === "AVAILABLE" && pol.data.title).toBe("OTRA DE PRUEBA");
    const methods = await service.getPaymentMethods();
    expect(methods.status === "AVAILABLE" && methods.data.map((m) => [m.method, m.accepted]).sort()).toEqual([["efectivo", true], ["tarjeta", false]]);
    const tagged = await service.findFaqByTag("horario");
    expect(tagged.status === "AVAILABLE" && tagged.data.map((f) => f.key)).toEqual(["faq:uno"]);
    expect(unavailableReason(await service.findFaqByTag("inexistente"))).toBe("NO_APPROVED_VERSION");
    expect((await service.getFaq("faq:dos")).status).toBe("AVAILABLE");
  });

  it("dos políticas vigentes para el mismo tema: AMBIGUOUS", async () => {
    const { service } = make([policy(), policy({ key: "policy:duplicada" })]);
    expect(unavailableReason(await service.getPolicy("PRUEBA"))).toBe("AMBIGUOUS");
  });

  it("lo administrativo y lo clínico no se mezclan: una pregunta administrativa nunca devuelve preparación y viceversa", async () => {
    const { service } = make([faq("study:fake"), preparation(STUDY_A)]);
    expect(unavailableReason(await service.getFaq("study:fake"))).toBe("AVAILABLE");
    expect((await service.getStudyPreparation([STUDY_A], CATALOG)).status).toBe("AVAILABLE");
    // una preparación no se obtiene por la vía de las preguntas frecuentes
    expect(unavailableReason(await service.getFaq(`study:${STUDY_A}`))).toBe("NO_APPROVED_VERSION");
  });
});

describe("preparación de estudios (clínica) con el catálogo real", () => {
  it("devuelve la preparación aprobada de cada estudio por su identificador de catálogo, con nombre del catálogo y procedencia; sin precios", async () => {
    const { service } = make([preparation(STUDY_A), preparation(STUDY_B, { prepState: "NO_PREPARATION_REQUIRED" })]);
    const prep = await service.getStudyPreparation([STUDY_A, STUDY_B], CATALOG.map((study) => ({ ...study, priceBs: 999 })) as never);
    expect(prep.status).toBe("AVAILABLE");
    const [a, b] = prep.items;
    expect(a!.result).toMatchObject({ status: "AVAILABLE", data: { studyId: STUDY_A, studyName: "ESTUDIO A DE PRUEBA", prepState: "HAS_PREPARATION", fastingHours: 8, instructions: "INSTRUCCION DE PRUEBA" }, provenance: [{ kind: "STUDY_PREPARATION", key: `study:${STUDY_A}` }] });
    expect(b!.result).toMatchObject({ status: "AVAILABLE", data: { prepState: "NO_PREPARATION_REQUIRED" } });
    expect(JSON.stringify(prep)).not.toMatch(/999|price|precio/i);
  });

  it("estudio inexistente en el catálogo, inactivo, sin catálogo o con catálogo vacío: no disponible con su razón, aunque exista un registro aprobado", async () => {
    const { service } = make([preparation(STUDY_INACTIVE), preparation(STUDY_A)]);
    const prep = await service.getStudyPreparation([STUDY_INACTIVE, "99999999-9999-4999-8999-999999999999", STUDY_A], CATALOG);
    expect(prep.items.map((entry) => unavailableReason(entry.result))).toEqual(["INACTIVE_STUDY", "UNKNOWN_STUDY", "AVAILABLE"]);
    expect(prep.status).toBe("PARTIAL");
    for (const catalog of [undefined, []]) {
      const none = await service.getStudyPreparation([STUDY_A], catalog);
      expect(none.status).toBe("UNAVAILABLE");
      expect(unavailableReason(none.items[0]!.result)).toBe("CATALOG_UNAVAILABLE");
    }
  });

  it("preparación vencida o retirada: no disponible; se deduplican los identificadores repetidos; sin identificadores no hay estado disponible", async () => {
    const { service } = make([preparation(STUDY_A, undefined, { validUntil: iso(-1) })]);
    const prep = await service.getStudyPreparation([STUDY_A, STUDY_A], CATALOG);
    expect(prep.items).toHaveLength(1);
    expect(unavailableReason(prep.items[0]!.result)).toBe("EXPIRED");
    expect((await service.getStudyPreparation([], CATALOG)).status).toBe("UNAVAILABLE");
  });

  it("NO hay consolidación clínica automática: varios estudios se informan por separado (nada de 'ayuno máximo')", async () => {
    const { service } = make([preparation(STUDY_A, { prepState: "HAS_PREPARATION", fastingHours: 8 }), preparation(STUDY_B, { prepState: "HAS_PREPARATION", fastingHours: 12 })]);
    const prep = await service.getStudyPreparation([STUDY_A, STUDY_B], CATALOG);
    expect(Object.keys(prep).sort()).toEqual(["items", "status"]);
    expect(JSON.stringify(prep)).not.toMatch(/consolid|maxFasting|maximum/i);
  });
});

describe("caché e invalidación", () => {
  it("dentro del plazo de revisión no se consulta la base; pasado, solo la revisión (barata); si no cambió no se recarga", async () => {
    const { service, store, clock } = make([policy()]);
    await service.getPolicy("PRUEBA");
    await service.getPolicy("PRUEBA");
    expect([store.snapshotCalls, store.revisionCalls]).toEqual([1, 0]);
    advance(clock, 16_000);
    await service.getPolicy("PRUEBA");
    expect([store.snapshotCalls, store.revisionCalls]).toEqual([1, 1]);
  });

  it("si la revisión cambió (se aprobó o retiró algo) se recarga y el cambio se ve; retirar un dato lo hace desaparecer al instante", async () => {
    const { service, store, clock } = make([policy()], { revision: 5 });
    expect((await service.getPolicy("PRUEBA")).status).toBe("AVAILABLE");
    store.set([], 6); // el laboratorio retiró la política
    advance(clock, 16_000);
    expect(unavailableReason(await service.getPolicy("PRUEBA"))).toBe("NO_APPROVED_VERSION");
    expect(service.cachedRevision).toBe(6);
    store.set([policy({ version: 2 })], 7);
    advance(clock, 16_000);
    const again = await service.getPolicy("PRUEBA");
    expect(again.status === "AVAILABLE" && again.provenance[0]!.version).toBe(2);
  });

  it("invalidate() fuerza la recarga en la siguiente consulta sin esperar el plazo", async () => {
    const { service, store } = make([policy()], { revision: 1 });
    await service.getPolicy("PRUEBA");
    store.set([], 2);
    service.invalidate();
    expect(unavailableReason(await service.getPolicy("PRUEBA"))).toBe("NO_APPROVED_VERSION");
    expect(store.snapshotCalls).toBe(2);
  });

  it("UNA sola carga a la vez: muchas consultas simultáneas comparten la misma recarga", async () => {
    const { service, store } = make([policy(), faq()]);
    store.snapshotDelayMs = 30;
    const results = await Promise.all(Array.from({ length: 25 }, (_, index) => (index % 2 ? service.getPolicy("PRUEBA") : service.getFaq("faq:prueba"))));
    expect(results.every((result) => result.status === "AVAILABLE")).toBe(true);
    expect(store.snapshotCalls).toBe(1);
  });

  it("nunca se reemplaza una copia más NUEVA por una más vieja (cargas solapadas)", async () => {
    const { service, store, clock } = make([policy({ version: 9 })], { revision: 9 });
    await service.getPolicy("PRUEBA");
    store.set([policy({ version: 1 })], 3); // una réplica atrasada responde con una revisión menor
    advance(clock, 16_000);
    service.invalidate();
    const result = await service.getPolicy("PRUEBA");
    expect(service.cachedRevision).toBe(9);
    expect(result.status === "AVAILABLE" && result.provenance[0]!.version).toBe(9);
  });

  it("base caída: se sigue usando la copia hasta maxStaleMs desde la última verificación; pasado ese plazo TODO es 'no disponible' (falla cerrado)", async () => {
    const { service, store, clock } = make([policy()]);
    expect((await service.getPolicy("PRUEBA")).status).toBe("AVAILABLE");
    store.failRevision = true;
    store.failSnapshot = true;
    advance(clock, 120_000);
    expect((await service.getPolicy("PRUEBA")).status).toBe("AVAILABLE"); // copia aún aceptable
    advance(clock, 200_000); // 320 s sin verificar
    expect(unavailableReason(await service.getPolicy("PRUEBA"))).toBe("STORE_UNAVAILABLE");
    expect(unavailableReason(await service.getBranches())).toBe("STORE_UNAVAILABLE");
    expect((await service.getStudyPreparation([STUDY_A], CATALOG)).items[0]!.result).toMatchObject({ status: "UNAVAILABLE", reason: "STORE_UNAVAILABLE" });
  });

  it("sin copia previa y con la base caída desde el inicio: no disponible; al volver la base se recupera sola", async () => {
    const { service, store } = make([policy()]);
    store.failSnapshot = true;
    expect(unavailableReason(await service.getPolicy("PRUEBA"))).toBe("STORE_UNAVAILABLE");
    store.failSnapshot = false;
    expect((await service.getPolicy("PRUEBA")).status).toBe("AVAILABLE");
  });

  it("la verificación exitosa renueva el plazo: una caída corta no apaga las respuestas", async () => {
    const { service, store, clock } = make([policy()]);
    await service.getPolicy("PRUEBA");
    for (let i = 0; i < 4; i++) { advance(clock, 100_000); await service.getPolicy("PRUEBA"); } // revisión OK cada 100 s
    store.failRevision = true;
    advance(clock, 100_000);
    expect((await service.getPolicy("PRUEBA")).status).toBe("AVAILABLE");
  });
});
