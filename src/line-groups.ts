import { approvedPackage, headWords, identityTokens, isQualifierOnly, itemKey, packageItems, qualifiersOf, studyQualifiers, unresolvedPackageGroups } from "./catalog-shadow.js";
import { normalizeVisibleKey, sameVisibleText, type SimpleStudy } from "./consensus.js";
import type { FinalVisualStudy } from "./analyze.js";
import type { CatalogStudy } from "./types.js";

// AGRUPACIÓN POR LÍNEA. Los lectores devuelven cada estudio como una fila, pero una línea como "Gasometría + Lactato" o "TGO / TGP" puede ser UNA
// expresión (p. ej. el nombre aprobado de un paquete) que al separarse pierde su identidad. `lineText` conserva el texto completo de la línea y,
// con él, la agrupación original. Solo se usa cuando las DOS lecturas coinciden en él; si no coinciden o falta, el sistema se comporta como siempre.
//
//  - Paquete por identidad explícita: si el texto de la línea ES el nombre o alias aprobado de un paquete y los estudios leídos cubren EXACTAMENTE
//    sus componentes, la línea se trata como ese paquete (un solo estudio con el texto de la línea). Nada se reemplaza por aproximación.
//  - Si la línea es un paquete aprobado pero las filas no lo reconstruyen sin ambigüedad (faltan componentes, sobran estudios), el grupo queda
//    pendiente: nunca se cobran componentes ni se inventa el paquete.
//  - Estudios pedidos en líneas SEPARADAS no se tratan como el paquete: no hay motivo para retenerlos aunque juntos formen uno.

export const lineKeyOf = (text: string): string => normalizeVisibleKey(text);

// El lineText fiable de una pareja de lecturas: ambas lo traen y coinciden (ignorando espaciado, mayúsculas y puntuación). Si una lectura trae una
// versión más corta o distinta NO se completa con la otra (una línea cortada y un estudio de otra línea no se distinguen): se ignora.
export function reliableLineText(a?: SimpleStudy, b?: SimpleStudy): string | undefined {
  const first = a?.lineText?.trim();
  const second = b?.lineText?.trim();
  if (!first || !second) return undefined;
  const x = lineKeyOf(first);
  const y = lineKeyOf(second);
  if (x === "" || y === "") return undefined;
  return x === y ? first : undefined;
}

const SEPARATORS = /\s*(?:\+|\/|;)\s*/;

function tokensOf(text: string): string[] {
  return itemKey(text).split(" ").filter(Boolean);
}

// Las filas de una línea que es un paquete aprobado, si lo reconstruyen EXACTAMENTE (un estudio por componente y ninguno de más).
function rowsCoverPackage(pkg: CatalogStudy, rows: FinalVisualStudy[]): boolean {
  const items = packageItems(pkg);
  if (items.length < 2 || rows.length !== items.length) return false;
  const unused = new Set(rows);
  for (const item of items) {
    const key = itemKey(item);
    const hit = [...unused].find((row) => itemKey(row.literalText) === key);
    if (!hit) return false;
    unused.delete(hit);
  }
  return unused.size === 0;
}

// Una fila cuyo texto es SOLO una variante ("IgG", "libre") no identifica un estudio. Hereda el analito de las filas DONANTES de su misma línea
// ("Anticardiolipina IgM" + "IgG" -> "Anticardiolipina IgG") solo si TODO esto es cierto; ante cualquier duda la fila queda como estaba (sin identificar,
// pendiente de revisión humana) y nunca se cotiza:
//  1. La línea es fiable (las dos lecturas coinciden en ella) y la comparten la fila suelta y los donantes.
//  2. Los donantes nombran todos el MISMO analito, y la línea nombra exactamente UN analito que coincide con el del donante. Una línea con dos analitos
//     ("Zetaina, Gamaina IgG") no permite saber a cuál pertenece la variante suelta.
//  3. La variante de la fila aparece en la línea y el resultado no repite el texto de otra fila.
// Las marcas y signos de la línea (X, cruces, rayas, subrayados...) no se interpretan ni impiden por sí solos heredar: son la forma habitual de pedir un estudio.
// Las palabras de negación o condición ("sin", "no", "excepto", "tachado"...) sí impiden el punto 2 porque no son parte del analito.
// Sin donante NO se hereda de la propia línea: una variante suelta sin ninguna fila que nombre el analito sigue sin identificar. El matching y la verificación
// de identidad se aplican igual al texto resultante: heredar solo reconstruye el texto de la fila, no decide qué estudio es.
// Separadores de una enumeración: comas, punto y coma, "/", saltos de línea y conjunciones (cualquier otra palabra se queda dentro del mismo trozo).
const LIST_SPLIT = /\s*[,;/\n]\s*|\s+(?:y|e|o|u|and|con|más|mas)\s+/i;

