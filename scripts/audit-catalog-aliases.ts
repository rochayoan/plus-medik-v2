// FASE 2D — Auditoría global de aliases del catálogo. SOLO LECTURA: únicamente emite GET y escribe un reporte local.
// Reglas determinísticas: las formas cortas se derivan del propio texto del catálogo y las colisiones son exactas.
// No hay fuzzy, embeddings ni equivalencias clínicas inventadas.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeStudyKey } from "../src/consensus.js";

export interface AuditTest {
  id: string;
  code: string | null;
  name: string;
  normalized_name: string;
  category: string | null;
  sample_type: string | null;
  active: boolean;
}

export interface AuditAlias {
  id: string;
  lab_test_id: string;
  alias: string;
  normalized_alias: string;
}

export type AuditStatus =
  | "SAFE_ALIAS_CANDIDATE"
  | "AMBIGUOUS"
  | "COMPOSITE_POLICY_REQUIRED"
  | "ALREADY_COVERED"
  | "NO_ALIAS_NEEDED";

export type Generator = "method_stripped" | "head_before_parenthesis" | "acronym_in_parenthesis" | "existing_alias";

export interface Collision {
  id: string;
  code: string | null;
  name: string;
  via: "normalized_name" | "existing_alias" | "same_candidate_from_other_study" | "variant_sibling";
}

export interface AuditEntry {
  candidate: string | null;
  normalizedCandidate: string | null;
  generator: Generator | null;
  // high: solo se quitó el método. review: se quitó texto entre paréntesis que no es método (verificar a mano).
  confidence: "high" | "review" | null;
  status: AuditStatus;
  reasons: string[];
  collisions: Collision[];
}

export interface AuditedStudy {
  id: string;
  code: string | null;
  name: string;
  normalizedName: string;
  category: string | null;
  sampleType: string | null;
  existingAliases: string[];
  composite: boolean;
  entries: AuditEntry[];
}

export interface AuditResult {
  studies: AuditedStudy[];
  existingAliasIssues: string[];
  summary: {
    totalTests: number;
    activeStudies: number;
    currentAliases: number;
    entriesByStatus: Record<AuditStatus, number>;
    studiesByRollup: Record<AuditStatus, number>;
  };
}

// Métodos analíticos: quitarlos NO cambia qué se pide (pero puede haber hermanos con otro método).
export const METHOD_TOKENS = new Set([
  "eclia", "fia", "elisa", "clia", "ifi", "pcr", "qpcr", "rt", "fluorescencia", "inmunofluorescencia",
  "automatizado", "quimioluminiscencia", "turbidimetria", "nefelometria"
]);

// Calificadores que SÍ cambian el estudio (isotipo, población, forma, cantidad, formato...). Nunca se quitan.
export const VARIANT_TOKENS = new Set([
  "igg", "igm", "iga", "ige", "neonatal", "libre", "total", "directa", "indirecta", "cualitativo", "cualitativa",
  "cuantitativo", "cuantitativa", "semi", "pediatrico", "pediatrica", "rapida", "prueba", "basal", "inversa",
  "ocasional", "24", "horas", "hrs", "hr", "2h", "60", "120", "min", "simple", "doble", "cadena", "convencional",
  // Muestra/matriz: "magnesio" (suero) no es "magnesio en orina".
  "orina", "heces", "saliva", "sangre", "plasma", "suero", "liquido", "esputo", "secrecion"
]);

// Conectores que pueden aparecer entre un nombre base y su calificador ("magnesio EN orina DE 24 hrs").
export const CONNECTOR_TOKENS = new Set(["en", "de", "del", "la", "el", "y", "o", "a", "con", "por", "para"]);

const COMPOSITE_TOKENS = new Set(["perfil", "panel", "paquete", "curva", "screening", "tamizaje", "chequeo"]);

export const tokensOf = (value: string): string[] => normalizeStudyKey(value).split(" ").filter(Boolean);

export function parenGroups(name: string): Array<{ start: number; end: number; content: string }> {
  return [...name.matchAll(/\(([^()]*)\)/g)].map((match) => ({
    start: match.index!,
    end: match.index! + match[0].length,
    content: match[1]!
  }));
}

