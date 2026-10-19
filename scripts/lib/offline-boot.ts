// Importar PRIMERO en cualquier script de repetición/diagnóstico sin gasto: `import "./lib/offline-boot.js";`
// Activa el modo offline estricto (src/offline.ts) antes de que se construya ningún cliente de red.
import { enforceOffline } from "../../src/offline.js";

enforceOffline({ strict: true });