// El analito de una línea si nombra exactamente UNO: separando la enumeración (comas, ";", "/", "y", "o"...), un solo trozo conserva palabras que no son variantes.
export function lineAnalyte(lineText: string): string | undefined {
  const parts = lineText.split(LIST_SPLIT).map((part) => headWords(part)).filter((part) => part !== "");
  return parts.length === 1 ? parts[0] : undefined;
}

const variantsIn = (text: string): Set<string> => new Set(identityTokens(text));

export function inheritAnalyteFromLine(studies: FinalVisualStudy[]): FinalVisualStudy[] {
  const groups = new Map<string, FinalVisualStudy[]>();
  for (const study of studies) if (study.lineText) groups.set(lineKeyOf(study.lineText), [...(groups.get(lineKeyOf(study.lineText)) ?? []), study]);
  const replaced = new Map<FinalVisualStudy, FinalVisualStudy>();
  for (const rows of groups.values()) {
    if (!rows.some((row) => isQualifierOnly(row.literalText))) continue;
    const heads = new Set(rows.filter((row) => !isQualifierOnly(row.literalText) && headWords(row.literalText) !== "").map((row) => headWords(row.literalText)));
    if (heads.size !== 1) continue;
    const head = [...heads][0]!;
    if (lineAnalyte(rows[0]!.lineText!) !== head) continue;
    const inLine = variantsIn(rows[0]!.lineText!);
    for (const row of rows) {
      if (!isQualifierOnly(row.literalText)) continue;
      if (!identityTokens(row.literalText).every((token) => inLine.has(token))) continue;
      const literalText = `${head} ${row.literalText}`.trim();
      const clash = studies.some((other) => other !== row && sameVisibleText(other.literalText, literalText));
      if (clash) continue;
      replaced.set(row, { ...row, literalText, normalizedName: `${head} ${row.normalizedName}`.trim(), inheritedFrom: row.literalText });
    }
  }
  return studies.map((study) => replaced.get(study) ?? study);
}

export function collapseExplicitPackages(studies: FinalVisualStudy[], catalog: CatalogStudy[]): FinalVisualStudy[] {
  const groups = new Map<string, FinalVisualStudy[]>();
  for (const study of studies) {
    if (!study.lineText) continue;
    const key = lineKeyOf(study.lineText);
    groups.set(key, [...(groups.get(key) ?? []), study]);
  }
  const replaced = new Map<FinalVisualStudy, FinalVisualStudy | null>();
  for (const rows of groups.values()) {
    const lineText = rows[0]!.lineText!;
    // Una sola fila cuyo texto ya ES la línea no necesita reconstrucción (el matcher ya ve el nombre completo).
    if (rows.length === 1 && lineKeyOf(rows[0]!.literalText) === lineKeyOf(lineText)) continue;
    const pkg = approvedPackage(lineText, catalog);
    if (!pkg) continue;
    // Una línea que es un estudio simple (no un paquete) solo es problema si fue separada en varias filas (p. ej. un cociente "A / B").
    if (packageItems(pkg).length < 2 && rows.length < 2) continue;
    if (rowsCoverPackage(pkg, rows)) {
      const rank = { low: 1, medium: 2, high: 3 } as const;
      const weakest = rows.reduce((worst, row) => (rank[row.confidence] < rank[worst.confidence] ? row : worst), rows[0]!);
      const collapsed: FinalVisualStudy = {
        ...rows[0]!,
        literalText: lineText,
        normalizedName: lineText,
        confidence: weakest.confidence,
        collapsedFrom: rows.map((row) => row.literalText)
      };
      rows.forEach((row, index) => replaced.set(row, index === 0 ? collapsed : null));
    } else {
      const problem = `la línea «${lineText}» es el estudio aprobado «${pkg.name}», pero las filas leídas (${rows.map((row) => row.literalText).join(" | ")}) no lo reconstruyen sin ambigüedad`;
      rows.forEach((row) => replaced.set(row, { ...row, lineProblem: problem }));
    }
  }
  return studies.flatMap((study) => {
    if (!replaced.has(study)) return [study];
    const out = replaced.get(study);
    return out ? [out] : [];
  });
}

