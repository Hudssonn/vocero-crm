import { REMINDER_DEFAULT_TIMEZONE } from "@/server/reminders/config";

/**
 * 047 — Render del mensaje del recordatorio. Función pura (sin BD ni red):
 * sustituye `{{nombre}}`, `{{fecha}}` y `{{hora}}` de la plantilla con los
 * datos de la cita, calculados en la zona horaria del negocio.
 */

/** `{{nombre}}` — si no hay nombre, no queda hueco: se usa "cliente". */
function nombreDe(nombre: string | null | undefined): string {
  const limpio = (nombre ?? "").trim();
  return limpio.length > 0 ? limpio : "cliente";
}

/**
 * Zona segura: una zona inválida no tumba el render, cae al fallback del
 * negocio (Costa Rica). El contrato del repo es que la conexión fija
 * TimeZone=UTC; aquí solo se formatea de pared.
 */
function zonaSegura(timezone: string | null | undefined): string {
  const tz = (timezone ?? "").trim() || REMINDER_DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("es-CR", { timeZone: tz });
    return tz;
  } catch {
    return REMINDER_DEFAULT_TIMEZONE;
  }
}

/** Fecha de pared de la cita, p. ej. "15 de mayo de 2026". */
export function formatFecha(citaUtc: Date, timezone: string | null | undefined): string {
  const tz = zonaSegura(timezone);
  return new Intl.DateTimeFormat("es-CR", {
    timeZone: tz,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(citaUtc);
}

/** Hora de pared de la cita, p. ej. "10:30 a. m.". */
export function formatHora(citaUtc: Date, timezone: string | null | undefined): string {
  const tz = zonaSegura(timezone);
  return new Intl.DateTimeFormat("es-CR", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(citaUtc);
}

/**
 * Renderiza la plantilla. Las variables desconocidas se dejan intactas para
 * que un error de tipeo sea visible en vez de silencioso.
 */
export function renderReminderMessage(
  plantilla: string,
  input: {
    nombre: string | null | undefined;
    citaUtc: Date;
    timezone: string | null | undefined;
  }
): string {
  return plantilla
    .replace(/\{\{\s*nombre\s*\}\}/g, nombreDe(input.nombre))
    .replace(/\{\{\s*fecha\s*\}\}/g, formatFecha(input.citaUtc, input.timezone))
    .replace(/\{\{\s*hora\s*\}\}/g, formatHora(input.citaUtc, input.timezone));
}
