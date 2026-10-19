// COBERTURA DE ALIASES — propuesta para revisión humana. SOLO LECTURA: únicamente emite GET y escribe CSV/JSON locales.
// No inserta nada en Supabase. No modifica el matcher, modelos, prompts ni safety.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ExactAliasCatalogResolver } from "../src/catalog.js";
import { normalizeStudyKey } from "../src/consensus.js";
import type { CatalogResolution, CatalogStudy } from "../src/types.js";
import { CONNECTOR_TOKENS, METHOD_TOKENS, VARIANT_TOKENS, auditCatalog, type AuditAlias, type AuditTest } from "./audit-catalog-aliases.js";
import { COMPOSITES, CURATED, SUS_FORM_TEXTS, type CuratedGroup } from "./data/curated-aliases.js";
import { evaluateBatch1, type LiveTest } from "./prepare-alias-batch1.js";

export type AliasState = "SEGURO" | "AMBIGUO" | "REQUIERE_REVISION";
export type ConflictType = "nombre_oficial_de_otro_estudio" | "alias_existente_de_otro_estudio" | "alias_compartido_entre_estudios" | "variante_competidora";

export interface ProposedAlias {
  studyId: string;
  code: string | null;
  officialName: string;
  alias: string;
  normalized: string;
  state: AliasState;
  sources: string[];
  reasons: string[];
  competitors: Array<{ code: string | null; name: string }>;
  conflicts: ConflictType[];
  downgradedFrom?: AliasState;
}

export interface StudyRow {
  code: string | null;
  id: string;
  name: string;
  category: string | null;
  existingAliases: string[];
  newAliases: ProposedAlias[];
  state: AliasState | "SIN_ALIAS_NUEVO";
  justification: string;
}

export interface TextCheck {
  text: string;
  origin: string;
  today: string;
  withSafeAliases: string;
  unsafeProposals: string[];
  composite?: string;
}

export interface CoverageResult {
  studies: StudyRow[];
  aliases: ProposedAlias[];
  curationErrors: string[];
  stats: {
    activeStudies: number;
    totalTests: number;
    existingAliases: number;
    studiesWithExistingAlias: number;
    studiesWithSafeNew: number;
    studiesWithOnlyUnsafe: number;
    studiesWithNothingNew: number;
    studiesReachableWithSafe: number;
    proposedTotal: number;
    distinctAliases: number;
    distinctByState: Record<AliasState, number>;
    byState: Record<AliasState, number>;
    bySource: Record<string, number>;
    redundantDropped: number;
    alreadyExistingDropped: number;
    tooShortDropped: number;
    tooLongDropped: number;
    conflictsByType: Record<ConflictType, number>;
    conflictAliasCount: number;
    batch1Evaluated: number;
    batch1Downgraded: number;
  };
}

// ─────────────────────────────── utilidades ───────────────────────────────

const RANK: Record<AliasState, number> = { SEGURO: 0, REQUIERE_REVISION: 1, AMBIGUO: 2 };
const worst = (a: AliasState, b: AliasState): AliasState => (RANK[a] >= RANK[b] ? a : b);

const BENIGN = new Set<string>([
  ...METHOD_TOKENS,
  ...VARIANT_TOKENS,
  ...CONNECTOR_TOKENS,
  "inmuno", "test", "prueba", "rapido", "varon", "mujer", "hombre", "fluorescencia", "semicuantitativo", "semicuantitativa"
]);

// "semi cuantitativo" es un único calificador (distinto de "cuantitativo"); se une para no confundirlo con él.
const tokens = (value: string) => value.replace(/\bsemi cuantitativ/g, "semicuantitativ").split(" ").filter(Boolean);

// Otro estudio activo es "variante competidora" del alias si contiene TODOS los tokens del alias y lo que le sobra
// es solo método, calificador, muestra o conector (mismo analito con otra variante).
export function findCompetitors(aliasNorm: string, target: { id: string }, active: Array<{ id: string; code: string | null; name: string; normalized_name: string }>) {
  const aliasTokens = new Set(tokens(aliasNorm));
  if (aliasTokens.size === 0) return [];
  return active.filter((other) => {
    if (other.id === target.id) return false;
    const otherTokens = tokens(other.normalized_name);
    const otherSet = new Set(otherTokens);
    if (![...aliasTokens].every((token) => otherSet.has(token))) return false;
    const rest = otherTokens.filter((token) => !aliasTokens.has(token));
    return rest.length > 0 && rest.every((token) => BENIGN.has(token));
  });
}

