// Superficie de LECTURA del conocimiento del laboratorio: es lo único que debe importar el motor conversacional. Las funciones de administración (admin.ts) NO se
// exportan aquí a propósito.
export * from "./types.js";
export { scheduleStatusAt, type ScheduleStatus } from "./schedule.js";
export { createSupabaseKnowledgeStore, type KnowledgeStore, type RawSnapshot } from "./store.js";
export { KnowledgeService, DEFAULT_MAX_STALE_MS, DEFAULT_REVISION_CHECK_MS, type KnowledgeServiceOptions } from "./service.js";