const onlyOf = (tokens: string[], allowed: Set<string>) => tokens.length > 0 && tokens.every((token) => allowed.has(token));
const isMethodOnly = (content: string) => onlyOf(tokensOf(content), METHOD_TOKENS);
const isQualifierOnly = (content: string) => {
  const tokens = tokensOf(content);
  return tokens.length > 0 && tokens.every((token) => METHOD_TOKENS.has(token) || VARIANT_TOKENS.has(token));
};

function isComposite(name: string): boolean {
  if (tokensOf(name).some((token) => COMPOSITE_TOKENS.has(token))) return true;
  if (name.includes("+")) return true;
  const groups = parenGroups(name);
  if (groups.length >= 4) return true; // lista de componentes entre paréntesis
  return groups.some((group) => (group.content.match(/[,;]/g) ?? []).length >= 2);
}

interface RawCandidate {
  text: string;
  generator: Exclude<Generator, "existing_alias">;
}

// Formas cortas derivadas únicamente del texto del propio estudio.
function deriveCandidates(name: string): RawCandidate[] {
  const out: RawCandidate[] = [];
  const groups = parenGroups(name);
  const remove = (predicate: (group: { content: string }) => boolean) => {
    let text = name;
    for (const group of [...groups].reverse()) {
      if (predicate(group)) text = text.slice(0, group.start) + text.slice(group.end);
    }
    return text.replace(/\s+/g, " ").trim();
  };

  // G1: quitar paréntesis que son solo método ("FSH (ECLIA)" -> "FSH").
  if (groups.some((group) => isMethodOnly(group.content))) {
    out.push({ text: remove((group) => isMethodOnly(group.content)), generator: "method_stripped" });
  }

  // G2/G3: solo si el último paréntesis cierra el nombre y no es método ni calificador.
  const last = groups[groups.length - 1];
  if (last && name.trim().endsWith(")") && last.end === name.trimEnd().length && !isQualifierOnly(last.content)) {
    const head = name.slice(0, last.start).trim();
    const headWithoutMethods = remove((group) => isMethodOnly(group.content) || group === last).trim();
    if (tokensOf(headWithoutMethods || head).length > 0) {
      out.push({ text: headWithoutMethods || head, generator: "head_before_parenthesis" });
    }
    const content = last.content.trim();
    if (/^[A-Za-z][A-Za-z0-9-]{1,7}$/.test(content) && /[A-Z0-9]/.test(content)) {
      out.push({ text: content, generator: "acronym_in_parenthesis" });
    }
  }
  return out;
}

const isUsableCandidate = (normalized: string) => {
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length === 0 || normalized.length < 2) return false;
  if (tokens.every((token) => METHOD_TOKENS.has(token) || VARIANT_TOKENS.has(token))) return false;
  return !/^\d+$/.test(normalized);
};

// El resto de otro estudio (tras la forma corta) son solo método/variante/muestra: es una variante del mismo estudio.
export const isVariantRemainder = (rest: string[]) =>
  rest.every((token) => METHOD_TOKENS.has(token) || VARIANT_TOKENS.has(token) || CONNECTOR_TOKENS.has(token)) &&
  rest.some((token) => METHOD_TOKENS.has(token) || VARIANT_TOKENS.has(token));

export const startsWithTokens = (tokens: string[], prefix: string[]) =>
  prefix.length > 0 && tokens.length > prefix.length && prefix.every((token, index) => tokens[index] === token);

