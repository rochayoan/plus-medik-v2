import fs from "node:fs/promises";
import path from "node:path";

/**
 * Benchmark privado mínimo.
 * Espera private-data/manifest.json. Ese directorio está ignorado por Git.
 * En la siguiente fase conectaremos PlusMedikCore y el catálogo real.
 */
const manifestPath = path.resolve("private-data/manifest.json");

try {
  const raw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as unknown[];
  console.log(`Benchmark manifest loaded: ${manifest.length} cases`);
  console.log("TODO: wire actual readers + migrated catalog in Phase 1.");
} catch {
  console.error("Missing private-data/manifest.json (intentionally not tracked by Git).");
  process.exitCode = 1;
}
