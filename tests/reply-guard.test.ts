import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSupabaseAuditRepository, type AuditClaim, type AuditLease, type AuditRepository } from "../src/audit.js";
import { DEFAULT_REPLY_GUARD, looksAutomated, looksLikeOwnReply, replySignature, resolveReplyGuard, validateReplyGuardConfig } from "../src/reply-guard.js";
import { createTextHandler, DRAFT_TEXTS } from "../src/text-handler.js";
import { processTurns, type IncomingTurn, type TurnHandlers } from "../src/turns.js";
import { TECHNICAL_ISSUE_MESSAGE, type QuoteDeps } from "../src/whatsapp-quote.js";
import type { ReplyGuardConfig } from "../src/reply-guard.js";

// Protección contra bucles y exceso de respuestas SIN base de datos: configuración, detección de mensajes automáticos, firmas, cableado con la máquina de turnos y con el
// repositorio. La garantía atómica (tope, ráfagas, repeticiones, recuperación) se prueba contra PostgreSQL en tests/reply-guard-db.test.ts y de extremo a extremo en
// tests/reply-guard-e2e.test.ts.

const LEASE: AuditLease = { owner: "owner-0000001", fence: 1 };
const KEY = "a".repeat(64);
const SENTINEL = "TEXTO_CLINICO_SENTINELA_5521";
const log = () => undefined;

describe("configuración de la guarda", () => {
  it("los valores iniciales son válidos y respetan los rangos de la base", () => {
    expect(validateReplyGuardConfig(DEFAULT_REPLY_GUARD)).toEqual({ ok: true, config: DEFAULT_REPLY_GUARD });
  });

  it("una configuración parcial se completa con los valores iniciales", () => {
    const checked = validateReplyGuardConfig({ cooldownSeconds: 60 });
    expect(checked).toEqual({ ok: true, config: { ...DEFAULT_REPLY_GUARD, cooldownSeconds: 60 } });
  });

  it.each([
    ["no es un objeto", "texto", "CONFIG_NOT_OBJECT"],
    ["es una lista", [], "CONFIG_NOT_OBJECT"],
    ["es nulo", null, "CONFIG_NOT_OBJECT"],
    ["clave desconocida", { tope: 5 }, "CONFIG_UNKNOWN_KEY"],
    ["sin reglas", { rules: [] }, "CONFIG_RULES"],
    ["cinco reglas", { rules: Array.from({ length: 5 }, () => ({ windowSeconds: 60, max: 5 })) }, "CONFIG_RULES"],
    ["ventana fraccionaria", { rules: [{ windowSeconds: 1.5, max: 5 }] }, "CONFIG_RULES"],
    ["ventana de más de un día", { rules: [{ windowSeconds: 86401, max: 5 }] }, "CONFIG_RULES"],
    ["tope cero", { rules: [{ windowSeconds: 60, max: 0 }] }, "CONFIG_RULES"],
    ["tope como texto", { rules: [{ windowSeconds: 60, max: "5" }] }, "CONFIG_RULES"],
    ["regla con clave extra", { rules: [{ windowSeconds: 60, max: 5, x: 1 }] }, "CONFIG_RULES"],
    ["ráfaga con tope 1", { burst: { windowSeconds: 60, max: 1 } }, "CONFIG_BURST"],
    ["repetición con tope 1", { repeat: { windowSeconds: 60, max: 1 } }, "CONFIG_REPEAT"],
    ["enfriamiento cero", { cooldownSeconds: 0 }, "CONFIG_COOLDOWN"],
    ["enfriamiento de más de un día", { cooldownSeconds: 90_000 }, "CONFIG_COOLDOWN"]
  ])("rechaza con un código, sin corregir en silencio: %s", (_name, config, error) => {
    expect(validateReplyGuardConfig(config)).toEqual({ ok: false, error });
  });

  it("APAGADA por defecto: sin la variable, con otro valor o con una variante de 'on' que no es exacta, no hay guarda", () => {
    for (const value of [undefined, "", "off", "0", "false", "true", "1", "yes", "onn"]) {
      expect(resolveReplyGuard({ PLUSMEDIK_REPLY_GUARD: value }), String(value)).toEqual({ enabled: false });
    }
    expect(resolveReplyGuard({ PLUSMEDIK_REPLY_GUARD_CONFIG: JSON.stringify(DEFAULT_REPLY_GUARD) })).toEqual({ enabled: false });
  });

  it("'on' (sin importar mayúsculas ni espacios) la enciende con los valores iniciales o con la configuración dada", () => {
    expect(resolveReplyGuard({ PLUSMEDIK_REPLY_GUARD: " ON " })).toEqual({ enabled: true, config: DEFAULT_REPLY_GUARD });
    expect(resolveReplyGuard({ PLUSMEDIK_REPLY_GUARD: "on", PLUSMEDIK_REPLY_GUARD_CONFIG: "  " })).toEqual({ enabled: true, config: DEFAULT_REPLY_GUARD });
    const custom: ReplyGuardConfig = { ...DEFAULT_REPLY_GUARD, rules: [{ windowSeconds: 300, max: 4 }], cooldownSeconds: 120 };
    expect(resolveReplyGuard({ PLUSMEDIK_REPLY_GUARD: "on", PLUSMEDIK_REPLY_GUARD_CONFIG: JSON.stringify(custom) })).toEqual({ enabled: true, config: custom });
  });

  it("encendida con una configuración inválida NO se reemplaza por los valores iniciales: informa el código (falla cerrado)", () => {
    expect(resolveReplyGuard({ PLUSMEDIK_REPLY_GUARD: "on", PLUSMEDIK_REPLY_GUARD_CONFIG: "{no es json" })).toEqual({ enabled: true, error: "CONFIG_NOT_JSON" });
    expect(resolveReplyGuard({ PLUSMEDIK_REPLY_GUARD: "on", PLUSMEDIK_REPLY_GUARD_CONFIG: '{"rules":[]}' })).toEqual({ enabled: true, error: "CONFIG_RULES" });
    expect(resolveReplyGuard({ PLUSMEDIK_REPLY_GUARD: "on", PLUSMEDIK_REPLY_GUARD_CONFIG: "[1]" })).toEqual({ enabled: true, error: "CONFIG_NOT_OBJECT" });
  });
});

