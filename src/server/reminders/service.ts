import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { getReminderConfig } from "@/server/reminders/config";
import { renderReminderMessage } from "@/server/reminders/render";
import { getSettings } from "@/server/agenda/settings";

/**
 * 047 — Generación y cancelación de recordatorios ligados a una cita.
 *
 * La fila `reminder` se crea al confirmar la cita (ver el hook en
 * `src/server/agenda/service.ts`), con el mensaje ya renderizado: si el
 * negocio cambia después la plantilla o la zona horaria, lo ya programado no
 * se mueve. Cancelar la cita marca sus recordatorios como `cancelado`.
 */

// ── Lógica pura (testeable sin BD) ─────────────────────────────────────────

export type MotivoSalto =
  | "config_apagada"
  | "cita_no_agendada"
  | "cita_de_prueba"
  | "ya_existe";

export type DecisionGeneracion =
  | { generar: true }
  | { generar: false; motivo: MotivoSalto };

/**
 * Cuándo debe salir el recordatorio: la hora de la cita menos las horas
 * antes. Puede caer en el pasado (cita creada a última hora): el worker lo
 * toma en la siguiente tanda y lo envía de una vez.
 */
export function calcularScheduledAt(citaUtc: Date, hoursBefore: number): Date {
  return new Date(citaUtc.getTime() - hoursBefore * 3_600_000);
}

/** Decide si la cita amerita un recordatorio. Reglas D2 de la spec. */
export function decideGeneracion(input: {
  configEnabled: boolean;
  bookingStatus: string;
  bookingIsTest: boolean;
}): DecisionGeneracion {
  if (!input.configEnabled) return { generar: false, motivo: "config_apagada" };
  if (input.bookingIsTest)
    return { generar: false, motivo: "cita_de_prueba" };
  if (input.bookingStatus !== "agendada")
    return { generar: false, motivo: "cita_no_agendada" };
  return { generar: true };
}

/** Backoff del worker: 10 min × intento (el reintento reprograma `scheduled_at`). */
export const MS_REINTENTO = 10 * 60 * 1000;

export function siguienteReintento(attempts: number, ahora: Date = new Date()): Date {
  return new Date(ahora.getTime() + MS_REINTENTO * attempts);
}

/** Reintentos máximos antes de marcar el recordatorio como fallido. */
export const MAX_INTENTOS = 3;

// ── Puerta de BD ───────────────────────────────────────────────────────────

export type ResultadoGeneracion =
  | { creado: true; reminderId: string }
  | { creado: false; motivo: MotivoSalto };

function esViolacionUnica(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "23505"
  );
}

type FilaCita = {
  id: string;
  status: string;
  isTest: boolean;
  scheduledAt: Date;
  contactId: string | null;
  contactName: string | null;
};

async function leerCita(
  organizationId: string,
  bookingId: string
): Promise<FilaCita | null> {
  const rows = await getDb()
    .select({
      id: schema.booking.id,
      status: schema.booking.status,
      isTest: schema.booking.isTest,
      scheduledAt: schema.booking.scheduledAt,
      contactId: schema.booking.contactId,
      contactName: schema.contact.name,
    })
    .from(schema.booking)
    .leftJoin(schema.contact, eq(schema.booking.contactId, schema.contact.id))
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        eq(schema.booking.id, bookingId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Crea el recordatorio de una cita según la config de la org. Idempotente:
 * si ya hay uno vivo para la cita, no crea otro (índice parcial
 * `reminder_booking_vivo_uq`).
 *
 * Nunca lanza por un fallo del recordatorio: quien lo llama ya confirmó la
 * cita, y un recordatorio no puede deshacerla.
 */
export async function generarRecordatorioParaCita(input: {
  organizationId: string;
  bookingId: string;
}): Promise<ResultadoGeneracion> {
  const cita = await leerCita(input.organizationId, input.bookingId);
  if (!cita) return { creado: false, motivo: "cita_no_agendada" };

  const config = await getReminderConfig(input.organizationId);
  const decision = decideGeneracion({
    configEnabled: config.enabled,
    bookingStatus: cita.status,
    bookingIsTest: cita.isTest,
  });
  if (!decision.generar) return { creado: false, motivo: decision.motivo };

  const settings = await getSettings(input.organizationId);
  const mensaje = renderReminderMessage(config.message, {
    nombre: cita.contactName,
    citaUtc: cita.scheduledAt,
    timezone: settings.timezone,
  });

  try {
    const inserted = await getDb()
      .insert(schema.reminder)
      .values({
        id: newId("reminder"),
        organizationId: input.organizationId,
        bookingId: cita.id,
        contactId: cita.contactId,
        scheduledAt: calcularScheduledAt(cita.scheduledAt, config.hoursBefore),
        message: mensaje,
      })
      .returning({ id: schema.reminder.id });
    return { creado: true, reminderId: inserted[0]!.id };
  } catch (err) {
    // Carrera: dos hilos generaron a la vez. Uno solo queda.
    if (esViolacionUnica(err)) return { creado: false, motivo: "ya_existe" };
    throw err;
  }
}

/** Marca `cancelado` los recordatorios vivos de una cita. */
export async function cancelarRecordatoriosDeCita(input: {
  organizationId: string;
  bookingId: string;
}): Promise<{ cancelados: number }> {
  const updated = await getDb()
    .update(schema.reminder)
    .set({ status: "cancelado" })
    .where(
      scoped(
        schema.reminder.organizationId,
        input.organizationId,
        and(
          eq(schema.reminder.bookingId, input.bookingId),
          eq(schema.reminder.status, "pendiente")
        )
      )
    )
    .returning({ id: schema.reminder.id });
  return { cancelados: updated.length };
}