export function auditCatalog(tests: AuditTest[], aliases: AuditAlias[]): AuditResult {
  const active = tests.filter((test) => test.active);
  const activeById = new Map(active.map((test) => [test.id, test]));
  const testsById = new Map(tests.map((test) => [test.id, test]));

  const existingAliasIssues: string[] = [];
  for (const alias of aliases) {
    const target = testsById.get(alias.lab_test_id);
    if (!target) existingAliasIssues.push(`alias "${alias.alias}" apunta a un UUID inexistente (${alias.lab_test_id})`);
    else if (!target.active) existingAliasIssues.push(`alias "${alias.alias}" apunta a un estudio inactivo (${target.name})`);
    const clash = active.filter((test) => test.normalized_name === alias.normalized_alias && test.id !== alias.lab_test_id);
    if (clash.length > 0) existingAliasIssues.push(`alias "${alias.alias}" coincide con el normalized_name de otro estudio activo (${clash.map((c) => c.name).join("; ")})`);
  }
  const aliasGroups = new Map<string, AuditAlias[]>();
  for (const alias of aliases) aliasGroups.set(alias.normalized_alias, [...(aliasGroups.get(alias.normalized_alias) ?? []), alias]);
  for (const [normalized, group] of aliasGroups) {
    if (new Set(group.map((alias) => alias.lab_test_id)).size > 1) existingAliasIssues.push(`el alias "${normalized}" apunta a más de un UUID`);
  }

  // Candidatos derivados por estudio (normalizados y filtrados).
  const derived = new Map<string, Array<RawCandidate & { normalized: string }>>();
  const producers = new Map<string, Set<string>>(); // normalized candidate -> ids de estudios que lo generan
  for (const test of active) {
    const seen = new Set<string>();
    const list: Array<RawCandidate & { normalized: string }> = [];
    for (const candidate of deriveCandidates(test.name)) {
      const normalized = normalizeStudyKey(candidate.text);
      if (!isUsableCandidate(normalized) || normalized === test.normalized_name || seen.has(normalized)) continue;
      seen.add(normalized);
      list.push({ ...candidate, normalized });
      producers.set(normalized, new Set([...(producers.get(normalized) ?? []), test.id]));
    }
    derived.set(test.id, list);
  }

  const studies: AuditedStudy[] = active.map((test) => {
    const own = aliases.filter((alias) => alias.lab_test_id === test.id);
    const composite = isComposite(test.name);
    const entries: AuditEntry[] = [];

    for (const alias of own) {
      entries.push({
        candidate: alias.alias,
        normalizedCandidate: alias.normalized_alias,
        generator: "existing_alias",
        confidence: null,
        status: "ALREADY_COVERED",
        reasons: ["alias existente apuntando a este UUID"],
        collisions: []
      });
    }

    for (const candidate of derived.get(test.id) ?? []) {
      const reasons: string[] = [];
      const collisions: Collision[] = [];
      const candidateTokens = candidate.normalized.split(" ");

      const ownAlias = own.find((alias) => alias.normalized_alias === candidate.normalized);
      if (ownAlias) {
        // Ya existe como alias de este mismo UUID: no se vuelve a proponer.
        continue;
      }

      for (const other of active) {
        if (other.id === test.id) continue;
        if (other.normalized_name === candidate.normalized) {
          collisions.push({ id: other.id, code: other.code, name: other.name, via: "normalized_name" });
        } else if (startsWithTokens(other.normalized_name.split(" "), candidateTokens)) {
          const rest = other.normalized_name.split(" ").slice(candidateTokens.length);
          if (isVariantRemainder(rest)) {
            collisions.push({ id: other.id, code: other.code, name: other.name, via: "variant_sibling" });
          }
        }
      }
      for (const alias of aliases) {
        if (alias.normalized_alias === candidate.normalized && alias.lab_test_id !== test.id) {
          const target = testsById.get(alias.lab_test_id);
          collisions.push({ id: alias.lab_test_id, code: target?.code ?? null, name: target?.name ?? "(desconocido)", via: "existing_alias" });
        }
      }
      for (const producerId of producers.get(candidate.normalized) ?? []) {
        if (producerId === test.id) continue;
        const other = activeById.get(producerId)!;
        collisions.push({ id: other.id, code: other.code, name: other.name, via: "same_candidate_from_other_study" });
      }

      let status: AuditStatus;
      const hardCollision = collisions.some((collision) => collision.via !== "variant_sibling");
      if (hardCollision) {
        status = "AMBIGUOUS";
        reasons.push("la misma forma corta apunta o podría apuntar a más de un UUID");
      } else if (composite) {
        status = "COMPOSITE_POLICY_REQUIRED";
        reasons.push("el estudio es compuesto (perfil/panel/lista de componentes): la forma corta puede representar varios estudios");
      } else if (collisions.length > 0) {
        status = "AMBIGUOUS";
        reasons.push("existen variantes del mismo estudio (método, isotipo, población, forma) y no se puede elegir automáticamente");
      } else {
        status = "SAFE_ALIAS_CANDIDATE";
        reasons.push(
          candidate.generator === "method_stripped"
            ? "se quitó solo el método entre paréntesis; ningún otro estudio activo coincide ni es variante"
            : candidate.generator === "head_before_parenthesis"
              ? "parte del nombre antes del último paréntesis; ningún otro estudio activo coincide ni es variante (verificar que el paréntesis sea solo aclaración)"
              : "sigla entre paréntesis; ningún otro estudio activo la usa"
        );
      }
      entries.push({
        candidate: candidate.text,
        normalizedCandidate: candidate.normalized,
        generator: candidate.generator,
        confidence: candidate.generator === "method_stripped" ? "high" : "review",
        status,
        reasons,
        collisions
      });
    }

    if (entries.length === 0) {
      entries.push({
        candidate: null,
        normalizedCandidate: null,
        generator: null,
        confidence: null,
        status: "NO_ALIAS_NEEDED",
        reasons: [composite ? "estudio compuesto sin forma corta derivable del nombre" : "el nombre no tiene forma corta derivable de forma determinista; el normalized_name ya es el match exacto"],
        collisions: []
      });
    }

    return {
      id: test.id,
      code: test.code,
      name: test.name,
      normalizedName: test.normalized_name,
      category: test.category,
      sampleType: test.sample_type,
      existingAliases: own.map((alias) => alias.alias),
      composite,
      entries
    };
  });

  const blank = (): Record<AuditStatus, number> => ({
    SAFE_ALIAS_CANDIDATE: 0,
    AMBIGUOUS: 0,
    COMPOSITE_POLICY_REQUIRED: 0,
    ALREADY_COVERED: 0,
    NO_ALIAS_NEEDED: 0
  });
  const entriesByStatus = blank();
  const studiesByRollup = blank();
  // Rollup por estudio: el estado más "accionable" gana (SAFE > AMBIGUOUS > COMPOSITE > ALREADY_COVERED > NO_ALIAS_NEEDED).
  const priority: AuditStatus[] = ["SAFE_ALIAS_CANDIDATE", "AMBIGUOUS", "COMPOSITE_POLICY_REQUIRED", "ALREADY_COVERED", "NO_ALIAS_NEEDED"];
  for (const study of studies) {
    for (const entry of study.entries) entriesByStatus[entry.status]++;
    studiesByRollup[priority.find((status) => study.entries.some((entry) => entry.status === status))!]++;
  }

  return {
    studies,
    existingAliasIssues,
    summary: {
      totalTests: tests.length,
      activeStudies: active.length,
      currentAliases: aliases.length,
      entriesByStatus,
      studiesByRollup
    }
  };
}

