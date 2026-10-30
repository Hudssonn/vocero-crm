import { apiError, parseBody, withAuth } from "@/lib/api";
import {
  agendaDisabledResponse,
  agendaEnabled,
} from "@/server/agenda/flag";
import {
  getReminderConfig,
  putReminderConfig,
  reminderConfigSchema,
} from "@/server/reminders/config";

export const dynamic = "force-dynamic";

/**
 * 047 — Configuración de recordatorios automáticos.
 *
 * `GET` devuelve la config guardada (o los defaults si aún no existe);
 * `PUT` (solo owner) la guarda con validación Zod. Los recordatorios viajan
 * por WhatsApp vía Kapso: no hay secretos en esta superficie.
 */
export const GET = withAuth(async (session) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const config = await getReminderConfig(session.organizationId);
  return Response.json({
    config: {
      enabled: config.enabled,
      hoursBefore: config.hoursBefore,
      message: config.message,
    },
  });
});

export const PUT = withAuth(async (session, req: Request) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  if (session.role !== "owner") {
    return apiError(403, "forbidden", "Solo el dueño puede cambiar esto");
  }
  const body = await parseBody(req, reminderConfigSchema);
  if (!body.ok) return body.response;

  const config = await putReminderConfig(session.organizationId, body.data);
  return Response.json({
    config: {
      enabled: config.enabled,
      hoursBefore: config.hoursBefore,
      message: config.message,
    },
  });
});
