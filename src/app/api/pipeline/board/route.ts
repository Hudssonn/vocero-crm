import { and, asc, eq, inArray } from "drizzle-orm";
import { withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { getBranding } from "@/server/branding";
import { firstMessageTextByConversation, formatDeliveryDuration, latestDeliveryByLead } from "@/server/orders/order-text";

export const dynamic = "force-dynamic";

/** Datos completos del kanban: etapas ordenadas + tarjetas con su contacto. */
export const GET = withAuth(async (session) => {
  const db = getDb();

  const stages = await db
    .select()
    .from(schema.pipelineStage)
    .where(scoped(schema.pipelineStage.organizationId, session.organizationId))
    .orderBy(asc(schema.pipelineStage.position));

  const leads = await db
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
        eq(schema.conversation.isTest, false)
      )
    )
    .where(scoped(schema.lead.organizationId, session.organizationId))
    .orderBy(asc(schema.lead.position));

  // La moneda del negocio viaja con el tablero: el cliente suma sus columnas y
  // necesita saber cuál es la única sumable, sin adivinarla ni pedirla aparte.
  const { currency } = await getBranding(session.organizationId);

  // 037 — El cajón enseña el pedido: solo para contactos del menú
  // (`wa_identity` `menu:<orderId>`), el texto es el primer mensaje de
  // su conversación. Para los demás leads, null, y el cajón no pinta
  // la sección. Solo se leen los mensajes de esas conversaciones.
  const menuConversationIds = leads
    .filter(
      (r) =>
        r.contact.waIdentity.startsWith("menu:") && r.conversationId !== null,
    )
    .map((r) => r.conversationId as string);
  const messageRows =
    menuConversationIds.length === 0
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
              session.organizationId,
              inArray(schema.message.conversationId, menuConversationIds),
            ),
          )
          .orderBy(asc(schema.message.createdAt));
  const orderTextByConversation =
    firstMessageTextByConversation(messageRows);

  // 039 — Duración de entrega, en UNA sola consulta para todo el
  // tablero (nada de una consulta por lead). Solo para pedidos del
  // menú (`orderText != null`) cuya etapa actual tiene `kind === "won"`:
  // la etapa se identifica por `kind`, nunca por su nombre, porque los
  // nombres se pueden editar. La hora del pedido es `lead.createdAt`
  // (la fila completa del lead ya viene en la consulta de arriba) y la
  // hora de entrega es el evento más reciente hacia la etapa actual;
  // sin evento, no hay duración (null), nunca se inventa una.
  const kindByStageId = new Map(stages.map((s) => [s.id, s.kind]));
  const orderTextByLead = new Map<string, string | null>();
  for (const r of leads) {
    orderTextByLead.set(
      r.lead.id,
      r.contact.waIdentity.startsWith("menu:") && r.conversationId !== null
        ? (orderTextByConversation.get(r.conversationId) ?? null)
        : null,
    );
  }
  const deliveredLeads = leads.filter(
    (r) =>
      orderTextByLead.get(r.lead.id) !== null &&
      kindByStageId.get(r.lead.stageId) === "won",
  );
  const deliveryEventRows =
    deliveredLeads.length === 0
      ? []
      : await db
          .select({
            leadId: schema.leadStageEvent.leadId,
            toStageId: schema.leadStageEvent.toStageId,
            occurredAt: schema.leadStageEvent.occurredAt,
          })
          .from(schema.leadStageEvent)
          .where(
            scoped(
              schema.leadStageEvent.organizationId,
              session.organizationId,
              inArray(
                schema.leadStageEvent.leadId,
                deliveredLeads.map((r) => r.lead.id),
              ),
            ),
          )
          .orderBy(asc(schema.leadStageEvent.occurredAt));
  const deliveredAtByLead = latestDeliveryByLead(
    deliveryEventRows,
    deliveredLeads.map((r) => ({ id: r.lead.id, stageId: r.lead.stageId })),
  );
  const deliveredInByLead = new Map<string, string>();
  for (const r of deliveredLeads) {
    const deliveredAt = deliveredAtByLead.get(r.lead.id);
    if (deliveredAt) {
      deliveredInByLead.set(
        r.lead.id,
        formatDeliveryDuration(r.lead.createdAt, deliveredAt),
      );
    }
  }

  return Response.json({
    currency,
    stages: stages.map((s) => ({
      id: s.id,
      name: s.name,
      position: s.position,
      kind: s.kind,
    })),
    leads: leads.map((r) => ({
      id: r.lead.id,
      stageId: r.lead.stageId,
      position: r.lead.position,
      lastActivityAt: r.lead.lastActivityAt?.toISOString() ?? null,
      amountCents: r.lead.amountCents,
      currency: r.lead.currency,
      priority: r.lead.priority,
      contact: {
        id: r.contact.id,
        name: r.contact.name,
        phone: r.contact.phone,
      },
      conversationId: r.conversationId,
      orderText: orderTextByLead.get(r.lead.id) ?? null,
      deliveredIn: deliveredInByLead.get(r.lead.id) ?? null,
    })),
  });
});
