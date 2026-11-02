// Algunos nombres traen el título en MAYÚSCULAS seguido del desglose de lo que incluye
// ("10 GENES DE RESISTENCIA A ANTIBIOTICOS Nueva Delhi metalo-b-lactamasa (NDM), ...").
// El título es el tramo inicial sin minúsculas; el desglose empieza en la primera palabra con minúsculas.
export function splitStudyName(name: string): { title: string; detail: string | null } {
  const words = name.trim().split(/\s+/);
  const end = words.findIndex((word) => /\p{Ll}/u.test(word));
  if (end < 1) return { title: name.trim(), detail: null };
  const detail = words.slice(end).join(" ");
  // Un resto corto es parte del nombre (ej. "HEMOGRAMA completo"), no un desglose.
  return detail.length >= 20 ? { title: words.slice(0, end).join(" "), detail } : { title: name.trim(), detail: null };
}