// Selección determinística y repartida (no solo las primeras filas) para los ejemplos de consola.
export function spreadSample<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  return Array.from({ length: count }, (_, index) => items[Math.floor((index * items.length) / count)]!);
}

const flatEntries = (result: AuditResult, status: AuditStatus) =>
  result.studies
    .flatMap((study) => study.entries.filter((entry) => entry.status === status).map((entry) => ({ study, entry })))
    .sort((a, b) => Number(a.study.code ?? 1e9) - Number(b.study.code ?? 1e9) || a.study.name.localeCompare(b.study.name));

const csvCell = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;

export function toCsv(result: AuditResult): string {
  const header = ["code", "id", "name", "category", "sample_type", "composite", "candidate", "normalized_candidate", "generator", "confidence", "status", "reasons", "collisions"];
  const rows = result.studies.flatMap((study) =>
    study.entries.map((entry) =>
      [
        study.code, study.id, study.name, study.category, study.sampleType, study.composite,
        entry.candidate, entry.normalizedCandidate, entry.generator, entry.confidence, entry.status,
        entry.reasons.join(" | "),
        entry.collisions.map((c) => `${c.code ?? "?"} ${c.name} [${c.via}]`).join(" | ")
      ].map(csvCell).join(",")
    )
  );
  return `﻿${[header.join(","), ...rows].join("\n")}\n`;
}