// Servicios que la línea pide (antibiograma/ATB) y que ni el texto del estudio ni el estudio elegido cubren.
export function lineServiceGap(source: FinalVisualStudy, chosen: CatalogStudy[]): string[] {
  if (!source.lineText) return [];
  const wanted = qualifiersOf(identityTokens(source.lineText)).servicio;
  if (wanted.size === 0) return [];
  const covered = new Set<string>([
    ...qualifiersOf(identityTokens(source.literalText)).servicio,
    ...chosen.flatMap((study) => [...studyQualifiers(study).servicio, ...study.normalizedAliases.flatMap((alias) => [...qualifiersOf(identityTokens(alias)).servicio])])
  ]);
  return [...wanted].filter((service) => !covered.has(service));
}

// Elementos de una línea con "+", "/" o ";" que ninguna fila de esa línea representa (el lector dejó fuera algo que SÍ está escrito).
export interface DroppedLineItem { item: string; lineText: string; message: string }

export function droppedLineItemDetails(studies: FinalVisualStudy[]): DroppedLineItem[] {
  const groups = new Map<string, FinalVisualStudy[]>();
  for (const study of studies) {
    if (study.lineText) groups.set(lineKeyOf(study.lineText), [...(groups.get(lineKeyOf(study.lineText)) ?? []), study]);
  }
  const out: DroppedLineItem[] = [];
  for (const rows of groups.values()) {
    const lineText = rows[0]!.lineText!;
    const items = lineText.split(SEPARATORS).map((item) => item.trim()).filter(Boolean);
    if (items.length < 2) continue;
    const represented = new Set(rows.flatMap((row) => tokensOf(row.collapsedFrom ? row.collapsedFrom.join(" ") : row.literalText)));
    for (const item of items) {
      const tokens = tokensOf(item);
      if (tokens.length > 0 && !tokens.every((token) => represented.has(token))) out.push({ item, lineText, message: `la línea «${lineText}» menciona «${item}» y ninguna fila de esa línea lo representa` });
    }
  }
  return [...new Map(out.map((entry) => [entry.message, entry])).values()];
}

export const droppedLineItems = (studies: FinalVisualStudy[]): string[] => droppedLineItemDetails(studies).map((entry) => entry.message);

const singleItem = (lineText: string): boolean => lineText.split(/\s*(?:\+|\/|;|,)\s*|\s+y\s+/i).filter(Boolean).length <= 1;

// ¿Cada componente se pidió en SU PROPIA línea (distinta de la de los otros y sin lista)? Entonces son estudios pedidos por separado.
export function separatelyRequested(parts: FinalVisualStudy[][]): boolean {
  const lines = new Set<string>();
  for (const sources of parts) {
    if (sources.length === 0) return false;
    for (const source of sources) {
      if (!source.lineText || !singleItem(source.lineText)) return false;
      if (source.lineProblem) return false;
    }
    const keys = new Set(sources.map((source) => lineKeyOf(source.lineText!)));
    if (keys.size !== 1) return false;
    const key = [...keys][0]!;
    if (lines.has(key)) return false;
    lines.add(key);
  }
  return true;
}

// Grupos de paquete sin resolver, descontando los que se pidieron claramente por separado (cada componente en su propia línea).
export function heldPackageGroups(pairs: Array<{ study: CatalogStudy; source: FinalVisualStudy }>, catalog: CatalogStudy[]): Array<{ pkg: CatalogStudy; parts: CatalogStudy[] }> {
  const selected = [...new Map(pairs.map((pair) => [pair.study.id, pair.study])).values()];
  return unresolvedPackageGroups(selected, catalog).filter((group) => {
    const sources = group.parts.map((part) => pairs.filter((pair) => pair.study.id === part.id).map((pair) => pair.source));
    return !separatelyRequested(sources);
  });
}
