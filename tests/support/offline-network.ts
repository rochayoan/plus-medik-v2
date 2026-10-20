// Arranque de TODAS las pruebas: ninguna puede salir a la red real. Las simulaciones locales (fetch inyectado, vi.fn) siguen funcionando porque
// reemplazan a las funciones bloqueadas; lo que intente usar la red de verdad lanza OfflineViolation.
import { enforceOffline } from "../../src/offline.js";

enforceOffline({ strict: false });
