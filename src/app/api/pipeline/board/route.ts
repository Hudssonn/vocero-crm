import { and, asc, eq, inArray } from "drizzle-orm";
import { withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { getBranding } from "@/server/branding";
import { firstMessageTextByConversation } from "@/server/orders/order-text";

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
      orderText:
        r.contact.waIdentity.startsWith("menu:") && r.conversationId !== null
          ? (orderTextByConversation.get(r.conversationId) ?? null)
          : null,
    })),
  });
});