async function getAll<T>(baseUrl: string, serviceKey: string, path: string): Promise<T[]> {
  const rows: T[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
      method: "GET",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Range: `${from}-${from + pageSize - 1}`, "Range-Unit": "items" }
    });
    if (!response.ok) throw new Error(`GET ${path.split("?")[0]} -> HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const page = (await response.json()) as T[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function main() {
  try {
    process.loadEnvFile(".env");
  } catch {
    // .env es opcional si las variables ya están en el entorno
  }
  const baseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) {
    console.error("Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en .env");
    process.exit(1);
  }

  const [tests, aliases] = await Promise.all([
    getAll<AuditTest>(baseUrl, serviceKey, "lab_tests?select=id,code,name,normalized_name,category,sample_type,active&order=id.asc"),
    getAll<AuditAlias>(baseUrl, serviceKey, "lab_test_aliases?select=id,lab_test_id,alias,normalized_alias&order=id.asc")
  ]);
  const result = auditCatalog(tests, aliases);

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const dir = join(process.cwd(), ".cache", "reports"); // .cache/ está fuera de Git
  await mkdir(dir, { recursive: true });
  const jsonPath = join(dir, `catalog-alias-audit-${stamp}.json`);
  const csvPath = join(dir, `catalog-alias-audit-${stamp}.csv`);
  await writeFile(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), ...result }, null, 2));
  await writeFile(csvPath, toCsv(result));

  const { summary } = result;
  console.log("AUDITORÍA DE ALIASES (solo lectura, nada se escribió en Supabase)\n");
  console.log(`1. Estudios activos analizados: ${summary.activeStudies} (de ${summary.totalTests} totales)`);
  console.log(`2. Aliases actuales: ${summary.currentAliases}`);
  console.log(`3. SAFE_ALIAS_CANDIDATE:       ${summary.entriesByStatus.SAFE_ALIAS_CANDIDATE}   (estudios con al menos uno: ${summary.studiesByRollup.SAFE_ALIAS_CANDIDATE})`);
  console.log(`4. AMBIGUOUS:                  ${summary.entriesByStatus.AMBIGUOUS}`);
  console.log(`5. COMPOSITE_POLICY_REQUIRED:  ${summary.entriesByStatus.COMPOSITE_POLICY_REQUIRED}`);
  console.log(`6. ALREADY_COVERED:            ${summary.entriesByStatus.ALREADY_COVERED}`);
  console.log(`7. NO_ALIAS_NEEDED:            ${summary.entriesByStatus.NO_ALIAS_NEEDED}   (estudios sin forma corta derivable)`);
  console.log("   (conteos por candidato; NO_ALIAS_NEEDED cuenta estudios)");
  if (result.existingAliasIssues.length > 0) {
    console.log(`\n   Problemas en aliases existentes: ${result.existingAliasIssues.length}`);
    for (const issue of result.existingAliasIssues) console.log(`   - ${issue}`);
  }

  console.log("\n8. 25 ejemplos SAFE_ALIAS_CANDIDATE (muestra repartida):");
  for (const { study, entry } of spreadSample(flatEntries(result, "SAFE_ALIAS_CANDIDATE"), 25)) {
    console.log(`   [${study.code ?? "-"}] "${entry.candidate}"  ->  ${study.name.slice(0, 70)}  (${entry.generator}, ${entry.confidence})`);
  }
  console.log("\n9. 25 ejemplos AMBIGUOUS (muestra repartida):");
  for (const { study, entry } of spreadSample(flatEntries(result, "AMBIGUOUS"), 25)) {
    const with_ = entry.collisions.slice(0, 2).map((collision) => `${collision.code ?? "?"} ${collision.name.slice(0, 28)} [${collision.via}]`).join("; ");
    console.log(`   [${study.code ?? "-"}] "${entry.candidate}"  ->  ${study.name.slice(0, 40)}  | choca con: ${with_}`);
  }
  console.log(`\n10. Reporte completo:\n   ${jsonPath}\n   ${csvPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`ERROR: ${(error as Error).message}`);
    process.exit(1);
  }
}
