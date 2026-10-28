import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { moveLeadToStage } from "@/server/leads/stage-history";
import { ensureOrderStages, ORDER_STAGES } from "@/server/orders/service";

/**
 * 035 — Movimientos de cocina desde la pantalla de pedidos.
 *
 * La pantalla solo avanza: `Nuevo pedido → En preparación → Listo`.
 * El movimiento se escribe SOLO por `moveLeadToStage` (la única puerta
 * que escribe `lead.stage_id`); este módulo solo lee y valida antes.
 */

export const KITCHEN_TARGETS = ["En preparación", "Listo"] as const;
export type KitchenTarget = (typeof KITCHEN_TARGETS)[number];

const ORDER_STAGE_NAMES: Set<string> = new Set(
  ORDER_STAGES.map((s) => s.name),
);

/** Resultado puro de validar una transición de cocina. */
export type KitchenTransition = "move" | "duplicate" | "invalid";

export function kitchenTransition(
  current: string,
  to: string,
): KitchenTransition {
  if (current === to) return "duplicate";
  if (current === "Nuevo pedido" && to === "En preparación") return "move";
  if (current === "En preparación" && to === "Listo") return "move";
  return "invalid";
}

export type MoveKitchenOrderResult =
  | { ok: true; leadId: string; stage: string; duplicate: boolean }
  | {
      ok: false;
      reason:
        | "lead_not_found"
        | "not_an_order"
        | "invalid_transition"
        | "stage_not_found";
    };

export async function moveKitchenOrder(
  organizationId: string,
  leadId: string,
  to: KitchenTarget,
): Promise<MoveKitchenOrderResult> {
  const db = getDb();
  const stageIds = await ensureOrderStages(organizationId);

  const rows = await db
    .select({
      stageName: schema.pipelineStage.name,
    })
    .from(schema.lead)
    .leftJoin(
      schema.pipelineStage,
      eq(schema.lead.stageId, schema.pipelineStage.id),
    )
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        eq(schema.lead.id, leadId),
      ),
    );
  const row = rows[0];
  if (!row) return { ok: false, reason: "lead_not_found" };
  const current = row.stageName;
  if (current === null || !ORDER_STAGE_NAMES.has(current)) {
    return { ok: false, reason: "not_an_order" };
  }
  const transition = kitchenTransition(current, to);
  if (transition === "duplicate") {
    return { ok: true, leadId, stage: current, duplicate: true };
  }
  if (transition === "invalid") {
    return { ok: false, reason: "invalid_transition" };
  }
  const toStageId = stageIds.get(to);
  if (!toStageId) return { ok: false, reason: "stage_not_found" };
  const moved = await moveLeadToStage({
    organizationId,
    leadId,
    toStageId,
    actorUserId: null,
    source: "bot",
  });
  if (!moved.ok) {
    if (moved.reason === "lead_not_found") {
      return { ok: false, reason: "lead_not_found" };
    }
    return { ok: false, reason: "stage_not_found" };
  }
  return { ok: true, leadId, stage: to, duplicate: false };
}