interface RawProposal {
  studyId: string;
  alias: string;
  norm: string;
  state: AliasState;
  sources: Set<string>;
  reasons: Set<string>;
  curated: boolean;
  // true para candidatos "head/sigla" de la auditoría: una curación SEGURO los puede promover.
  overridable: boolean;
}

export function validateCurated(groups: CuratedGroup[]): string[] {
  const errors: string[] = [];
  groups.forEach((group, index) => {
    const label = `grupo #${index + 1} (${group.aliases[0] ?? "?"})`;
    if (group.aliases.length === 0) errors.push(`${label}: sin aliases`);
    if (group.status === "SEGURO" && group.targets.length !== 1) errors.push(`${label}: SEGURO exige exactamente 1 destino`);
    if (group.status === "AMBIGUO" && group.targets.length < 2) errors.push(`${label}: AMBIGUO exige 2 o más destinos`);
    if (group.status !== "SEGURO" && !group.note) errors.push(`${label}: ${group.status} exige una nota`);
    const seen = new Set<string>();
    for (const alias of group.aliases) {
      const norm = normalizeStudyKey(alias);
      if (norm === "") errors.push(`${label}: alias vacío`);
      if (seen.has(norm)) errors.push(`${label}: alias repetido "${alias}"`);
      seen.add(norm);
    }
  });
  return errors;
}

// ─────────────────────────────── motor principal ───────────────────────────────