describe("firma de la respuesta", () => {
  it("es un código cerrado (categoría y temas ordenados), siempre aceptado por la base", () => {
    expect(replySignature("INFO_REQUEST", ["LOCATION", "HOURS"])).toBe("INFO_REQUEST:HOURS:LOCATION");
    expect(replySignature("GREETING")).toBe("GREETING");
    for (const signature of [replySignature("OTHER", ["a b", "ñ", "x".repeat(200)]), replySignature("x".repeat(200))]) {
      expect(signature).toMatch(/^[A-Z0-9_.:-]{1,64}$/);
    }
  });
});

describe("mensajes automáticos", () => {
  it.each([
    "Respuesta automática: gracias por escribirnos.",
    "Mensaje automático. No responder.",
    "MENSAJE AUTOMÁTICO",
    "Este es un mensaje automático, por favor no lo responda.",
    "Esta es una respuesta automática de nuestra oficina.",
    "Este mensaje fue generado automáticamente.",
    "Mensaje enviado automáticamente por el sistema.",
    "Autorrespuesta: estamos fuera.",
    "auto-reply: back soon",
    "Auto reply",
    "Por favor no responda a este mensaje.",
    "No respondas a este número, es solo de notificaciones.",
    "Please do not reply to this message",
    "Don't reply to this number",
    "no-reply",
    "This is an automated message. Please do not reply.",
    "Automated response: we will contact you.",
    "I am out of office until Monday",
    "Estoy fuera de la oficina hasta el lunes",
    "Gracias por comunicarte con nosotros. En este momento no estamos disponibles, te responderemos lo antes posible.",
    "Gracias por contactarnos. Por el momento no podemos atenderte; nuestro horario de atención es de lunes a viernes."
  ])("detecta: %s", (text) => {
    expect(looksAutomated(text)).toBe(true);
  });

  it.each([
    "Hola, ¿cuál es su horario?",
    "Quiero cotizar mi receta",
    "me llegó un mensaje de ustedes, ¿qué significa?",
    "¿Me pueden decir si el examen es automático o manual?",
    "Gracias por la información",
    "Gracias por contactarme tan rápido",
    "Gracias por escribir, ya mando mi receta",
    "En este momento no puedo ir, ¿a qué hora cierran?",
    "No me respondieron ayer",
    "no puedo responder la llamada, escríbanme",
    "Necesito el resultado de mi hemograma automatizado",
    "Tengo mucho dolor de cabeza, ¿qué hago?",
    "Es una emergencia",
    "reply",
    "automático",
    "",
    "   "
  ])("no confunde a un paciente: %s", (text) => {
    expect(looksAutomated(text)).toBe(false);
  });

  it("solo mira el comienzo del mensaje (acotado) y tolera mayúsculas, tildes y signos", () => {
    expect(looksAutomated(`¡¡MENSAJE   AUTOMÁTICO!! ${"x".repeat(50_000)}`)).toBe(true);
    expect(looksAutomated(`${"x ".repeat(2_000)} mensaje automático`)).toBe(false);
  });

  it("reconoce el eco de nuestros propios textos (un bot que nos devuelve lo que dijimos) y no a un paciente que escribe algo parecido", () => {
    const own = Object.values(DRAFT_TEXTS);
    for (const text of own) {
      expect(looksLikeOwnReply(text, own), text).toBe(true);
      expect(looksLikeOwnReply(`> ${text.toUpperCase()} ✓`, own)).toBe(true);
    }
    expect(looksLikeOwnReply("Hola, soy paciente y quiero cotizar", own)).toBe(false);
    expect(looksLikeOwnReply("Recibimos", own)).toBe(false);
    expect(looksLikeOwnReply(DRAFT_TEXTS.fallback.slice(0, 20), own)).toBe(false);
    // un texto propio demasiado corto no sirve para distinguir: nunca se usa
    expect(looksLikeOwnReply("Hola Hola Hola Hola Hola Hola Hola Hola", ["Hola"])).toBe(false);
  });
});

