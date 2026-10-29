import type { SchedulePayload } from "./types.js";

// "¿Está abierto?" calculado por código determinista sobre un horario APROBADO. Nunca interviene un modelo. La zona horaria viene del propio horario aprobado.

export interface ScheduleStatus {
  open: boolean;
  // Fecha y día de la semana LOCALES (0 = domingo) según la zona del horario.
  localDate: string;
  weekday: number;
  // Franjas que aplican a esa fecha (vacío = cerrado todo el día).
  intervals: Array<{ opens: string; closes: string }>;
  source: "WEEKLY" | "EXCEPTION";
  exceptionNote?: string;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// undefined si la zona horaria no es válida (el contenido no se usa).
function localParts(instant: Date, timeZone: string): { date: string; weekday: number; minutes: number } | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(instant);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    const weekday = WEEKDAYS[get("weekday")];
    if (weekday === undefined) return undefined;
    return { date: `${get("year")}-${get("month")}-${get("day")}`, weekday, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
  } catch {
    return undefined;
  }
}
const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function scheduleStatusAt(schedule: SchedulePayload, instant: Date): ScheduleStatus | undefined {
  const local = localParts(instant, schedule.timezone);
  if (!local) return undefined;
  const exception = schedule.exceptions?.find((entry) => entry.date === local.date);
  let intervals: Array<{ opens: string; closes: string }>;
  let source: ScheduleStatus["source"];
  if (exception) {
    source = "EXCEPTION";
    intervals = exception.closed ? [] : [{ opens: exception.opens!, closes: exception.closes! }];
  } else {
    source = "WEEKLY";
    intervals = schedule.weekly.filter((entry) => entry.day === local.weekday).map(({ opens, closes }) => ({ opens, closes })).sort((a, b) => a.opens.localeCompare(b.opens));
  }
  const open = intervals.some((interval) => local.minutes >= toMinutes(interval.opens) && local.minutes < toMinutes(interval.closes));
  return { open, localDate: local.date, weekday: local.weekday, intervals, source, ...(exception?.note ? { exceptionNote: exception.note } : {}) };
}
