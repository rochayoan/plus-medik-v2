// Actualiza la sucursal central del conocimiento APROBADO (dirección, link de Maps y teléfonos) que el agente cita cuando preguntan por la ubicación.
//
// Es una ESCRITURA en producción con flujo de aprobación (cuatro ojos): por defecto NO escribe, solo muestra lo que cambiaría. Con --apply crea el borrador, lo envía y lo aprueba, y exige DOS personas
// distintas (--editor-id y --approver-id): la base rechaza que quien redacta apruebe. Los ids son seudónimos estables (p. ej. "crm:<uuid>"), nunca nombre, correo ni teléfono.
//
//   npx tsx --env-file=.env scripts/kb-update-branch.ts --maps-url https://maps.app.goo.gl/XXXX --address "Calle ..." [--phone "77602262 - 62007191"]
//   npx tsx --env-file=.env scripts/kb-update-branch.ts ...mismos datos... --apply --editor-id crm:aaa --approver-id crm:bbb
//
// Variables: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY. Nunca imprime claves.

import { branchPayload } from "../src/knowledge/types.js";
import { createKnowledgeAdminRepository, type KnowledgeActor } from "../src/knowledge/admin.js";

function args(argv: string[]): Map<string, string | true> {
  const map = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { map.set(token.slice(2), next); i++; } else map.set(token.slice(2), true);
  }
  return map;
}
const fail = (message: string): never => { console.error(message); process.exit(1); };
const text = (value: string | true | undefined): string | undefined => (typeof value === "string" ? value.trim() : undefined);

async function main(): Promise<void> {
  const flags = args(process.argv.slice(2));
  const mapsUrl = text(flags.get("maps-url"));
  const address = text(flags.get("address"));
  const phone = text(flags.get("phone"));
  if (!mapsUrl && !address && !phone) fail("Indica al menos --maps-url, --address o --phone.");
  const repo = createKnowledgeAdminRepository();

  // Lo vigente hoy: se parte de ello para no perder el nombre ni las notas.
  const history = await repo.history("BRANCH", "central");
  const current = (history.versions.find((version) => version.status === "APPROVED") ?? {}) as { payload?: Record<string, unknown> };
  const base = current.payload ?? {};
  const next = branchPayload.safeParse({ ...base, ...(mapsUrl ? { mapsUrl } : {}), ...(address ? { address } : {}), ...(phone ? { phone } : {}) });
  if (!next.success) fail(`Los datos no son válidos: ${next.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const payload = next.data!;

  console.log("Vigente :", JSON.stringify(base));
  console.log("Propuesto:", JSON.stringify(payload));
  if (!flags.has("apply")) {
    console.log("\nModo de prueba: no se escribió nada. Añade --apply --editor-id <id> --approver-id <id> para crear, enviar y aprobar la versión.");
    return;
  }
  const editorId = text(flags.get("editor-id"));
  const approverId = text(flags.get("approver-id"));
  if (!editorId || !approverId || editorId === approverId) fail("--apply exige --editor-id y --approver-id, y deben ser personas distintas.");
  // --editor-type AI declara que quien redacta es una IA (queda así en el rastro de la base); quien aprueba siempre es una persona.
  const editor: KnowledgeActor = { id: editorId!, type: text(flags.get("editor-type")) === "AI" ? "AI" : "HUMAN", role: "EDITOR" };
  const approver: KnowledgeActor = { id: approverId!, type: "HUMAN", role: "ADMIN_APPROVER" };
  const draft = await repo.createDraft({ kind: "BRANCH", key: "central", payload, sourceRef: "actualización de ubicación 2026-11-10" }, editor);
  await repo.submit(draft.versionId, editor);
  const approved = await repo.approve(draft.versionId, approver);
  console.log(`Versión ${draft.version} ${approved.status}${approved.revision !== undefined ? ` (revisión ${approved.revision})` : ""}. El agente la usará en cuanto recargue el conocimiento.`);
}

main().catch((error) => {
  // Nunca el cuerpo del error: puede traer datos.
  console.error(`Falló: ${error instanceof Error ? error.name : "error"}`);
  process.exit(1);
});