describe("manejador de texto con protección contra bucles", () => {
  const handler = (loopProtection: boolean | undefined) => createTextHandler({ log, ...(loopProtection === undefined ? {} : { loopProtection }) });
  const text = (body: string): IncomingTurn => ({ messageId: "wamid.1", from: "59170000000", kind: "TEXT", text: body });

  it("apagada (por defecto): idéntico a G2.1, incluso con una autorrespuesta, y SIN firma en la respuesta", async () => {
    for (const option of [undefined, false]) {
      expect(await handler(option)(text("Hola"))).toEqual({ body: DRAFT_TEXTS.greeting, stale: "NEWER_TURN" });
      expect(await handler(option)(text("Respuesta automática: no responder"))).toEqual({ body: DRAFT_TEXTS.fallback, stale: "NEWER_TURN" });
      expect(await handler(option)(text(DRAFT_TEXTS.greeting))).toMatchObject({ body: expect.any(String) });
    }
  });

  it("encendida: a un mensaje automático o a un eco NO se le responde (ni siquiera lo médico que contenga) y se registra solo la categoría", async () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const h = createTextHandler({ log: (event, data) => events.push([event, data]), loopProtection: true });
    for (const body of [`Mensaje automático. En caso de emergencia llame al servicio médico. ${SENTINEL}`, "Please do not reply. Dolor de pecho? Emergencia.", DRAFT_TEXTS.medical_unavailable, DRAFT_TEXTS.greeting, DRAFT_TEXTS.fallback]) {
      expect(await h(text(body)), body).toBeUndefined();
    }
    expect(events.every(([event, data]) => event === "text_turn" && data.category === "AUTOMATED" && data.handoff === "none")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(SENTINEL);
  });

  it("encendida: un paciente real sigue recibiendo su respuesta, con la firma de su categoría", async () => {
    const h = handler(true);
    expect(await h(text("Hola"))).toEqual({ body: DRAFT_TEXTS.greeting, stale: "NEWER_TURN", signature: "GREETING" });
    expect(await h(text("quiero cotizar mi receta"))).toMatchObject({ body: DRAFT_TEXTS.send_recipe, signature: "RECIPE_OR_QUOTE" });
    expect(await h(text("¿a qué hora abren?"))).toMatchObject({ body: DRAFT_TEXTS.handoff_unavailable, signature: "INFO_REQUEST" });
    expect(await h(text("tengo mucho dolor"))).toMatchObject({ body: DRAFT_TEXTS.medical_unavailable, signature: "MEDICAL" });
    expect(await h(text("quiero hablar con una persona"))).toMatchObject({ signature: "HUMAN_REQUEST" });
    expect(await h(text("asdf qwer"))).toMatchObject({ body: DRAFT_TEXTS.fallback, signature: "OTHER" });
  });

  it("la firma nunca contiene texto del paciente", async () => {
    const reply = await handler(true)(text(`Hola ${SENTINEL}`));
    expect(JSON.stringify(reply)).not.toContain(SENTINEL);
    expect(reply?.signature).toMatch(/^[A-Z0-9_.:-]{1,64}$/);
  });
});

