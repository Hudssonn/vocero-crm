import { and, asc, eq, lte } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { MetaApiError } from "@/lib/meta/client";
import {
  MAX_INTENTOS,
  siguienteReintento,
} from "@/server/reminders/service";
import {
  getWhatsappKapsoCredentialsByOrg,
  markWhatsappKapsoReconnectRequired,
} from "@/server/whatsapp/credentials-kapso";
import { sendKapsoMessage } from "@/server/whatsapp/send-kapso";

/**
 * 047 — Worker de recordatorios automáticos.
 *
 * En proceso, como el de despacho (`src/server/dispatch/worker.ts`): sin
 * colas externas, la BD es el outbox. Cada 60 s una tanda toma hasta 20
 * recordatorios `pendiente` cuya hora ya llegó y los envía por WhatsApp vía
 * Kapso. Reanuda en el arranque con `resumeReminders()`
 * (`src/instrumentation-node.ts`).
 */

const INTERVALO_MS = 60_000;
const POR_TANDA = 20;

type FilaRecordatorio = {
  id: string;
  organizationId: string;
  bookingId: string;
  contactId: string | null;
  scheduledAt: Date;
  message: string;
  status: string;
  attempts: number;
};

type Estado = {
  timer: NodeJS.Timeout | null;
  corriendo: boolean;
};

// En globalThis porque en dev los módulos se evalúan más de una vez (una por
// ruta) y todas las copias deben compartir el mismo worker: dos temporizadores
// sobre la misma tabla se pisarían el trabajo.
const globalForWorker = globalThis as unknown as {
  __voceroRemindersWorker?: Estado;
};

function estado(): Estado {
  if (!globalForWorker.__voceroRemindersWorker) {
    globalForWorker.__voceroRemindersWorker = {
      timer: null,
      corriendo: false,
    };
  }
  return globalForWorker.__voceroRemindersWorker;
}

export function iniciarWorkerRecordatorios(): void {
  const e = estado();
  if (e.timer) return;
  e.timer = setInterval(() => void tanda(), INTERVALO_MS);
  e.timer.unref?.();
}

export function detenerWorkerRecordatorios(): void {
  const e = estado();
  if (e.timer) clearInterval(e.timer);
  e.timer = null;
}

/** Una pasada. Devuelve cuántos recordatorios tomó. */
export async function tanda(ahora: Date = new Date()): Promise<number> {
  const e = estado();
  if (e.corriendo) return 0;
  e.corriendo = true;
  try {
    const filas = await tomarPendientes(ahora);
    for (const fila of filas) {
      await procesar(fila).catch((err) =>
        console.error(`[recordatorios] ${fila.id} falló sin marca:`, err)
      );
    }
    return filas.length;
  } catch (err) {
    console.error("[recordatorios] la tanda falló:", err);
    return 0;
  } finally {
    e.corriendo = false;
  }
}

async function tomarPendientes(ahora: Date): Promise<FilaRecordatorio[]> {
  return getDb()
    .select({
      id: schema.reminder.id,
      organizationId: schema.reminder.organizationId,
      bookingId: schema.reminder.bookingId,
      contactId: schema.reminder.contactId,
      scheduledAt: schema.reminder.scheduledAt,
      message: schema.reminder.message,
      status: schema.reminder.status,
      attempts: schema.reminder.attempts,
    })
    .from(schema.reminder)
    .where(
      and(
        eq(schema.reminder.status, "pendiente"),
        lte(schema.reminder.scheduledAt, ahora)
      )
    )
    .orderBy(asc(schema.reminder.scheduledAt))
    .limit(POR_TANDA);
}

async function marcar(
  fila: FilaRecordatorio,
  patch: {
    status?: "enviado" | "fallido" | "cancelado";
    attempts?: number;
    sentAt?: Date | null;
    lastError?: string | null;
    scheduledAt?: Date;
  }
): Promise<void> {
  await getDb()
    .update(schema.reminder)
    .set({ ...patch })
    .where(
      scoped(
        schema.reminder.organizationId,
        fila.organizationId,
        eq(schema.reminder.id, fila.id)
      )
    );
}

/**
 * El reintento reprograma `scheduled_at` con backoff: la fila sigue
 * `pendiente` y la siguiente tanda la retoma. Tras MAX_INTENTOS, `fallido`.
 */
async function fallidoOReintento(
  fila: FilaRecordatorio,
  detalle: string,
  ahora: Date = new Date()
): Promise<void> {
  const attempts = fila.attempts + 1;
  if (attempts >= MAX_INTENTOS) {
    await marcar(fila, {
      status: "fallido",
      attempts,
      lastError: detalle,
    });
    console.error(
      `[recordatorios] ${fila.id} fallido tras ${attempts} intentos: ${detalle}`
    );
    return;
  }
  await marcar(fila, {
    attempts,
    lastError: detalle,
    scheduledAt: siguienteReintento(attempts, ahora),
  });
}

async function procesar(fila: FilaRecordatorio): Promise<void> {
  const db = getDb();

  // La cita pudo cancelarse o moverse después de programar el recordatorio.
  const cita = await db
    .select({
      status: schema.booking.status,
      isTest: schema.booking.isTest,
    })
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        fila.organizationId,
        eq(schema.booking.id, fila.bookingId)
      )
    )
    .limit(1);
  if (!cita[0] || cita[0].status !== "agendada" || cita[0].isTest) {
    await marcar(fila, { status: "cancelado" });
    return;
  }

  const creds = await getWhatsappKapsoCredentialsByOrg(fila.organizationId);
  if (!creds) {
    await marcar(fila, {
      status: "fallido",
      attempts: fila.attempts + 1,
      lastError: "La organización no tiene WhatsApp por Kapso conectado",
    });
    return;
  }

  const contacto = fila.contactId
    ? (
        await db
          .select({ phone: schema.contact.phone })
          .from(schema.contact)
          .where(
            scoped(
              schema.contact.organizationId,
              fila.organizationId,
              eq(schema.contact.id, fila.contactId)
            )
          )
          .limit(1)
      )[0]
    : undefined;
  const to = (contacto?.phone ?? "").trim();
  if (!to) {
    await marcar(fila, {
      status: "fallido",
      attempts: fila.attempts + 1,
      lastError: "El contacto no tiene teléfono",
    });
    return;
  }

  try {
    await sendKapsoMessage({
      phoneNumberId: creds.phoneNumberId,
      apiKey: creds.apiKey,
      to,
      text: fila.message,
    });
  } catch (err) {
    const detalle =
      err instanceof Error ? err.message : "error desconocido al enviar";
    if (err instanceof MetaApiError && err.isAuthError) {
      // La llave murió: se pausa y se reintenta cuando el dueño reconecte.
      await markWhatsappKapsoReconnectRequired(fila.organizationId);
    }
    await fallidoOReintento(fila, detalle);
    return;
  }

  await marcar(fila, {
    status: "enviado",
    attempts: fila.attempts + 1,
    sentAt: new Date(),
    lastError: null,
  });
}
