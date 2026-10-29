import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { boardOrderText } from "@/server/orders/order-text";
import { ORDER_STAGES } from "@/server/orders/service";

/**
 * 034 — Tablero de pedidos para la pantalla de cocina.
 *
 * Solo lectura, sin migración: reusa las tablas que ya existen. La
 * pantalla no consume el tablero completo del CRM (ese exige sesión):
 * consume esta vista recortada, que solo trae las etapas de pedidos y,
 * por tarjeta, el texto del pedido (041: el último mensaje con marcador
 * "PEDIDO CONFIRMADO" si lo hay; si no, el primer mensaje de la
 * conversación, que es el que dejó el endpoint 033).
 *
 * El orden de las etapas es el de la base (posición); el filtro deja
 * fuera cualquier etapa que no sea de pedidos.
 */

export type BoardStage = { id: string; name: string; kind: string };
export type BoardOrder = {
  leadId: string;
  stageId: string;
  name: string;
  text: string | null;
  orderedAt: string | null;
  conversationId: string | null;
};

export type BoardStageRow = { id: string; name: string; kind: string };
export type BoardLeadRow = {
  leadId: string;
  stageId: string;
  name: string;
  conversationId: string | null;
};
export type BoardMessageRow = {
  conversationId: string;
  text: string | null;
  createdAt: Date;
};

const ORDER_STAGE_NAMES: Set<string> = new Set(ORDER_STAGES.map((s) => s.name));

/**
 * Arma la respuesta a partir de filas ya leídas. Pura y probada sin BD:
 * filtra las etapas de pedidos, y por tarjeta pega el texto del pedido
 * con su hora. 041 — el texto es el último mensaje con marcador
 * "PEDIDO CONFIRMADO" si lo hay, si no el primer mensaje (igual que
 * antes); la hora NO cambia: sigue siendo la del primer mensaje.
 */
export function assembleOrderBoard(
  stages: BoardStageRow[],
  leads: BoardLeadRow[],
  messages: BoardMessageRow[],
): { stages: BoardStage[]; orders: BoardOrder[] } {
  const orderStages = stages.filter((s) => ORDER_STAGE_NAMES.has(s.name));
  const byConversation = new Map<string, BoardMessageRow[]>();
  for (const message of messages) {
    const list = byConversation.get(message.conversationId);
    if (list) {
      list.push(message);
    } else {
      byConversation.set(message.conversationId, [message]);
    }
  }
  return {
    stages: orderStages.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
    orders: leads.map((lead) => {
      const list = lead.conversationId
        ? byConversation.get(lead.conversationId)
        : undefined;
      const first = list?.[0];
      return {
        leadId: lead.leadId,
        stageId: lead.stageId,
        name: lead.name,
        text: list ? boardOrderText(list) : null,
        orderedAt: first ? first.createdAt.toISOString() : null,
        conversationId: lead.conversationId,
      };
    }),
  };
}

/** Lee el tablero de pedidos de una organización. Solo SELECT. */
export async function getOrderBoard(organizationId: string): Promise<{
  stages: BoardStage[];
  orders: BoardOrder[];
}> {
  const db = getDb();

  const stages = await db
    .select({
      id: schema.pipelineStage.id,
      name: schema.pipelineStage.name,
      kind: schema.pipelineStage.kind,
    })
    .from(schema.pipelineStage)
    .where(scoped(schema.pipelineStage.organizationId, organizationId))
    .orderBy(asc(schema.pipelineStage.position));

  const leadRows = await db
    .select({
      lead: schema.lead,
      contact: schema.contact,
      conversationId: schema.conversation.id,
    })
    .from(schema.lead)
    .innerJoin(schema.contact, eq(schema.lead.contactId, schema.contact.id))
    .leftJoin(
      schema.conversation,
      and(
        eq(schema.conversation.contactId, schema.contact.id),
        eq(schema.conversation.isTest, false),
      ),
    )
    .where(scoped(schema.lead.organizationId, organizationId))
    // 040 — Igual que el tablero del pipeline: descendente para que
    // el pedido nuevo (posición más alta, `maxPos + 1` al nacer)
    // quede arriba. `assembleOrderBoard` conserva el orden de
    // entrada, así que este orden llega tal cual a la pantalla de
    // cocina; las etapas siguen ascendentes (línea de arriba).
    .orderBy(desc(schema.lead.position));

  const conversationIds = leadRows
    .map((r) => r.conversationId)
    .filter((id): id is string => id !== null);

  const messageRows =
    conversationIds.length === 0
      ? []
      : await db
          .select({
            conversationId: schema.message.conversationId,
            text: schema.message.text,
            createdAt: schema.message.createdAt,
          })
          .from(schema.message)
          .where(
            scoped(
              schema.message.organizationId,
              organizationId,
              inArray(schema.message.conversationId, conversationIds),
            ),
          )
          .orderBy(asc(schema.message.createdAt));

  return assembleOrderBoard(
    stages,
    leadRows.map((r) => ({
      leadId: r.lead.id,
      stageId: r.lead.stageId,
      name: r.contact.name,
      conversationId: r.conversationId,
    })),
    messageRows,
  );
}
