import { apiError } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { getOrderBoard } from "@/server/orders/board";

export const dynamic = "force-dynamic";

/**
 * 034 — Tablero de pedidos para la pantalla de cocina.
 *
 * Solo GET y solo lectura: la pantalla (que no tiene login) lo consume
 * a través del servidor del menú, que guarda la llave. Sin llave
 * configurada, 401 siempre, como el resto de `/api/bot/*`.
 */

export async function GET(req: Request) {
  const denied = requireBotKey(req);
  if (denied) return denied;
  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }

  try {
    return Response.json(await getOrderBoard(organizationId));
  } catch (err) {
    return apiError(
      500,
      "board_failed",
      err instanceof Error ? err.message : "No se pudo leer el tablero",
    );
  }
}