describe("cableado con la máquina de turnos", () => {
  const turn = (messageId: string, kind: IncomingTurn["kind"] = "TEXT", text: string | undefined = "hola"): IncomingTurn => ({ messageId, from: "59170000000", kind, ...(kind === "IMAGE" ? { mediaId: "m1" } : { text }) });
  const guardConfig: ReplyGuardConfig = { ...DEFAULT_REPLY_GUARD, cooldownSeconds: 120 };

  function fakeAudit(reserve: () => Promise<string> = async () => "reserved") {
    let n = 0;
    return {
      claim: vi.fn(async (): Promise<AuditClaim> => ({ kind: "claimed", runId: `run-${++n}`, lease: LEASE, takeover: false })),
      renewLease: vi.fn(async () => true), recordIgnored: vi.fn(async () => undefined), recordEvidence: vi.fn(async () => undefined), recordFailure: vi.fn(async () => undefined),
      reserveSend: vi.fn(reserve), confirmSend: vi.fn(async (): Promise<string> => "proceed"), recordReply: vi.fn(async () => undefined), releaseTurn: vi.fn(async () => undefined)
    } as unknown as AuditRepository & { reserveSend: ReturnType<typeof vi.fn>; recordReply: ReturnType<typeof vi.fn>; releaseTurn: ReturnType<typeof vi.fn> };
  }
  function setup(options: { replyGuard?: ReplyGuardConfig; handlers?: TurnHandlers; audit?: ReturnType<typeof fakeAudit> } = {}) {
    const audit = options.audit ?? fakeAudit();
    const sends: string[] = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const deps: QuoteDeps = {
      downloadImage: vi.fn(async () => ({ bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]) })), loadCatalog: vi.fn(async () => []),
      analyze: vi.fn(async () => { throw new Error("no se usa"); }),
      sendText: vi.fn(async (_to: string, body: string) => { sends.push(body); return { providerMessageId: "wamid.out" }; }),
      log: (event, data) => logs.push([event, data]), audit, leaseRenewIntervalMs: 3_600_000,
      turns: { contactKeyFor: () => KEY, busyRetries: 2, busyDelayMs: 1, sleep: async () => undefined, handlers: options.handlers, ...(options.replyGuard ? { replyGuard: options.replyGuard } : {}) }
    };
    return { deps, audit, sends, logs, logged: (name: string) => logs.filter(([event]) => event === name).map(([, data]) => data) };
  }
  const handlers = (signature?: string): TurnHandlers => ({ text: async () => ({ body: "respuesta", ...(signature ? { signature } : {}) }) });

  it("sin guarda configurada la reserva es exactamente la de siempre: { stale } y nada más", async () => {
    const w = setup({ handlers: handlers("GREETING") });
    await processTurns([turn("m1")], w.deps);
    expect(w.audit.reserveSend).toHaveBeenCalledWith("run-1", "conversation", LEASE, { stale: "NEWER_TURN" });
    expect(w.sends).toEqual(["respuesta"]);
  });

  it("con guarda, una respuesta de conversación lleva la configuración y su firma; sin firma, solo la configuración", async () => {
    const withSignature = setup({ replyGuard: guardConfig, handlers: handlers("INFO_REQUEST:HOURS") });
    await processTurns([turn("m1")], withSignature.deps);
    expect(withSignature.audit.reserveSend).toHaveBeenCalledWith("run-1", "conversation", LEASE, { stale: "NEWER_TURN", guard: { config: guardConfig, signature: "INFO_REQUEST:HOURS" } });
    const without = setup({ replyGuard: guardConfig, handlers: handlers() });
    await processTurns([turn("m1")], without.deps);
    expect(without.audit.reserveSend).toHaveBeenCalledWith("run-1", "conversation", LEASE, { stale: "NEWER_TURN", guard: { config: guardConfig } });
  });

  it("un fallo del manejador (aviso técnico) también pasa por la guarda; una imagen NUNCA lleva guarda", async () => {
    const failing = setup({ replyGuard: guardConfig, handlers: { text: async () => { throw new Error(`falló con ${SENTINEL}`); } } });
    await processTurns([turn("m1")], failing.deps);
    expect(failing.audit.reserveSend).toHaveBeenCalledWith("run-1", "technical_issue", LEASE, { stale: "NEWER_TURN", guard: { config: guardConfig } });
    expect(failing.sends).toEqual([TECHNICAL_ISSUE_MESSAGE]);
    expect(JSON.stringify(failing.logs)).not.toContain(SENTINEL);

    const image = setup({ replyGuard: guardConfig, handlers: handlers("GREETING") });
    image.deps.analyze = vi.fn(async () => { throw new Error("boom"); });
    await processTurns([turn("m2", "IMAGE")], image.deps);
    for (const call of image.audit.reserveSend.mock.calls) expect(call[3]).toEqual({ stale: "NEWER_TURN" });
    expect(image.audit.reserveSend).toHaveBeenCalled();
  });

  it("'limited': no se envía nada, no se confirma ni se libera el turno, y el registro lleva solo el motivo", async () => {
    const w = setup({ replyGuard: guardConfig, handlers: handlers("GREETING"), audit: fakeAudit(async () => "limited") });
    const reports = await processTurns([turn("m1", "TEXT", `hola ${SENTINEL}`)], w.deps);
    expect(reports).toEqual([{ messageId: "m1", result: "ignored" }]);
    expect(w.sends).toEqual([]);
    expect(w.audit.confirmSend).not.toHaveBeenCalled();
    expect(w.audit.recordReply).not.toHaveBeenCalled();
    expect(w.audit.releaseTurn).not.toHaveBeenCalled();
    expect(w.audit.reserveSend).toHaveBeenCalledTimes(1);
    expect(w.logged("reply_withheld")).toEqual([{ reason: "limited" }]);
    expect(JSON.stringify(w.logs)).not.toContain(SENTINEL);
  });

  it("si la reserva falla (migración sin aplicar, base caída) no se envía: falla cerrado", async () => {
    const w = setup({ replyGuard: guardConfig, handlers: handlers("GREETING"), audit: fakeAudit(async () => { throw new Error("no existe la función"); }) });
    await processTurns([turn("m1")], w.deps);
    expect(w.sends).toEqual([]);
    expect(w.logged("reply_withheld")).toEqual([{ reason: "unavailable" }]);
  });

  it("cada turno de un lote se evalúa por separado: el que pasa se envía y el limitado no", async () => {
    let call = 0;
    const w = setup({ replyGuard: guardConfig, handlers: handlers("GREETING"), audit: fakeAudit(async () => (++call === 1 ? "reserved" : "limited")) });
    // dos entregas separadas del mismo contacto (un lote de Kapso sería UNA solicitud con UNA reserva)
    const reports = [...(await processTurns([turn("m1")], w.deps)), ...(await processTurns([turn("m2")], w.deps))];
    expect(reports.map((r) => r.result)).toEqual(["conversation", "ignored"]);
    expect(w.sends).toHaveLength(1);
  });
});

