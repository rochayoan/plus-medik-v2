import { plain } from "./text-normalize.js";

// Errores de tipeo: letras cambiadas de lugar («hgc» por «hcg»), una letra de más, de menos o equivocada. Determinista y sin red.

// Distancia de edición en la que cambiar de lugar dos letras vecinas cuenta como UN error (en la distancia clásica cuenta como dos: «hgc» quedaba a 2 de «hcg» y no se reconocía).
export function typoDistance(a: string, b: string): number {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, d[i - 2]![j - 2]! + 1);
      d[i]![j] = value;
    }
  }
  return d[a.length]![b.length]!;
}

// ¿Es `written` una errata de `known`? Las palabras cortas (siglas como HCG, HIV, TSH) solo admiten letras cambiadas de lugar o una letra de más o de menos: cambiar una letra por otra en una sigla da OTRO
// estudio («hcv» no es «hiv»). Desde 5 letras se admite un error de cualquier tipo, y desde 8, dos.
export function isTypoOf(written: string, known: string): boolean {
  if (written === known) return false;
  const shortest = Math.min(written.length, known.length);
  if (shortest < 3 || Math.abs(written.length - known.length) > 2) return false;
  const distance = typoDistance(written, known);
  if (shortest <= 4) {
    if (distance !== 1) return false;
    // Misma longitud con un error: solo vale si son las mismas letras (intercambio), no una letra por otra.
    return written.length !== known.length || [...written].sort().join("") === [...known].sort().join("");
  }
  return distance <= (shortest >= 8 ? 2 : 1);
}

// El paciente pide COTIZAR aunque lo escriba mal: «cotozame», «cotisame», «kotizame», «cotizane», «coitzame», «coticen». Se compara el comienzo de cada palabra con «cotiza» (un error como máximo).
// «cotidiano», «cocina», «costo» o «cortina» quedan lejos (dos errores o más).
const QUOTE_STEM = "cotiza";
export function mentionsQuoting(text: string): boolean {
  return plain(text.slice(0, 1000))
    .split(" ")
    .some((word) => word.length >= QUOTE_STEM.length && /^[a-zñ]+$/.test(word) && (/^coti[zc]/.test(word) || typoDistance(word.slice(0, QUOTE_STEM.length), QUOTE_STEM) <= 1));
}
