import { z } from "zod";
import { apiError, parseBody } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { manualChat } from "@/server/manual-chat/service";

export const dynamic = "force-dynamic";

/**
 * TEMPORAL (prueba manual de Hudson, solo devapp): un turno libre del
 * agente con el mismo camino del Laboratorio. Protegida con BOT_API_KEY.
 * BORRAR junto con src/server/manual-chat/ cuando termine la prueba.
 */
const bodySchema = z.object({
  text: z.string().trim().min(1).max(4000),
  reset: z.boolean().optional().default(false),
});

export async function POST(req: Request) {
  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const result = await manualChat(
    organizationId,
    body.data.text,
    body.data.reset ?? false
  );
  return Response.json(result);
}
