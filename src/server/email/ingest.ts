import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { maybeRunAgentTurn } from "@/server/ai/trigger";
import { publish } from "@/server/events/bus";
import {
  EMAIL_PREFIX,
  getOrCreateContactByIdentity,
} from "@/server/inbox/identity";
import {
  getOrCreateConversation,
  serializeMessage,
} from "@/server/inbox/ingest";
import { onLeadActivity } from "@/server/inbox/lead-activity";

/**
 * 031 — Ingesta de un correo entrante.
 *
 * Es la gemela de `ingestInboundMessage` para un canal sin webhook: la
 * idempotencia va por `email_message_id` (el `Message-ID`), no por
 * `wa_message_id`, y el mensaje guarda asunto e `In-Reply-To` para que la
 * respuesta SMTP de la fase 2 pueda hilar. Todo lo demás — contacto,
 * conversación, lead, eventos de bandeja — es el mismo camino que cualquier
 * canal.
 *
 * Fase 1: NO se invoca el turno del agente. Sin envío SMTP, su respuesta
 * moriría en `sendText` con `not_connected`; el correo queda en la bandeja
 * esperando a una persona, y la fase 2 enciende el turno al existir la rama
 * de envío.
 */

export type EmailEntrante = {
  /** Dirección del remitente, en minúsculas. */
  fromAddress: string;
  /** Nombre visible del `From:`, si vino. */
  fromName: string | null;
  subject: string | null;
  /** Cuerpo en texto plano (del `text/plain` o des-etiquetado del HTML). */
  text: string | null;
  /** El `Date:` del correo. */
  date: Date;
  /** El `Message-ID` (idempotencia). */
  messageId: string;
  inReplyTo: string | null;
};

/** Devuelve true si el correo entró; false si ya estaba (duplicado). */
export async function ingestEmailMessage(
  organizationId: string,
  correo: EmailEntrante
): Promise<boolean> {
  const db = getDb();

  const { contact } = await getOrCreateContactByIdentity(organizationId, {
    identity: `${EMAIL_PREFIX}${correo.fromAddress}`,
    channel: "email",
    phone: null,
    waUserId: null,
    profileName: correo.fromName,
  });
  const conversation = await getOrCreateConversation(
    organizationId,
    contact.id,
    { channel: "email" }
  );

  const inserted = await db
    .insert(schema.message)
    .values({
      id: newId("message"),
      organizationId,
      conversationId: conversation.id,
      emailMessageId: correo.messageId,
      direction: "in",
      type: "text",
      text: correo.text,
      status: "delivered",
      emailSubject: correo.subject,
      emailInReplyTo: correo.inReplyTo,
      waTimestamp: correo.date,
    })
    .onConflictDoNothing({ target: [schema.message.emailMessageId] })
    .returning();
  const message = inserted[0];
  if (!message) return false; // duplicado: ya lo había traído otro barrido

  await db
    .update(schema.conversation)
    .set({
      lastInboundAt: correo.date,
      lastMessageAt: correo.date,
      unreadCount: sql`${schema.conversation.unreadCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(schema.conversation.id, conversation.id));

  await onLeadActivity(organizationId, contact.id, correo.date);

  publish(organizationId, {
    type: "message.new",
    data: {
      conversationId: conversation.id,
      message: serializeMessage(message),
    },
  });
  publish(organizationId, {
    type: "conversation.updated",
    data: { conversation: { id: conversation.id } },
  });

  // 031 — El agente responde correos RECIENTES (≤72 h desde que el cliente
  // lo escribió). Un correo viejo que entra tarde (buzón recién conectado,
  // servidor caído) lo atiende una persona: que la IA conteste hoy algo de
  // hace una semana se lee como descuido, no como eficiencia.
  const SETENTA_Y_DOS_HORAS_MS = 72 * 60 * 60 * 1000;
  if (Date.now() - correo.date.getTime() <= SETENTA_Y_DOS_HORAS_MS) {
    await maybeRunAgentTurn(conversation.id, organizationId, message.id);
  }

  return true;
}
