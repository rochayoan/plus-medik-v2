// FASE 2D.1 — Tabla de aprobación del batch 1 de aliases (candidatos SAFE + high de la auditoría).
// SOLO LECTURA: lee el reporte local y hace GET a Supabase (para price_bs y verificación). No inserta nada.
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  METHOD_TOKENS,
  VARIANT_TOKENS,
  isVariantRemainder,
  parenGroups,
  startsWithTokens,
  tokensOf,
  type AuditAlias,
  type AuditResult
} from "./audit-catalog-aliases.js";
import { normalizeStudyKey } from "../src/consensus.js";

export const AUDIT_REPORT_PATH = ".cache/reports/catalog-alias-audit-20261018-081809.json";

export interface LiveTest {
  id: string;
  code: string | null;
  name: string;
  normalized_name: string;
  category: string | null;
  sample_type: string | null;
  price_bs: number | null;
  active: boolean;
}

export type Decision = "APPROVE" | "REVIEW_REQUIRED";

export interface RelatedStudy {
  code: string | null;
  id: string;
  name: string;
  relation: string;
}

export interface ApprovalRow {
  code: string | null;
  id: string;
  officialName: string;
  proposedAlias: string;
  normalizedAlias: string;
  removed: string;
  category: string | null;
  sampleType: string | null;
  priceBs: number | null;
  relatedActive: RelatedStudy[];
  currentAliases: string[];
  decision: Decision;
  reasons: string[];
}

// Lista ESTRICTA de métodos analíticos que APPROVE permite quitar. Cualquier otro paréntesis -> REVIEW_REQUIRED.
const STRICT_METHOD_GROUPS = new Set(["eclia", "elisa", "fia", "clia", "fia fluorescencia", "fia inmunofluorescencia"]);

const groupKey = (content: string) => normalizeStudyKey(content);

// Clave "sin método" de un estudio: quita paréntesis que sean solo método (lista amplia) para detectar otras variantes de método.
function methodFreeKey(name: string): string {
  let text = name;
  for (const group of [...parenGroups(name)].reverse()) {
    const tokens = tokensOf(group.content);
    if (tokens.length > 0 && tokens.every((token) => METHOD_TOKENS.has(token))) {
      text = text.slice(0, group.start) + text.slice(group.end);
    }
  }
  return normalizeStudyKey(text);
}

export interface Batch1Input {
  report: Pick<AuditResult, "studies">;
  liveTests: LiveTest[];
  liveAliases: AuditAlias[];
}

export function evaluateBatch1({ report, liveTests, liveAliases }: Batch1Input): ApprovalRow[] {
  const liveById = new Map(liveTests.map((test) => [test.id, test]));
  const activeTests = liveTests.filter((test) => test.active);

  const candidates = report.studies.flatMap((study) =>
    study.entries
      .filter((entry) => entry.status === "SAFE_ALIAS_CANDIDATE" && entry.confidence === "high")
      .map((entry) => ({ study, entry }))
  );

  const aliasCount = new Map<string, number>();
  for (const { entry } of candidates) aliasCount.set(entry.normalizedCandidate!, (aliasCount.get(entry.normalizedCandidate!) ?? 0) + 1);

  return candidates.map(({ study, entry }) => {
    const reasons: string[] = [];
    const normalizedAlias = entry.normalizedCandidate!;
    const aliasTokens = normalizedAlias.split(" ");
    const live = liveById.get(study.id);

    // 1) Los datos en vivo siguen siendo los del reporte.
    if (!live) reasons.push("el UUID ya no existe en lab_tests");
    else {
      if (!live.active) reasons.push("el estudio ya no está activo");
      if (live.name !== study.name || live.normalized_name !== study.normalizedName) reasons.push("el nombre cambió desde que se generó la auditoría");
    }

    // 2) El único cambio es quitar paréntesis de método de la lista estricta.
    const groups = parenGroups(study.name);
    const methodGroups = groups.filter((group) => STRICT_METHOD_GROUPS.has(groupKey(group.content)));
    const otherGroups = groups.filter((group) => !STRICT_METHOD_GROUPS.has(groupKey(group.content)));
    let rebuilt = study.name;
    for (const group of [...methodGroups].reverse()) rebuilt = rebuilt.slice(0, group.start) + rebuilt.slice(group.end);
    rebuilt = normalizeStudyKey(rebuilt);
    const removed = methodGroups.map((group) => `(${group.content.trim()})`).join(" ");

    if (methodGroups.length === 0) reasons.push("no se quita ningún método de la lista estricta (ECLIA, ELISA, FIA, CLIA)");
    if (rebuilt !== normalizedAlias) {
      reasons.push(`el alias no es exactamente el nombre menos el método (reconstruido: "${rebuilt}", propuesto: "${normalizedAlias}")`);
    }
    const removedTokens = methodGroups.flatMap((group) => tokensOf(group.content));
    if (removedTokens.some((token) => VARIANT_TOKENS.has(token) || /cuantit|cualit|rapid|neonat|libre|total/.test(token))) {
      reasons.push("lo removido incluye un calificador, no solo método");
    }
    if (methodGroups.length > 1) reasons.push("se quitan varios paréntesis a la vez");
    if (study.composite) reasons.push("estudio compuesto (perfil/panel/lista de componentes)");
    // Un paréntesis no-método que permanece en el alias es válido; solo se anota.

    // 3) Colisiones con otros UUID (activos o inactivos) por normalized_name o alias.
    for (const other of liveTests) {
      if (other.id === study.id) continue;
      if (other.normalized_name === normalizedAlias) {
        reasons.push(`coincide con el normalized_name de otro UUID${other.active ? "" : " (inactivo)"}: ${other.code ?? "?"} ${other.name}`);
      }
    }
    for (const alias of liveAliases) {
      if (alias.normalized_alias === normalizedAlias) {
        reasons.push(alias.lab_test_id === study.id ? "ya existe como alias de este mismo UUID" : `ya existe como alias de otro UUID (${alias.lab_test_id})`);
      }
    }
    if ((aliasCount.get(normalizedAlias) ?? 0) > 1) reasons.push("el mismo alias sale de más de un estudio del batch");

    // 4) Otros estudios activos relacionados por raíz y variantes.
    const related: RelatedStudy[] = [];
    for (const other of activeTests) {
      if (other.id === study.id) continue;
      const otherTokens = other.normalized_name.split(" ");
      let relation: string | undefined;

      if (methodFreeKey(other.name) === normalizedAlias) {
        relation = "misma forma sin método (variante de método)";
        reasons.push(`existe otra variante con la misma forma sin método: ${other.code ?? "?"} ${other.name}`);
      } else if (startsWithTokens(otherTokens, aliasTokens)) {
        const rest = otherTokens.slice(aliasTokens.length);
        if (isVariantRemainder(rest)) {
          relation = "variante (método/isotipo/población/muestra/formato)";
          reasons.push(`existe una variante activa: ${other.code ?? "?"} ${other.name}`);
        } else {
          // El alias es un prefijo propio del nombre de otro estudio activo (p. ej. "BETA HCG-CUANTITATIVA" vs "... - VARON"):
          // podría leerse como forma genérica de varios estudios. Ante la duda, revisión humana.
          relation = "el alias es prefijo del nombre de este estudio";
          reasons.push(`el alias es prefijo del nombre de otro estudio activo (posible forma genérica / variante por población): ${other.code ?? "?"} ${other.name}`);
        }
      } else if (startsWithTokens(aliasTokens, otherTokens)) {
        relation = "su nombre es raíz del alias";
      }
      if (relation) related.push({ code: other.code, id: other.id, name: other.name, relation });
    }

    return {
      code: study.code,
      id: study.id,
      officialName: study.name,
      proposedAlias: entry.candidate!,
      normalizedAlias,
      removed,
      category: live?.category ?? study.category,
      sampleType: live?.sample_type ?? study.sampleType,
      priceBs: live?.price_bs ?? null,
      relatedActive: related,
      currentAliases: liveAliases.filter((alias) => alias.lab_test_id === study.id).map((alias) => alias.alias),
      decision: reasons.length === 0 ? "APPROVE" : "REVIEW_REQUIRED",
      reasons: [...new Set(reasons)]
    };
  });
}