export function buildCoverage(args: { tests: LiveTest[]; aliases: AuditAlias[]; curated?: CuratedGroup[] }): CoverageResult {
  const { tests, aliases } = args;
  const curated = args.curated ?? CURATED;
  const active = tests.filter((test) => test.active);
  const testsById = new Map(tests.map((test) => [test.id, test]));
  const activeByCode = new Map(active.filter((test) => test.code).map((test) => [test.code as string, test]));
  const curationErrors = validateCurated(curated);

  const proposals = new Map<string, RawProposal>();
  const add = (p: Omit<RawProposal, "norm" | "sources" | "reasons"> & { source: string; reason?: string }) => {
    const norm = normalizeStudyKey(p.alias);
    const key = `${p.studyId}|${norm}`;
    const existing = proposals.get(key);
    if (!existing) {
      proposals.set(key, {
        studyId: p.studyId, alias: p.alias, norm, state: p.state,
        sources: new Set([p.source]), reasons: new Set(p.reason ? [p.reason] : []),
        curated: p.curated, overridable: p.overridable
      });
      return;
    }
    existing.sources.add(p.source);
    if (p.reason) existing.reasons.add(p.reason);
    if (existing.overridable && p.curated && p.state === "SEGURO") {
      existing.state = "SEGURO";
      existing.overridable = false;
      existing.curated = true;
      existing.alias = p.alias;
      existing.reasons.clear();
      if (p.reason) existing.reasons.add(p.reason);
    } else if (p.overridable && existing.curated && existing.state === "SEGURO") {
      // la curación ya lo aprobó; el candidato derivado no lo degrada
    } else {
      existing.state = worst(existing.state, p.state);
      if (p.curated && !existing.curated) existing.alias = p.alias;
      existing.curated = existing.curated || p.curated;
      existing.overridable = existing.overridable && p.overridable;
    }
  };

  // 1) Curados
  for (const group of curated) {
    const resolved = group.targets.map((target) => {
      const test = activeByCode.get(target.code);
      if (!test) {
        curationErrors.push(`code ${target.code} (${group.aliases[0]}): no existe un estudio activo con ese code`);
        return undefined;
      }
      if (!test.normalized_name.includes(target.hint)) {
        curationErrors.push(`code ${target.code} (${group.aliases[0]}): el nombre "${test.normalized_name}" no contiene "${target.hint}"`);
        return undefined;
      }
      return test;
    });
    if (resolved.some((test) => !test)) continue;
    for (const test of resolved as LiveTest[]) {
      for (const alias of group.aliases) {
        add({ studyId: test.id, alias, state: group.status, curated: true, overridable: false, source: "curado", reason: group.note });
      }
    }
  }

  // 2) Determinísticos (auditoría + batch 1)
  const auditTests: AuditTest[] = tests.map((t) => ({ id: t.id, code: t.code, name: t.name, normalized_name: t.normalized_name, category: t.category, sample_type: t.sample_type, active: t.active }));
  const report = auditCatalog(auditTests, aliases);
  const batch1 = evaluateBatch1({ report, liveTests: tests, liveAliases: aliases });
  const batch1ByKey = new Map(batch1.map((row) => [`${row.id}|${row.normalizedAlias}`, row]));
  let batch1Evaluated = batch1.length;
  let tooLongDropped = 0;
  let tooShortDropped = 0;

  for (const study of report.studies) {
    for (const entry of study.entries) {
      if (!entry.candidate || !entry.normalizedCandidate || entry.status === "ALREADY_COVERED" || entry.status === "NO_ALIAS_NEEDED") continue;
      if (entry.candidate.length > 80) { tooLongDropped++; continue; }
      if (entry.normalizedCandidate.length < 3) { tooShortDropped++; continue; }
      if (entry.status === "SAFE_ALIAS_CANDIDATE" && entry.confidence === "high") {
        const row = batch1ByKey.get(`${study.id}|${entry.normalizedCandidate}`);
        if (row?.decision === "APPROVE") add({ studyId: study.id, alias: entry.candidate, state: "SEGURO", curated: false, overridable: false, source: "batch1", reason: "se quita solo el método analítico" });
        else add({ studyId: study.id, alias: entry.candidate, state: "REQUIERE_REVISION", curated: false, overridable: false, source: "batch1", reason: row ? row.reasons.join("; ") : "batch 1 no lo aprobó" });
      } else if (entry.status === "SAFE_ALIAS_CANDIDATE") {
        add({ studyId: study.id, alias: entry.candidate, state: "REQUIERE_REVISION", curated: false, overridable: true, source: `auditoria:${entry.generator}`, reason: "forma corta derivada de un paréntesis del nombre; verificar que sea solo una aclaración" });
      } else if (entry.status === "AMBIGUOUS") {
        add({ studyId: study.id, alias: entry.candidate, state: "AMBIGUO", curated: false, overridable: false, source: `auditoria:${entry.generator}`, reason: entry.reasons.join("; ") });
      } else if (entry.status === "COMPOSITE_POLICY_REQUIRED") {
        add({ studyId: study.id, alias: entry.candidate, state: "REQUIERE_REVISION", curated: false, overridable: false, source: `auditoria:${entry.generator}`, reason: "estudio compuesto (perfil/panel/lista): la forma corta puede representar varios estudios" });
      }
    }
  }

  // 3) Depuración: redundantes y ya existentes
  const existingByStudy = new Map<string, string[]>();
  for (const alias of aliases) existingByStudy.set(alias.lab_test_id, [...(existingByStudy.get(alias.lab_test_id) ?? []), alias.normalized_alias]);
  let redundantDropped = 0;
  let alreadyExistingDropped = 0;
  const kept: RawProposal[] = [];
  for (const proposal of proposals.values()) {
    const target = testsById.get(proposal.studyId)!;
    if (proposal.norm.length < 2) { tooShortDropped++; continue; }
    if (proposal.norm === target.normalized_name) { redundantDropped++; continue; }
    if ((existingByStudy.get(proposal.studyId) ?? []).includes(proposal.norm)) { alreadyExistingDropped++; continue; }
    kept.push(proposal);
  }

  // 4) Conflictos
  const targetsByNorm = new Map<string, Set<string>>();
  for (const proposal of kept) targetsByNorm.set(proposal.norm, new Set([...(targetsByNorm.get(proposal.norm) ?? []), proposal.studyId]));
  const nameOwners = new Map<string, LiveTest[]>();
  for (const test of active) nameOwners.set(test.normalized_name, [...(nameOwners.get(test.normalized_name) ?? []), test]);

  const final: ProposedAlias[] = kept.map((proposal) => {
    const target = testsById.get(proposal.studyId)!;
    const reasons = [...proposal.reasons];
    const conflicts: ConflictType[] = [];
    const competitors: Array<{ code: string | null; name: string }> = [];
    let state = proposal.state;
    const original = state;

    const nameClash = (nameOwners.get(proposal.norm) ?? []).filter((test) => test.id !== proposal.studyId);
    if (nameClash.length > 0) {
      conflicts.push("nombre_oficial_de_otro_estudio");
      reasons.push(`coincide con el nombre oficial de ${nameClash.map((t) => `${t.code ?? "?"} ${t.name}`).join(", ")}`);
      competitors.push(...nameClash.map((t) => ({ code: t.code, name: t.name })));
      state = "AMBIGUO";
    }
    const aliasClash = aliases.filter((alias) => alias.normalized_alias === proposal.norm && alias.lab_test_id !== proposal.studyId);
    if (aliasClash.length > 0) {
      conflicts.push("alias_existente_de_otro_estudio");
      const owners = aliasClash.map((alias) => testsById.get(alias.lab_test_id)).filter((t): t is LiveTest => Boolean(t));
      reasons.push(`ya existe como alias de ${owners.map((t) => `${t.code ?? "?"} ${t.name}`).join(", ")}`);
      competitors.push(...owners.map((t) => ({ code: t.code, name: t.name })));
      state = "AMBIGUO";
    }
    const sharing = [...(targetsByNorm.get(proposal.norm) ?? [])].filter((id) => id !== proposal.studyId);
    if (sharing.length > 0) {
      conflicts.push("alias_compartido_entre_estudios");
      const owners = sharing.map((id) => testsById.get(id)!);
      reasons.push(`la misma forma corta se propone también para ${owners.map((t) => `${t.code ?? "?"} ${t.name}`).join(", ")}`);
      competitors.push(...owners.map((t) => ({ code: t.code, name: t.name })));
      state = "AMBIGUO";
    }
    // Siempre se buscan variantes competidoras (aunque ya haya otro conflicto) para listarlas completas.
    const found = findCompetitors(proposal.norm, target, active);
    if (found.length > 0) {
      conflicts.push("variante_competidora");
      reasons.push(`otras variantes del mismo estudio contienen estas palabras: ${found.map((t) => `${t.code ?? "?"} ${t.name}`).join(", ")}`);
      competitors.push(...found.map((t) => ({ code: t.code, name: t.name })));
      state = "AMBIGUO";
    }
    return {
      studyId: proposal.studyId,
      code: target.code,
      officialName: target.name,
      alias: proposal.alias,
      normalized: proposal.norm,
      state,
      sources: [...proposal.sources].sort(),
      reasons: [...new Set(reasons)],
      competitors: [...new Map(competitors.map((c) => [`${c.code}|${c.name}`, c])).values()],
      conflicts,
      downgradedFrom: state !== original ? original : undefined
    };
  });

  // Aliases del batch 1 aprobados que esta revisión degrada
  const batch1Approved = new Set(batch1.filter((row) => row.decision === "APPROVE").map((row) => `${row.id}|${row.normalizedAlias}`));
  const batch1Downgraded = final.filter((alias) => batch1Approved.has(`${alias.studyId}|${alias.normalized}`) && alias.state !== "SEGURO").length;
  batch1Evaluated = batch1.length;

  // 5) Filas por estudio
  const byStudy = new Map<string, ProposedAlias[]>();
  for (const alias of final) byStudy.set(alias.studyId, [...(byStudy.get(alias.studyId) ?? []), alias]);
  const existingOriginal = new Map<string, string[]>();
  for (const alias of aliases) existingOriginal.set(alias.lab_test_id, [...(existingOriginal.get(alias.lab_test_id) ?? []), alias.alias]);

  const studies: StudyRow[] = active
    .map((test) => {
      const list = (byStudy.get(test.id) ?? []).sort((a, b) => RANK[a.state] - RANK[b.state] || a.alias.localeCompare(b.alias));
      let state: StudyRow["state"] = "SIN_ALIAS_NUEVO";
      for (const alias of list) state = state === "SIN_ALIAS_NUEVO" ? alias.state : worst(state, alias.state);
      const risky = list.filter((alias) => alias.state !== "SEGURO");
      const justification = risky.length > 0
        ? risky.slice(0, 3).map((alias) => `"${alias.alias}": ${alias.reasons[0] ?? alias.state}`).join(" | ")
        : list.length === 0 ? "el nombre oficial es suficiente o no hay un sinónimo seguro conocido" : "";
      return { code: test.code, id: test.id, name: test.name, category: test.category, existingAliases: existingOriginal.get(test.id) ?? [], newAliases: list, state, justification };
    })
    .sort((a, b) => Number(a.code ?? 1e9) - Number(b.code ?? 1e9));

  // 6) Estadísticas
  const byState: Record<AliasState, number> = { SEGURO: 0, AMBIGUO: 0, REQUIERE_REVISION: 0 };
  const bySource: Record<string, number> = {};
  const conflictsByType: Record<ConflictType, number> = {
    nombre_oficial_de_otro_estudio: 0, alias_existente_de_otro_estudio: 0, alias_compartido_entre_estudios: 0, variante_competidora: 0
  };
  for (const alias of final) {
    byState[alias.state]++;
    for (const source of alias.sources) bySource[source.split(":")[0]!] = (bySource[source.split(":")[0]!] ?? 0) + 1;
    for (const conflict of alias.conflicts) conflictsByType[conflict]++;
  }
  // Aliases DISTINTOS (una forma corta ambigua se repite en cada estudio candidato): estado = el más restrictivo.
  const distinct = new Map<string, AliasState>();
  for (const alias of final) distinct.set(alias.normalized, distinct.has(alias.normalized) ? worst(distinct.get(alias.normalized)!, alias.state) : alias.state);
  const distinctByState: Record<AliasState, number> = { SEGURO: 0, AMBIGUO: 0, REQUIERE_REVISION: 0 };
  for (const state of distinct.values()) distinctByState[state]++;
  const withExisting = studies.filter((s) => s.existingAliases.length > 0).length;
  const withSafe = studies.filter((s) => s.newAliases.some((a) => a.state === "SEGURO")).length;
  const withOnlyUnsafe = studies.filter((s) => s.newAliases.length > 0 && !s.newAliases.some((a) => a.state === "SEGURO")).length;
  const reachable = studies.filter((s) => s.existingAliases.length > 0 || s.newAliases.some((a) => a.state === "SEGURO")).length;

  return {
    studies,
    aliases: final,
    curationErrors,
    stats: {
      activeStudies: active.length,
      totalTests: tests.length,
      existingAliases: aliases.length,
      studiesWithExistingAlias: withExisting,
      studiesWithSafeNew: withSafe,
      studiesWithOnlyUnsafe: withOnlyUnsafe,
      studiesWithNothingNew: studies.filter((s) => s.newAliases.length === 0).length,
      studiesReachableWithSafe: reachable,
      proposedTotal: final.length,
      distinctAliases: distinct.size,
      distinctByState,
      byState,
      bySource,
      redundantDropped,
      alreadyExistingDropped,
      tooShortDropped,
      tooLongDropped,
      conflictsByType,
      conflictAliasCount: final.filter((a) => a.conflicts.length > 0).length,
      batch1Evaluated,
      batch1Downgraded
    }
  };
}

