import { z } from "zod";
import { apiError, parseBody } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import {
  KITCHEN_TARGETS,
  moveKitchenOrder,
} from "@/server/orders/stage";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const moveSchema = z.object({ to: z.enum(KITCHEN_TARGETS) });

/**
 * 035 — Movimiento de cocina desde la pantalla de pedidos.
 *
 * CONTRATO: solo avanza (`Nuevo pedido → En preparación → Listo`); el
 * destino igual a la etapa actual responde 200 duplicado sin mover nada
 * (como el reintento de 033). El error va anidado (`{"error":{"code}}`),
 * como el resto de `/api/bot/*`. Solo POST: no hay listar, editar ni
 * borrar pedidos por esta superficie.
 */
export async function POST(req: Request, ctx: Params) {
  const denied = requireBotKey(req);
  if (denied) return denied;
  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }
  const { id: leadId } = await ctx.params;

  const body = await parseBody(req, moveSchema);
  if (!body.ok) return body.response;

  try {
    const result = await moveKitchenOrder(organizationId, leadId, body.data.to);
    if (!result.ok) {
      if (result.reason === "lead_not_found") {
        return apiError(404, "lead_not_found", "Pedido no encontrado");
      }
      if (result.reason === "not_an_order") {
        return apiError(
          409,
          "not_an_order",
          "El lead no es un pedido del menú",
        );
      }
      if (result.reason === "invalid_transition") {
        return apiError(
          409,
          "invalid_transition",
          "La cocina solo avanza: Nuevo → En preparación → Listo",
        );
      }
      return apiError(500, "stage_not_found", "Etapa destino no encontrada");
    }
    if (result.duplicate) {
      return Response.json({
        leadId: result.leadId,
        stage: result.stage,
        duplicate: true,
      });
    }
    return Response.json({
      leadId: result.leadId,
      stage: result.stage,
      moved: true,
    });
  } catch (err) {
    return apiError(
      500,
      "move_failed",
      err instanceof Error ? err.message : "No se pudo mover el pedido",
    );
  }
}
