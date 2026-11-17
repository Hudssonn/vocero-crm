import { and, asc, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { runAgentTurn } from "@/server/ai/pipeline";

/**
 * TEMPORAL (prueba manual de Hudson, solo devapp): replica el turno del
 * Laboratorio para un mensaje libre. Contacto sintético archivado y
 * conversación isTest: no aparece en la lista ni genera leads, jamás toca
 * la API de WhatsApp. BORRAR junto con su ruta cuando termine la prueba.
 */
const MANUAL_PHONE = "5210000000099";

export async function manualChat(
  organizationId: string,
  text: string,
  reset: boolean
): Promise<{ replies: string[]; handoff: boolean }> {
  const db = getDb();

  const inserted = await db
    .insert(schema.contact)
    .values({
      id: newId("contact"),
      organizationId,
      phone: MANUAL_PHONE,
      waIdentity: MANUAL_PHONE,
      name: "Prueba manual",
      archivedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [
        schema.contact.organizationId,
        schema.contact.channel,
        schema.contact.waIdentity,
      ],
    })
    .returning();
  let contactId = inserted[0]?.id;
  if (!contactId) {
    const rows = await db
      .select({ id: schema.contact.id })
      .from(schema.contact)
      .where(
        and(
          eq(schema.contact.organizationId, organizationId),
          eq(schema.contact.phone, MANUAL_PHONE)
        )
      )
      .limit(1);
    contactId = rows[0]!.id;
  }

  let convId: string | undefined;
  if (!reset) {
    const convs = await db
      .select({
        id: schema.conversation.id,
        handoffAt: schema.conversation.handoffAt,
      })
      .from(schema.conversation)
      .where(
        and(
          eq(schema.conversation.organizationId, organizationId),
          eq(schema.conversation.contactId, contactId),
          eq(schema.conversation.isTest, true)
        )
      )
      .orderBy(desc(schema.conversation.createdAt))
      .limit(1);
    if (convs[0] && !convs[0].handoffAt) convId = convs[0].id;
  }
  if (!convId) {
    convId = newId("conversation");
    await db.insert(schema.conversation).values({
      id: convId,
      organizationId,
      contactId,
      isTest: true,
      aiEnabled: true,
    });
  }

  const before = await db
    .select({ id: schema.message.id })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.conversationId, convId),
        eq(schema.message.direction, "out")
      )
    );
  const beforeIds = new Set(before.map((m) => m.id));

  const now = new Date();
  await db.insert(schema.message).values({
    id: newId("message"),
    organizationId,
    conversationId: convId,
    direction: "in",
    type: "text",
    text,
    status: "delivered",
    waTimestamp: now,
  });
  await db
    .update(schema.conversation)
    .set({ lastInboundAt: now, lastMessageAt: now, updatedAt: now })
    .where(eq(schema.conversation.id, convId));

  await runAgentTurn(convId);

  const after = await db
    .select()
    .from(schema.message)
    .where(
      and(
        eq(schema.message.conversationId, convId),
        eq(schema.message.direction, "out")
      )
    )
    .orderBy(asc(schema.message.createdAt));
  const replies = after
    .filter((m) => !beforeIds.has(m.id) && m.text)
    .map((m) => m.text!);
  const handoffRows = await db
    .select({ handoffAt: schema.conversation.handoffAt })
    .from(schema.conversation)
    .where(eq(schema.conversation.id, convId))
    .limit(1);
  return { replies, handoff: !!handoffRows[0]?.handoffAt };
}
