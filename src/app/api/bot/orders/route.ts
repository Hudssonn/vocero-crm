import { apiError, parseBody } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { createMenuOrder, menuOrderSchema } from "@/server/orders/service";

export const dynamic = "force-dynamic";

/**
 * 033 — Entrada de pedidos del menú QR de restaurantes.
 *
 * CONTRATO: crear responde **201**; reintentar el mismo `orderId` responde
 * **200** con lo ya creado (no es un recurso nuevo, no se duplica). El
 * error va anidado (`{"error":{"code":…}}`), como el resto de `/api/bot/*`.
 * Solo POST: no hay listar, editar ni borrar pedidos por esta superficie.
 */

export async function POST(req: Request) {
  const denied = requireBotKey(req);
  if (denied) return denied;
  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }

  const body = await parseBody(req, menuOrderSchema);
  if (!body.ok) return body.response;

  try {
    const result = await createMenuOrder(organizationId, body.data);
    return Response.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (err) {
    return apiError(
      500,
      "order_failed",
      err instanceof Error ? err.message : "No se pudo registrar el pedido",
    );
  }
}
