import http from "node:http";
import https from "node:https";

// MODO OFFLINE centralizado. Ninguna llamada externa (modelos, Supabase, cualquier HTTP) puede salir cuando está activo, aunque un script olvide
// inyectar un verificador simulado o instale una guarda de gasto permisiva. Dos capas independientes:
//
//  1. CAPA DE LLAMADAS A MODELOS (strict): `cachedAiCall` (el único punto por el que pasan las llamadas a modelos) consulta `assertModelCallsAllowed`
//     ANTES de la guarda de gasto. Con strict, una respuesta que no está en cache nunca llega a `call`. Las respuestas cacheadas siguen sirviéndose.
//  2. CAPA DE RED: `fetch`, `http.request/get` y `https.request/get` se reemplazan por funciones que lanzan `OfflineViolation`. Cubre cualquier SDK
//     (OpenAI, Gemini, Supabase por fetch) aunque eluda la capa 1. Debe activarse ANTES de construir los clientes: los SDK capturan `fetch` al crearse.
//
// Se activa con `enforceOffline()` (script/arranque) o con PLUSMEDIK_OFFLINE=1 (la capa 1 lo lee del entorno en cada llamada). Una vez activado
// por código es PEGAJOSO: borrar la variable de entorno no lo desactiva. Las pruebas usan solo la capa 2 (para no romper simulaciones locales).

export class OfflineViolation extends Error {
  constructor(what: string) {
    super(`MODO OFFLINE: se bloqueó un intento de acceso externo (${what}). Ninguna llamada de red ni a modelos está permitida.`);
    this.name = "OfflineViolation";
  }
}

interface State {
  strict: boolean;
  network: boolean;
  attempts: string[];
  originals?: { fetch: typeof fetch; httpRequest: typeof http.request; httpGet: typeof http.get; httpsRequest: typeof https.request; httpsGet: typeof https.get };
}
const state: State = { strict: false, network: false, attempts: [] };

const truthy = (value: string | undefined) => ["1", "true", "on", "yes"].includes((value ?? "").trim().toLowerCase());

function describe(input: unknown): string {
  if (typeof input === "string") return input.slice(0, 80);
  if (input instanceof URL) return input.href.slice(0, 80);
  if (typeof input === "object" && input !== null && "url" in input) return String((input as { url: unknown }).url).slice(0, 80);
  return "red";
}

function block(what: string): never {
  state.attempts.push(what);
  throw new OfflineViolation(what);
}

// PLUSMEDIK_OFFLINE=1 activa la capa estricta fuera de las pruebas. Dentro de vitest la variable solo bloquea la RED (capa 2): las pruebas simulan las
// llamadas a modelos con funciones locales (no son llamadas reales) y una llamada real igualmente fallaría en la red bloqueada.
export function isOfflineStrict(env: NodeJS.ProcessEnv = process.env): boolean {
  return state.strict || (truthy(env.PLUSMEDIK_OFFLINE) && !env.VITEST);
}

// Lo llama cachedAiCall justo antes de cualquier llamada real (después de comprobar el cache, antes de la guarda de gasto).
export function assertModelCallsAllowed(label: string, provider: string, model: string): void {
  if (isOfflineStrict()) block(`llamada a ${provider}/${model} (${label})`);
}

export function offlineAttempts(): readonly string[] {
  return state.attempts;
}

export function isNetworkBlocked(): boolean {
  return state.network;
}

export function enforceOffline(options: { strict?: boolean } = {}): void {
  const strict = options.strict ?? true;
  if (strict) state.strict = true;
  if (state.network) return;
  state.originals = { fetch: globalThis.fetch, httpRequest: http.request, httpGet: http.get, httpsRequest: https.request, httpsGet: https.get };
  const blockedFetch = (async (input: unknown) => block(`fetch ${describe(input)}`)) as unknown as typeof fetch;
  const blockedRequest = ((input: unknown) => block(`http ${describe(input)}`)) as unknown as typeof http.request;
  globalThis.fetch = blockedFetch;
  (http as { request: unknown }).request = blockedRequest;
  (http as { get: unknown }).get = blockedRequest;
  (https as { request: unknown }).request = blockedRequest;
  (https as { get: unknown }).get = blockedRequest;
  state.network = true;
}

// Con PLUSMEDIK_OFFLINE=1 la red queda bloqueada en cuanto se carga este módulo (lo carga cachedAiCall), sin que el script tenga que acordarse.
if (truthy(process.env.PLUSMEDIK_OFFLINE)) enforceOffline({ strict: false });

// Solo para pruebas: restaura la red y la capa estricta. Falla fuera de vitest para que un script no pueda desactivar la protección.
export function releaseOfflineForTests(): void {
  if (!process.env.VITEST) throw new Error("releaseOfflineForTests solo se puede usar dentro de vitest");
  if (state.originals) {
    globalThis.fetch = state.originals.fetch;
    (http as { request: unknown }).request = state.originals.httpRequest;
    (http as { get: unknown }).get = state.originals.httpGet;
    (https as { request: unknown }).request = state.originals.httpsRequest;
    (https as { get: unknown }).get = state.originals.httpsGet;
  }
  state.network = false;
  state.strict = false;
  state.attempts.length = 0;
}
