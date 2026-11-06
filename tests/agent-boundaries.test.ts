import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// FRONTERAS DEL CÓDIGO del núcleo conversacional (src/agent, análisis estático): en esta fase solo DECIDE. No puede enviar, escribir en la base, derivar a una persona ni depender de la ruta de envío; solo el
// cableado de Vercel y los turnos lo conocen; la derivación humana del agente está fija en «no disponible»; y todo sigue apagado por defecto.

const root = join(__dirname, "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
const source = (path: string) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");
const code = (path: string) => source(path).split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).map((line) => line.replace(/\s\/\/.*$/, "")).join("\n");
const rel = (path: string) => relative(root, path).replaceAll("\\", "/");
const importsOf = (path: string) => [...source(path).matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((match) => match[1]!);
const agentFiles = walk(join(root, "src", "agent")).filter((path) => path.endsWith(".ts"));
const srcFiles = [...walk(join(root, "src")), ...walk(join(root, "api"))].filter((path) => path.endsWith(".ts"));

describe("el núcleo conversacional no puede actuar sobre el paciente ni sobre la base", () => {
  it("no importa la ruta de envío ni la derivación: ni turnos, ni guarda de envío, ni auditoría, ni el webhook, ni la cola al CRM, ni la atención", () => {
    const forbidden = /(^|\/)(turns|guarded-turn|kapso-webhook|audit|audit-recovery|human-control|crm-attention|daily-reply-cap|reply-guard|text-handler)\.js$|crm-outbox|\/message-history\.js$/;
    for (const path of agentFiles) for (const imported of importsOf(path)) {
      // text-handler solo lo usa el ejecutor en sombra para CLASIFICAR (classifyText, una función pura); el resto no lo toca
      if (rel(path) === "src/agent/shadow.ts" && imported === "../text-handler.js") continue;
      // el piloto usa SOLO el cliente RPC y la descripción de errores de la auditoría para dos lecturas (interruptor y mensajes recientes); se acota abajo
      if (rel(path) === "src/agent/pilot.ts" && imported === "../audit.js") continue;
      expect(imported, `${rel(path)} importa ${imported}`).not.toMatch(forbidden);
    }
  });

  it("no tiene función de envío, no llama a la red por su cuenta, no toca la base ni lee variables de entorno por su cuenta", () => {
    for (const path of agentFiles) {
      const text = code(path);
      expect(text, rel(path)).not.toMatch(/sendText|sendMessage|reserveSend|confirmSend|\.send\(/);
      expect(text, rel(path)).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|node:https?"/);
      expect(text, rel(path)).not.toMatch(/process\.env/);
      if (rel(path) === "src/agent/pilot.ts") continue;
      expect(text, rel(path)).not.toMatch(/plusmedik_(?!agent)|createSupabase|\.rpc\(|supabase/i);
    }
  });

  it("el piloto toca la base SOLO con dos lecturas (STABLE): el interruptor y los mensajes recientes; no escribe, no cambia el interruptor y no envía", () => {
    const pilot = code(join(root, "src/agent/pilot.ts"));
    const rpcs = [...pilot.matchAll(/["'](plusmedik_[a-z_]+)["']/g)].map((match) => match[1]).sort();
    expect(rpcs).toEqual(["plusmedik_agent_pilot_state", "plusmedik_history_recent"]);
    expect(pilot).not.toMatch(/pilot_set|insert|update|delete/i);
    expect(pilot).not.toMatch(/sendText|reserveSend|confirmSend/);
    // y esas dos funciones son de solo lectura en la propia base (migración 25)
    const migration = code(join(root, "supabase/migrations/20261113000000_plusmedik_agent_pilot.sql"));
    expect(migration).toMatch(/plusmedik_agent_pilot_state\(\)\s+returns jsonb\s+language sql\s+stable/);
    expect(migration).toMatch(/plusmedik_history_recent\([^)]*\)\s+returns jsonb\s+language plpgsql\s+stable/);
  });

  it("el único archivo que habla con OpenAI es openai.ts, y su cliente nunca activa herramientas nativas ni estado en el proveedor", () => {
    for (const path of agentFiles) {
      const imports = importsOf(path);
      if (rel(path) === "src/agent/openai.ts") expect(imports).toContain("openai");
      else expect(imports, rel(path)).not.toContain("openai");
    }
    const text = code(join(root, "src/agent/openai.ts"));
    expect(text).toContain("store: false");
    expect(text).toContain("strict: true");
    expect(text).not.toMatch(/\btools:\s*\[|tool_choice|previous_response_id/);
  });

  it("toda herramienta es de solo lectura y no existe ninguna que envíe, cotice con precios propios o derive", () => {
    const tools = code(join(root, "src/agent/tools.ts"));
    const definitions = [...tools.matchAll(/name: "([a-z_]+)"/g)].map((match) => match[1]);
    expect(definitions.sort()).toEqual(["conversation_state", "find_studies", "lab_info", "quote_studies"]);
    expect((tools.match(/readOnly: true/g) ?? []).length).toBe(definitions.length);
    expect(tools).not.toMatch(/handoff|derivar|sendText|insert|update|delete/i);
    // los precios solo salen del motor de cotización existente, nunca se calculan aquí
    expect(tools).toMatch(/evaluateSession/);
    expect(tools).toMatch(/formatSessionQuote/);
    expect(tools).not.toMatch(/priceBs\s*[*+]|toFixed|reduce\(/);
  });
});

describe("dónde puede aparecer el núcleo conversacional", () => {
  it("solo el cableado de Vercel, los turnos (que lo observan), la configuración de turnos (como TIPO) y el propio directorio lo nombran", () => {
    const allowed = new Set(["api/kapso/webhook.ts", "src/turns.ts", "src/guarded-turn.ts"]);
    for (const path of srcFiles) {
      if (rel(path).startsWith("src/agent/") || allowed.has(rel(path))) continue;
      expect(source(path), rel(path)).not.toMatch(/agentShadow|createAgentShadow|resolveAgentSettings|src\/agent|\.\/agent\//);
    }
    expect(importsOf(join(root, "src/guarded-turn.ts")).filter((imported) => imported.includes("agent")).sort()).toEqual(["./agent/pilot.js", "./agent/shadow.js"]);
    expect(source(join(root, "src/guarded-turn.ts"))).toMatch(/^import type \{ AgentShadow \} from "\.\/agent\/shadow\.js";$/m);
    expect(source(join(root, "src/guarded-turn.ts"))).toMatch(/^import type \{ AgentPilot \} from "\.\/agent\/pilot\.js";$/m);
    expect(importsOf(join(root, "src/turns.ts")).filter((imported) => imported.includes("agent"))).toEqual([]);
  });

  it("los turnos solo OBSERVAN los mensajes ya reclamados: no esperan la decisión antes de procesar y no pasan nada que permita enviar", () => {
    const turns = code(join(root, "src/turns.ts"));
    expect(turns).toMatch(/agentShadow\?\.observe\(\{ from, turns: observe\(claimed\) \}\)/);
    expect(turns).not.toMatch(/await agentShadow\?\.observe|await agentShadow\.observe/);
    // el flush va DESPUÉS de todo el trabajo de los turnos
    expect(turns.indexOf("await Promise.all(work);")).toBeLessThan(turns.indexOf("await agentShadow?.flush();"));
  });
});

describe("la derivación humana del agente está desactivada y todo está apagado por defecto", () => {
  const api = code(join(root, "api/kapso/webhook.ts"));

  it("el cableado fija la capacidad de derivar en false (ninguna bandera, ni la de la cola al CRM, la enciende)", () => {
    expect(api).toContain("capabilities: { handoff: false, quote: true },");
    const block = api.slice(api.indexOf("const agentShadow"), api.indexOf("const realDeps"));
    expect(block).not.toMatch(/crmOutbox|CRM|handoff:\s*true/);
  });

  it("solo se crea con PLUSMEDIK_AGENT=shadow Y el modo turnos (resolveAgentSettings) y se avisa si falta el modo turnos", () => {
    expect(api).toMatch(/const agentSettings = resolveAgentSettings\(process\.env, logLine\);/);
    expect(api).toMatch(/const agentShadow = agentSettings && agentMode === "shadow" && turnsEnabled\s*\?\s*createAgentShadow\(/);
    expect(api).toContain('logLine("agent_config_invalid", { error: "TURNS_REQUIRED" })');
    expect(api).toMatch(/\.\.\.\(agentShadow \? \{ agentShadow \} : \{\}\)/);
  });

  it("el piloto solo se crea con PLUSMEDIK_AGENT=pilot, la lista de números válida, el modo turnos y la memoria; y los turnos lo reciben solo si existe", () => {
    expect(api).toMatch(/const pilotSettings = agentSettings && \(agentMode === "pilot" \|\| agentMode === "live"\) \? resolveAgentPilotSettings\(process\.env, logLine, agentMode\) : undefined;/);
    // la memoria estructurada (convState) es OPCIONAL: el agente decide con los mensajes recientes del historial si no está
    expect(api).toMatch(/const agentPilot = agentSettings && pilotSettings && turnsEnabled\s*\?\s*createAgentPilot\(/);
    expect(api).not.toContain("CONV_STATE_REQUIRED");
    expect(api).toMatch(/\.\.\.\(agentPilot \? \{ agentPilot \} : \{\}\)/);
    // el piloto y la sombra son excluyentes: en modo piloto los demás contactos NO pasan por el modelo
    expect(api).toMatch(/agentMode === "shadow" && turnsEnabled/);
  });

  it("los turnos solo desvían a un contacto de la lista y un lote de TEXTO, después de reclamarlo; ante cualquier falta del piloto el lote sigue COMPLETO por la ruta de siempre", () => {
    const turns = code(join(root, "src/turns.ts"));
    expect(turns).toMatch(/pilot\?\.isPilot\(from\) && contactTurns\.length > 0 && contactTurns\.every\(\(turn\) => turn\.kind === "TEXT" && typeof turn\.text === "string"\)/);
    expect(turns).toMatch(/if \(!piloted\) return routine\(ctx\);/);
    // el respaldo de un contacto con UN solo mensaje es la ruta individual de siempre (no la del lote ni la del motor de lotes)
    expect(turns).toMatch(/const routine = contactTurns\.length === 1 && drafts\.length === 0 \? responder\.produce : produce;/);
    // el envío lo hace la MISMA reserva de siempre: el piloto devuelve una respuesta producida, no envía
    expect(turns).toMatch(/outcome = await responder\.claimed\.run\(produce\);/);
    expect(turns).not.toMatch(/pilot[\w.]*\.send|sendText\(.*piloted/);
    // el tope propio del piloto se entrega a la reserva como opción, no se salta
    expect(turns).toMatch(/\.\.\.\(piloted\.cap \? \{ cap: piloted\.cap \} : \{\}\)/);
  });

  it(".env.example define las variables del agente en blanco (apagado) y sin valor por defecto del modelo", () => {
    const example = source(join(root, ".env.example"));
    const values = Object.fromEntries([...example.matchAll(/^((?:PLUSMEDIK_AGENT|OPENAI_AGENT)[A-Z_]*)=(.*)$/gm)].filter((match) => !match[1]!.startsWith("PLUSMEDIK_AGENT_CONTROL")).map((match) => [match[1]!, match[2]!.trim()]));
    expect(values).toEqual({ PLUSMEDIK_AGENT: "", OPENAI_AGENT_MODEL: "", OPENAI_AGENT_REASONING: "", PLUSMEDIK_AGENT_TIMEOUT_MS: "", PLUSMEDIK_AGENT_SAMPLE: "", PLUSMEDIK_AGENT_PILOT_PHONES: "", PLUSMEDIK_AGENT_PILOT_DAILY_MAX: "", PLUSMEDIK_AGENT_HANDOFF: "", PLUSMEDIK_AGENT_EXCLUDE_PHONES: "", PLUSMEDIK_AGENT_DAILY_MAX: "", PLUSMEDIK_AGENT_DEADLINE_MS: "" });
  });
});
