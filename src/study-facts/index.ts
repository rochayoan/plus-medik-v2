// Superficie de LECTURA de los datos por estudio aprobados: es lo único que debe importar el motor conversacional. La administración (admin.ts) NO se exporta aquí a propósito.
export * from "./types.js";
export { createSupabaseStudyFactsStore, type StudyFactsStore } from "./store.js";
export { StudyFactsService, type StudyFactsQueries, type StudyFactsServiceOptions, type SampleView, type TurnaroundView } from "./service.js";