const csvCell = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;

export function approvalToCsv(rows: ApprovalRow[]): string {
  const header = ["decision", "code", "id", "official_name", "proposed_alias", "normalized_alias", "removed", "category", "sample_type", "price_bs", "related_active_studies", "current_aliases", "reasons"];
  const lines = rows.map((row) =>
    [
      row.decision, row.code, row.id, row.officialName, row.proposedAlias, row.normalizedAlias, row.removed,
      row.category, row.sampleType, row.priceBs,
      row.relatedActive.map((r) => `${r.code ?? "?"} ${r.name} [${r.relation}]`).join(" | "),
      row.currentAliases.join(" | "),
      row.reasons.join(" | ")
    ].map(csvCell).join(",")
  );
  return `﻿${[header.join(","), ...lines].join("\n")}\n`;
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

  const report = JSON.parse(readFileSync(AUDIT_REPORT_PATH, "utf8")) as AuditResult;
  const [liveTests, liveAliases] = await Promise.all([
    getAll<LiveTest>(baseUrl, serviceKey, "lab_tests?select=id,code,name,normalized_name,category,sample_type,price_bs,active&order=id.asc"),
    getAll<AuditAlias>(baseUrl, serviceKey, "lab_test_aliases?select=id,lab_test_id,alias,normalized_alias&order=id.asc")
  ]);

  const rows = evaluateBatch1({ report, liveTests, liveAliases });
  rows.sort((a, b) => Number(a.code ?? 1e9) - Number(b.code ?? 1e9));

  const dir = join(process.cwd(), ".cache", "reports");
  await mkdir(dir, { recursive: true });
  const approved = rows.filter((row) => row.decision === "APPROVE");
  const review = rows.filter((row) => row.decision === "REVIEW_REQUIRED");
  await writeFile(
    join(dir, "catalog-alias-batch1-approval.json"),
    JSON.stringify({ sourceReport: AUDIT_REPORT_PATH, generatedAt: new Date().toISOString(), summary: { evaluated: rows.length, approve: approved.length, reviewRequired: review.length }, rows }, null, 2)
  );
  await writeFile(join(dir, "catalog-alias-batch1-approval.csv"), approvalToCsv(rows));

  console.log(`Total evaluados: ${rows.length}`);
  console.log(`APPROVE: ${approved.length}`);
  console.log(`REVIEW_REQUIRED: ${review.length}`);
  console.log(`\nAPPROVE (${approved.length}):`);
  for (const row of approved) console.log(`  ${row.code ?? "-"} | ${row.proposedAlias} -> ${row.officialName}`);
  console.log(`\nREVIEW_REQUIRED (${review.length}):`);
  for (const row of review) console.log(`  ${row.code ?? "-"} | ${row.proposedAlias} -> ${row.officialName}\n      razón: ${row.reasons.join(" ; ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`ERROR: ${(error as Error).message}`);
    process.exit(1);
  }
}
