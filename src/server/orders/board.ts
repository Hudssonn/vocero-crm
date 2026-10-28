import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { ORDER_STAGES } from "@/server/orders/service";

/**
 * 034 — Tablero de pedidos para la pantalla de cocina.
 *
 * Solo lectura, sin migración: reusa las tablas que ya existen. La
 * pantalla no consume el tablero completo del CRM (ese exige sesión):
 * consume esta vista recortada, que solo trae las etapas de pedidos y,
 * por tarjeta, el texto del pedido (el primer mensaje de la conversación,
 * que es el que dejó el endpoint 033).
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
 * filtra las etapas de pedidos, y por tarjeta pega el primer mensaje de
 * su conversación (el texto del pedido) con su hora.
 */
export function assembleOrderBoard(
  stages: BoardStageRow[],
  leads: BoardLeadRow[],
  messages: BoardMessageRow[],
): { stages: BoardStage[]; orders: BoardOrder[] } {
  const orderStages = stages.filter((s) => ORDER_STAGE_NAMES.has(s.name));
  const firstByConversation = new Map<string, BoardMessageRow>();
  for (const message of messages) {
    if (!firstByConversation.has(message.conversationId)) {
      firstByConversation.set(message.conversationId, message);
    }
  }
  return {
    stages: orderStages.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
    orders: leads.map((lead) => {
      const first = lead.conversationId
        ? firstByConversation.get(lead.conversationId)
        : undefined;
      return {
        leadId: lead.leadId,
        stageId: lead.stageId,
        name: lead.name,
        text: first?.text ?? null,
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
    .orderBy(asc(schema.lead.position));

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