// ─────────────────────────────── verificación contra textos reales ───────────────────────────────

const toCatalog = (tests: LiveTest[], extra: Map<string, string[]>): CatalogStudy[] =>
  tests.filter((t) => t.active).map((t) => ({
    id: t.id, code: t.code, name: t.name, normalizedName: t.normalized_name,
    normalizedAliases: extra.get(t.id) ?? [], priceBs: t.price_bs ?? 0, active: true
  }));

const describeResolution = (resolution: CatalogResolution): string => {
  if (resolution.status === "MATCHED") return `MATCHED ${resolution.study.code ?? "?"} ${resolution.study.name} (${resolution.study.priceBs} Bs)`;
  if (resolution.status === "AMBIGUOUS") return `AMBIGUOUS ${resolution.candidates.map((c) => `${c.code ?? "?"} ${c.name}`).join(" | ")}`;
  return "UNMATCHED";
};

export function checkTexts(args: { tests: LiveTest[]; aliases: AuditAlias[]; coverage: CoverageResult; texts: Array<{ text: string; origin: string }> }): TextCheck[] {
  const { tests, aliases, coverage, texts } = args;
  const existing = new Map<string, string[]>();
  for (const alias of aliases) existing.set(alias.lab_test_id, [...(existing.get(alias.lab_test_id) ?? []), alias.normalized_alias]);
  const withSafe = new Map(existing);
  for (const alias of coverage.aliases) if (alias.state === "SEGURO") withSafe.set(alias.studyId, [...(withSafe.get(alias.studyId) ?? []), alias.normalized]);

  const today = new ExactAliasCatalogResolver(toCatalog(tests, existing));
  const afterSafe = new ExactAliasCatalogResolver(toCatalog(tests, withSafe));
  const observe = (text: string) => ({ text, evidenceType: "PRINTED_TEXT" as const, certainty: "HIGH" as const, evidenceSummary: "check" });
  const byNorm = new Map<string, ProposedAlias[]>();
  for (const alias of coverage.aliases) byNorm.set(alias.normalized, [...(byNorm.get(alias.normalized) ?? []), alias]);
  const activeByCode = new Map(tests.filter((t) => t.active && t.code).map((t) => [t.code as string, t]));
  const compositeByNorm = new Map<string, string>();
  for (const composite of COMPOSITES) {
    const parts = composite.components.map((c) => { const t = activeByCode.get(c.code); return `${c.code} ${t?.name ?? "?"}`; }).join(" + ");
    for (const text of composite.texts) compositeByNorm.set(normalizeStudyKey(text), `${composite.note} Componentes: ${parts}`);
  }

  const seen = new Set<string>();
  const rows: TextCheck[] = [];
  for (const item of texts) {
    const norm = normalizeStudyKey(item.text);
    if (norm === "") continue;
    if (seen.has(norm)) {
      const previous = rows.find((row) => normalizeStudyKey(row.text) === norm);
      if (previous && !previous.origin.split(" + ").includes(item.origin)) previous.origin += ` + ${item.origin}`;
      continue;
    }
    seen.add(norm);
    rows.push({
      text: item.text,
      origin: item.origin,
      today: describeResolution(today.resolve(observe(item.text))),
      withSafeAliases: describeResolution(afterSafe.resolve(observe(item.text))),
      unsafeProposals: (byNorm.get(norm) ?? []).filter((a) => a.state !== "SEGURO").map((a) => `${a.state} -> ${a.code ?? "?"} ${a.officialName}`),
      composite: compositeByNorm.get(norm)
    });
  }
  return rows;
}

