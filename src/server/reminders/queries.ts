import { count, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";

/**
 * 047 — Lectura de recordatorios para la lista paginada de la API.
 */

export type ReminderStatus = "pendiente" | "enviado" | "fallido" | "cancelado";

export type ReminderRow = {
  id: string;
  bookingId: string;
  contactId: string | null;
  scheduledAt: Date;
  message: string;
  status: ReminderStatus;
  attempts: number;
  sentAt: Date | null;
  lastError: string | null;
  createdAt: Date;
};

export async function listReminders(input: {
  organizationId: string;
  status?: ReminderStatus;
  limit: number;
  offset: number;
}): Promise<{ reminders: ReminderRow[]; total: number }> {
  const db = getDb();
  const where = input.status
    ? scoped(
        schema.reminder.organizationId,
        input.organizationId,
        eq(schema.reminder.status, input.status)
      )
    : scoped(schema.reminder.organizationId, input.organizationId);

  const [filas, conteo] = await Promise.all([
    db
      .select({
        id: schema.reminder.id,
        bookingId: schema.reminder.bookingId,
        contactId: schema.reminder.contactId,
        scheduledAt: schema.reminder.scheduledAt,
        message: schema.reminder.message,
        status: schema.reminder.status,
        attempts: schema.reminder.attempts,
        sentAt: schema.reminder.sentAt,
        lastError: schema.reminder.lastError,
        createdAt: schema.reminder.createdAt,
      })
      .from(schema.reminder)
      .where(where)
      .orderBy(desc(schema.reminder.scheduledAt))
      .limit(input.limit)
      .offset(input.offset),
    db
      .select({ n: count() })
      .from(schema.reminder)
      .where(where)
      .then((rows) => rows[0]?.n ?? 0),
  ]);
  return {
    reminders: filas.map((f) => ({
      ...f,
      status: f.status as ReminderStatus,
      sentAt: f.sentAt ?? null,
      lastError: f.lastError ?? null,
    })),
    total: conteo,
  };
}
