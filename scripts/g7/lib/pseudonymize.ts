// G7 · Fase 0 — Seudonimización LOCAL de texto de pacientes. Funciones puras (sin red ni disco). Nada de lo que entra o sale de aquí se registra.
//
// Qué se oculta: teléfonos, correos, enlaces, identificadores de WhatsApp (wamid), números de documento/CI, fechas de nacimiento, números largos y nombres propios (heurística).
// Qué se CONSERVA a propósito: el contenido clínico y de estudios (necesario para evaluar la comprensión), cantidades pequeñas, horas y días de la semana.
// La heurística de nombres NO es perfecta: el informe de la preparación cuenta los textos con posible nombre residual para revisarlos a mano antes de usar el corpus.

export interface PseudoStats {
  phones: number;
  emails: number;
  urls: number;
  wamids: number;
  documents: number;
  dates: number;
  longNumbers: number;
  names: number;
}
export const emptyStats = (): PseudoStats => ({ phones: 0, emails: 0, urls: 0, wamids: 0, documents: 0, dates: 0, longNumbers: 0, names: 0 });

// Palabras con mayúscula inicial que NO son nombres de persona en este dominio (inicio de oración, estudios, lugares, marcas).
const NOT_NAMES = new Set([
  "hola", "buenas", "buenos", "buen", "dias", "dia", "tardes", "noches", "gracias", "si", "no", "ok", "listo", "claro", "por", "favor", "quiero", "necesito", "quisiera", "tengo", "me", "mi", "el", "la", "los", "las", "un", "una", "que", "como", "cuando", "donde", "cuanto", "cual", "cuales", "para", "con", "sin", "hay", "es", "son", "estoy", "puedo", "puede", "pueden", "tienen", "tiene", "atienden", "abren", "cotizar", "cotizacion", "receta", "estudio", "estudios", "analisis", "examen", "examenes", "laboratorio", "plusmedik", "santa", "cruz", "sierra", "bolivia",
  "hemograma", "glucosa", "colesterol", "trigliceridos", "creatinina", "urea", "tsh", "t3", "t4", "psa", "vih", "orina", "heces", "perfil", "lipidico", "hepatico", "tiroideo", "completo", "general", "sangre", "hemoglobina", "glicosilada", "acido", "urico", "pcr", "vsg", "ferritina", "hierro", "vitamina", "calcio", "sodio", "potasio", "bilirrubina", "transaminasas", "got", "gpt", "tgo", "tgp", "covid", "dengue", "chagas", "hepatitis", "embarazo",
  "lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo", "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre", "bs", "doctor", "doctora", "dr", "dra", "sr", "sra", "senor", "senora", "buenas", "tarde", "noche", "mañana", "hoy", "ayer", "ahora", "ya", "pero", "porque", "entonces", "tambien", "ademas", "aqui", "alla", "asi", "bien", "mal", "muchas", "mucho", "mil", "todo", "todos", "nada", "algo", "otro", "otra", "otros", "este", "esta", "esto", "ese", "esa", "eso", "mis", "tu", "tus", "su", "sus", "te", "se", "lo", "le", "les", "nos", "al", "del", "de", "en", "y", "o", "a"
]);
const strip = (word: string) => word.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Disparadores de un nombre propio: «me llamo X», «soy X», «mi nombre es X», «a nombre de X», «paciente X», «Sr./Sra./Dr./Dra. X», «para X» no (demasiado ambiguo).
const NAME_TRIGGER = /\b(me llamo|mi nombre es|mi nombre completo es|a nombre de|soy|paciente|señor|señora|sr\.?|sra\.?|dr\.?|dra\.?|doctor|doctora|lic\.?|licenciado|licenciada)\s+((?:[A-ZÁÉÍÓÚÑ][\p{L}'-]+)(?:\s+(?:de|del|la|los)?\s*[A-ZÁÉÍÓÚÑ][\p{L}'-]+){0,3})/gu;

export interface Pseudonymizer {
  text(input: string): string;
  phone(raw: string | null | undefined): string;
  contact(contactKey: string): string;
  // Tabla de equivalencias (dato real → seudónimo). Es la parte sensible: se guarda aparte y nunca junto al corpus.
  equivalences(): { phones: Record<string, string>; contacts: Record<string, string> };
  stats: PseudoStats;
}