// Integridad: si se insertaran TODOS los aliases SEGUROS juntos, cada uno debe resolver, de forma única, a su propio estudio.
export function verifySafeSet(args: { tests: LiveTest[]; aliases: AuditAlias[]; coverage: CoverageResult }): string[] {
  const { tests, aliases, coverage } = args;
  const withSafe = new Map<string, string[]>();
  for (const alias of aliases) withSafe.set(alias.lab_test_id, [...(withSafe.get(alias.lab_test_id) ?? []), alias.normalized_alias]);
  const safe = coverage.aliases.filter((alias) => alias.state === "SEGURO");
  for (const alias of safe) withSafe.set(alias.studyId, [...(withSafe.get(alias.studyId) ?? []), alias.normalized]);
  const resolver = new ExactAliasCatalogResolver(toCatalog(tests, withSafe));
  const violations: string[] = [];
  for (const alias of safe) {
    const resolution = resolver.resolve({ text: alias.alias, evidenceType: "PRINTED_TEXT", certainty: "HIGH", evidenceSummary: "check" });
    if (resolution.status !== "MATCHED" || resolution.study.id !== alias.studyId) {
      violations.push(`"${alias.alias}" (${alias.code}) -> ${describeResolution(resolution)}`);
    }
  }
  return violations;
}

