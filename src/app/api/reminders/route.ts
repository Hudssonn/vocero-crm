import { z } from "zod";
import { apiError, withAuth } from "@/lib/api";
import {
  agendaDisabledResponse,
  agendaEnabled,
} from "@/server/agenda/flag";
import { listReminders } from "@/server/reminders/queries";

export const dynamic = "force-dynamic";

/**
 * 047 — Lista paginada de recordatorios.
 *
 * `GET /api/reminders?status=pendiente&limit=50&offset=0` →
 * `{ reminders, total, limit, offset }`. El filtro de status es opcional.
 */
const querySchema = z.object({
  status: z.enum(["pendiente", "enviado", "fallido", "cancelado"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = withAuth(async (session, req: Request) => {
  if (!agendaEnabled()) return agendaDisabledResponse();

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    status: url.searchParams.get("status") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    offset: url.searchParams.get("offset") ?? undefined,
  });
  if (!parsed.success) {
    return apiError(422, "invalid_query", "Parámetros inválidos");
  }

  const { reminders, total } = await listReminders({
    organizationId: session.organizationId,
    status: parsed.data.status,
    limit: parsed.data.limit,
    offset: parsed.data.offset,
  });
  return Response.json({
    reminders,
    total,
    limit: parsed.data.limit,
    offset: parsed.data.offset,
  });
});