// Los seudónimos (teléfono → P###, contacto → C###) son contadores por orden de aparición: no se derivan del dato, así que no son reversibles sin la tabla de equivalencias, que el CLI guarda aparte (0600).
export function createPseudonymizer(): Pseudonymizer {
  const stats = emptyStats();
  const phoneMap = new Map<string, string>();
  const contactMap = new Map<string, string>();
  const tag = (value: string, map: Map<string, string>, prefix: string) => {
    const existing = map.get(value);
    if (existing) return existing;
    const label = `${prefix}${String(map.size + 1).padStart(3, "0")}`;
    map.set(value, label);
    return label;
  };
  return {
    stats,
    phone: (raw) => (raw ? tag(raw.replace(/\D/g, ""), phoneMap, "P") : "P000"),
    contact: (key) => tag(key, contactMap, "C"),
    equivalences: () => ({ phones: Object.fromEntries(phoneMap), contacts: Object.fromEntries(contactMap) }),
    text(input) {
      let value = input;
      const count = (key: keyof PseudoStats, pattern: RegExp, replacement: string | ((match: string, ...groups: string[]) => string)) => {
        value = value.replace(pattern, (...args) => {
          stats[key]++;
          return typeof replacement === "function" ? replacement(args[0] as string, ...(args.slice(1) as string[])) : replacement;
        });
      };
      count("wamids", /\bwamid\.[A-Za-z0-9+/=_-]{10,}/g, "[ID_MENSAJE]");
      count("urls", /https?:\/\/\S+|www\.\S+/gi, "[ENLACE]");
      count("emails", /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[CORREO]");
      // Fechas de nacimiento / fechas con año: 12/03/1985, 12-03-85, 1985-03-12
      count("dates", /\b(?:\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})|\d{4}-\d{2}-\d{2})\b/g, "[FECHA]");
      // Teléfonos: con prefijo de país o de 7+ dígitos (se admiten espacios y guiones)
      count("phones", /(?<!\d)(?:\+?591[\s-]?)?[67]\d{7}(?!\d)|\+\d[\d\s().-]{7,}\d/g, "[TELEFONO]");
      // Documento (CI): 5-9 dígitos con posible complemento «1234567 LP» / «1234567-1A»
      count("documents", /\b(?:ci|c\.i\.|carnet|cedula|documento|dni)\s*[:#-]?\s*\d[\d.-]{4,}(?:\s?[A-Za-z]{1,2})?\b/gi, "[DOCUMENTO]");
      count("longNumbers", /(?<![\w.])\d{6,}(?![\w])/g, "[NUMERO]");
      // Nombres tras un disparador
      value = value.replace(NAME_TRIGGER, (match, trigger: string, name: string) => {
        const first = strip(name.split(/\s+/)[0] ?? "");
        if (NOT_NAMES.has(first)) return match;
        stats.names++;
        return `${trigger} [NOMBRE]`;
      });
      return value;
    }
  };
}

// Textos que, tras seudonimizar, aún podrían contener un nombre propio: palabras con mayúscula inicial en medio de una oración que no son vocabulario del dominio. Solo cuenta; el revisor mira los candidatos en un archivo local.
const RESIDUAL = /(?<=[a-záéíóúñ,;:]\s)([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})/gu;
export function residualNameCandidates(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(RESIDUAL)) {
    const word = match[1]!;
    if (!NOT_NAMES.has(strip(word))) out.push(word);
  }
  return out;
}

// Lado seguro: toda palabra con mayúscula inicial en medio de una oración que no sea vocabulario del dominio se enmascara. Puede ocultar de más (un estudio escrito con mayúscula); nunca deja pasar de menos por esta vía.
export function maskResidualNames(text: string): { text: string; masked: number } {
  let masked = 0;
  const out = text.replace(RESIDUAL, (word) => (NOT_NAMES.has(strip(word)) ? word : (masked++, "[NOMBRE?]")));
  return { text: out, masked };
}