// ─────────────────────────────── CSV ───────────────────────────────

const cell = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
const csv = (header: string[], rows: unknown[][]) => `﻿${[header.join(","), ...rows.map((row) => row.map(cell).join(","))].join("\n")}\n`;
const stateLabel = (state: string) => (state === "REQUIERE_REVISION" ? "REQUIERE_REVISIÓN" : state);

export function studiesCsv(result: CoverageResult): string {
  return csv(
    ["codigo", "uuid", "nombre_oficial", "categoria", "aliases_existentes", "aliases_nuevos_propuestos", "seguros", "ambiguos", "requieren_revision", "estado", "justificacion"],
    result.studies.map((s) => [
      s.code, s.id, s.name, s.category, s.existingAliases.join(" | "),
      s.newAliases.map((a) => `${a.alias} [${stateLabel(a.state)}]`).join(" | "),
      s.newAliases.filter((a) => a.state === "SEGURO").length,
      s.newAliases.filter((a) => a.state === "AMBIGUO").length,
      s.newAliases.filter((a) => a.state === "REQUIERE_REVISION").length,
      stateLabel(s.state), s.justification
    ])
  );
}

export function aliasesCsv(result: CoverageResult): string {
  const sorted = [...result.aliases].sort((a, b) => Number(a.code ?? 1e9) - Number(b.code ?? 1e9) || RANK[a.state] - RANK[b.state] || a.alias.localeCompare(b.alias));
  return csv(
    ["codigo", "uuid", "nombre_oficial", "alias_propuesto", "alias_normalizado", "estado", "origen", "justificacion", "compite_con", "tipo_de_conflicto"],
    sorted.map((a) => [
      a.code, a.studyId, a.officialName, a.alias, a.normalized, stateLabel(a.state), a.sources.join(" + "),
      a.reasons.join(" | "), a.competitors.map((c) => `${c.code ?? "?"} ${c.name}`).join(" | "), a.conflicts.join(" | ")
    ])
  );
}