describe("repositorio de auditoría: qué función de la base se usa", () => {
  const LEASED = { owner: "owner-0000001", fence: 3 };
  function repository(reply: unknown) {
    const calls: Array<{ name: string; body: Record<string, any> }> = [];
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      calls.push({ name: String(input).split("/rest/v1/rpc/")[1]!, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(reply), { status: 200 });
    }) as typeof fetch;
    return { calls, repo: createSupabaseAuditRepository({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn, retryDelayMs: 0, requestTimeoutMs: 1000 }) };
  }
  const guard = { config: DEFAULT_REPLY_GUARD, signature: "INFO_REQUEST:HOURS" };

  it("con guarda llama a plusmedik_turn_reserve_send_guarded con la configuración y la firma dentro de p_guard", async () => {
    const { calls, repo } = repository({ status: "reserved" });
    expect(await repo.reserveSend("run-1", "conversation", LEASED, { stale: "NEWER_TURN", guard })).toBe("reserved");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("plusmedik_turn_reserve_send_guarded");
    expect(calls[0]!.body).toMatchObject({ p_run_id: "run-1", p_owner: LEASED.owner, p_fence: 3, p_kind: "conversation", p_stale_policy: "NEWER_TURN", p_guard: { ...DEFAULT_REPLY_GUARD, signature: "INFO_REQUEST:HOURS" } });
  });

  it("sin firma no envía la clave 'signature'", async () => {
    const { calls, repo } = repository({ status: "reserved" });
    await repo.reserveSend("run-1", "conversation", LEASED, { stale: "NONE", guard: { config: DEFAULT_REPLY_GUARD } });
    expect(Object.keys(calls[0]!.body.p_guard)).not.toContain("signature");
  });

  it("'limited' solo se acepta de la función con guarda; de cualquier otra se trata como 'lost' (no se envía)", async () => {
    expect(await repository({ status: "limited", reason: "RATE_LIMITED" }).repo.reserveSend("run-1", "conversation", LEASED, { stale: "NONE", guard })).toBe("limited");
    expect(await repository({ status: "limited" }).repo.reserveSend("run-1", "conversation", LEASED, { stale: "NONE" })).toBe("lost");
    expect(await repository({ status: "limited" }).repo.reserveSend("run-1", "conversation", LEASED)).toBe("lost");
  });

  it("conserva el resto de resultados con guarda (blocked, busy, superseded) y el desconocido es 'lost'", async () => {
    for (const status of ["blocked", "busy", "superseded", "reserved"] as const) {
      expect(await repository({ status }).repo.reserveSend("run-1", "conversation", LEASED, { stale: "NONE", guard })).toBe(status);
    }
    expect(await repository({ status: "otra" }).repo.reserveSend("run-1", "conversation", LEASED, { stale: "NONE", guard })).toBe("lost");
  });

  it("sin guarda usa las funciones de siempre: turnos con { stale } y la de auditoría sin opciones", async () => {
    const turns = repository({ status: "reserved" });
    await turns.repo.reserveSend("run-1", "conversation", LEASED, { stale: "NONE" });
    expect(turns.calls[0]!.name).toBe("plusmedik_turn_reserve_send");
    expect(turns.calls[0]!.body.p_guard).toBeUndefined();
    const plain = repository({ status: "reserved" });
    await plain.repo.reserveSend("run-1", "quoted", LEASED);
    expect(plain.calls[0]!.name).toBe("plusmedik_audit_reserve_send");
  });
});