export function checksCsv(rows: TextCheck[]): string {
  return csv(
    ["texto", "origen", "hoy", "con_aliases_seguros", "propuestas_no_seguras", "compuesto_requiere_politica"],
    rows.map((r) => [r.text, r.origin, r.today, r.withSafeAliases, r.unsafeProposals.join(" || "), r.composite ?? ""])
  );
}

// ─────────────────────────────── ejecución ───────────────────────────────

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

function recipeTexts(dir: string): Array<{ text: string; origin: string }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ text: string; origin: string }> = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".out")).sort()) {
    try {
      const raw = readFileSync(join(dir, file), "utf8");
      const json = JSON.parse(raw.slice(raw.indexOf("{"))) as { finalVisualStudies?: Array<{ literalText: string }> };
      for (const study of json.finalVisualStudies ?? []) out.push({ text: study.literalText, origin: `receta ${file.replace(/\.out$/, "")}` });
    } catch {
      // un reporte ilegible no detiene el análisis
    }
  }
  return out;
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
    getAll<LiveTest>(baseUrl, serviceKey, "lab_tests?select=id,code,name,normalized_name,category,sample_type,price_bs,active&order=id.asc"),
    getAll<AuditAlias>(baseUrl, serviceKey, "lab_test_aliases?select=id,lab_test_id,alias,normalized_alias&order=id.asc")
  ]);

  const coverage = buildCoverage({ tests, aliases });
  const texts = [...recipeTexts(join(process.cwd(), ".cache", "e2e")), ...SUS_FORM_TEXTS.map((text) => ({ text, origin: "formulario SUS D-8" }))];
  const checks = checkTexts({ tests, aliases, coverage, texts });
  const violations = verifySafeSet({ tests, aliases, coverage });

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const dir = join(process.cwd(), ".cache", "reports");
  await mkdir(dir, { recursive: true });
  const base = join(dir, `catalog-alias-coverage-${stamp}`);
  await writeFile(`${base}.estudios.csv`, studiesCsv(coverage));
  await writeFile(`${base}.aliases.csv`, aliasesCsv(coverage));
  await writeFile(`${base}.recetas.csv`, checksCsv(checks));
  await writeFile(`${base}.json`, JSON.stringify({ generatedAt: new Date().toISOString(), stats: coverage.stats, curationErrors: coverage.curationErrors }, null, 2));

  const s = coverage.stats;
  const pct = (n: number) => `${((n / s.activeStudies) * 100).toFixed(1)}%`;
  console.log("COBERTURA DE ALIASES (solo lectura; nada se escribió en Supabase)\n");
  console.log(`Estudios activos: ${s.activeStudies} (de ${s.totalTests}) | aliases existentes: ${s.existingAliases} en ${s.studiesWithExistingAlias} estudios`);
  console.log(`Aliases nuevos propuestos: ${s.distinctAliases} formas distintas = ${s.proposedTotal} filas alias→estudio (una forma ambigua se repite en cada estudio candidato)`);
  console.log(`  formas distintas: SEGURO ${s.distinctByState.SEGURO} | REQUIERE_REVISIÓN ${s.distinctByState.REQUIERE_REVISION} | AMBIGUO ${s.distinctByState.AMBIGUO}`);
  console.log(`  filas alias→estudio: SEGURO ${s.byState.SEGURO} | REQUIERE_REVISIÓN ${s.byState.REQUIERE_REVISION} | AMBIGUO ${s.byState.AMBIGUO}`);
  console.log(`  por origen: ${Object.entries(s.bySource).map(([k, v]) => `${k} ${v}`).join(" | ")}`);
  console.log(`  descartados: redundantes ${s.redundantDropped} | ya existentes ${s.alreadyExistingDropped} | muy cortos ${s.tooShortDropped} | muy largos ${s.tooLongDropped}`);
  console.log(`Cobertura sobre ${s.activeStudies} estudios:`);
  console.log(`  alcanzables hoy por alias existente o SEGURO nuevo: ${s.studiesReachableWithSafe} (${pct(s.studiesReachableWithSafe)})  [hoy solo con alias existente: ${s.studiesWithExistingAlias}]`);
  console.log(`  con al menos 1 alias SEGURO nuevo: ${s.studiesWithSafeNew} (${pct(s.studiesWithSafeNew)})`);
  console.log(`  solo con propuestas REQUIERE_REVISIÓN/AMBIGUO: ${s.studiesWithOnlyUnsafe} (${pct(s.studiesWithOnlyUnsafe)})`);
  console.log(`  sin propuesta nueva (basta el nombre oficial): ${s.studiesWithNothingNew} (${pct(s.studiesWithNothingNew)})`);
  console.log(`Conflictos: ${s.conflictAliasCount} aliases en conflicto`);
  for (const [type, count] of Object.entries(s.conflictsByType)) console.log(`  ${type}: ${count}`);
  console.log(`  aliases del batch 1 aprobados que esta revisión degrada: ${s.batch1Downgraded} de ${s.batch1Evaluated} evaluados`);
  console.log(`\nIntegridad del conjunto SEGURO (insertar los ${s.byState.SEGURO} juntos): ${violations.length === 0 ? "OK, cada alias resuelve de forma única a su estudio" : `${violations.length} VIOLACIONES`}`);
  for (const violation of violations.slice(0, 15)) console.log(`  - ${violation}`);
  if (coverage.curationErrors.length > 0) {
    console.log(`\nERRORES DE CURACIÓN (${coverage.curationErrors.length}):`);
    for (const error of coverage.curationErrors) console.log(`  - ${error}`);
  }
  const recipeRows = checks.filter((row) => row.origin.startsWith("receta"));
  const resolved = (row: TextCheck) => row.withSafeAliases.startsWith("MATCHED");
  console.log(`\nTextos de las 5 recetas reales: ${recipeRows.length} distintos | resueltos hoy: ${recipeRows.filter((r) => r.today.startsWith("MATCHED")).length} | con aliases SEGUROS: ${recipeRows.filter(resolved).length}`);
  const formRows = checks.filter((row) => row.origin.includes("formulario"));
  console.log(`Ítems del formulario SUS D-8: ${formRows.length} | resueltos hoy: ${formRows.filter((r) => r.today.startsWith("MATCHED")).length} | con aliases SEGUROS: ${formRows.filter(resolved).length} | compuestos: ${formRows.filter((r) => r.composite).length}`);
  console.log(`\nArchivos:\n  ${base}.estudios.csv\n  ${base}.aliases.csv\n  ${base}.recetas.csv\n  ${base}.json`);
  if (coverage.curationErrors.length > 0 || violations.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`ERROR: ${(error as Error).message}`);
    process.exit(1);
  }
}