describe("fronteras del código (análisis estático)", () => {
  const root = join(__dirname, "..");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
  const source = (path: string) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");
  const rel = (path: string) => relative(root, path).replaceAll("\\", "/");
  const files = [...walk(join(root, "src")), ...walk(join(root, "api"))].filter((path) => path.endsWith(".ts"));

  it("el motor de recetas, la cotización y los lectores no conocen la guarda de respuestas", () => {
    const recipe = ["analyze", "partial-auto", "quote-completion", "catalog", "catalog-shadow", "catalog-semantic-resolver", "supabase-catalog", "ai", "judge", "consensus", "line-groups", "document-signal", "document-function", "study-impact", "visual-risk", "uncertainty", "safety", "pipeline", "image", "cache", "offline"];
    for (const name of recipe) expect(source(join(root, "src", `${name}.ts`)), name).not.toMatch(/reply[-_ ]?guard|loopProtection|replySignature/i);
  });

  it("solo la reserva de envío, el manejador de texto, la auditoría, los turnos y el cableado de Vercel nombran la guarda", () => {
    const allowed = new Set(["src/reply-guard.ts", "src/guarded-turn.ts", "src/text-handler.ts", "src/audit.ts", "src/turns.ts", "src/quote-session.ts", "src/quote-session-turns.ts", "src/batch-execution.ts", "api/kapso/webhook.ts"]);
    for (const path of files) {
      if (allowed.has(rel(path))) continue;
      expect(source(path), rel(path)).not.toMatch(/reply[-_ ]?guard|loopProtection|replySignature|looksAutomated/i);
    }
  });

  it("el módulo de la guarda solo importa la normalización de texto: ni auditoría, ni red, ni modelos", () => {
    const imports = [...source(join(root, "src/reply-guard.ts")).matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((match) => match[1]);
    expect(imports).toEqual(["./text-normalize.js"]);
  });

  it("nada en src/ ni en api/ puede levantar una supresión: el reset y la consulta de estado son solo para operadores (no los llama el agente)", () => {
    for (const path of files) expect(source(path), rel(path)).not.toMatch(/plusmedik_reply_guard_(reset|status)/);
  });

  it("el cableado de Vercel enciende la guarda solo con PLUSMEDIK_REPLY_GUARD=on (resolveReplyGuard) y una configuración inválida deja sin manejador de texto", () => {
    const api = source(join(root, "api/kapso/webhook.ts"));
    expect(api).toContain("const replyGuard = resolveReplyGuard(process.env);");
    expect(api).toMatch(/replyGuard: replyGuardConfig/);
    expect(api).toMatch(/textHandlerEnabled && !replyGuardInvalid/);
    expect(api).toMatch(/loopProtection: replyGuard\.enabled/);
  });

  it(".env.example define las dos variables nuevas y ambas están en blanco (apagadas)", () => {
    const example = source(join(root, ".env.example"));
    expect([...example.matchAll(/^(PLUSMEDIK_REPLY_GUARD[A-Z_]*)=(.*)$/gm)].map((match) => [match[1], match[2]!.trim()])).toEqual([["PLUSMEDIK_REPLY_GUARD", ""], ["PLUSMEDIK_REPLY_GUARD_CONFIG", ""]]);
  });
});
