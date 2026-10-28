import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { createLeadForContact } from "@/server/inbox/lead-activity";
import { getOrCreateContactByIdentity } from "@/server/inbox/identity";
import { getOrCreateConversation } from "@/server/inbox/ingest";

/**
 * 033 — Pedidos del menú QR de restaurantes.
 *
 * CONTRATO: el menú (QR por mesa) manda cada pedido como JSON estructurado
 * y el endpoint lo convierte en contacto + conversación + mensaje + lead en
 * la etapa "Nuevo pedido". Sin migración: reusa las tablas que ya existen.
 *
 * DECISIONES (piloto, documentadas para no confundirlas con el modelo final):
 * - Un contacto por pedido (`menu:<orderId>`). La tabla de leads admite UN
 *   lead por contacto, así que compartir contacto entre pedidos impediría
 *   ver cada pedido como tarjeta en el pipeline.
 * - Canal `whatsapp`: el enum de canales no tiene `menu`. El origen queda
 *   escrito en el texto del pedido ("Pedido desde el menú QR"), y por
 *   WhatsApp es por donde la soda da seguimiento. Un canal `menu` propio
 *   sería una migración y queda como evolución, no como piloto.
 * - Idempotencia por `orderId`: reintentar el mismo pedido devuelve lo ya
 *   creado, sin duplicar contacto, conversación, mensaje ni lead.
 * - Las etapas se agregan AL FINAL de las que ya tenga la organización
 *   (nunca se reordenan ni se tocan las existentes).
 */

export const menuOrderItemSchema = z.object({
  nombre: z.string().min(1),
  cantidad: z.number().int().min(1),
  nota: z.string().nullish(),
  extras: z.array(z.string()),
});

export const menuOrderSchema = z
  .object({
    orderId: z.string().min(1),
    mesa: z.number().int().min(1).nullish(),
    paraLlevar: z.boolean(),
    codigo: z.string().nullish(),
    items: z.array(menuOrderItemSchema).min(1),
    total: z.number().min(0),
    // 037 — Entrega y pago. Todo opcional: un menú viejo que no las mande
    // sigue pasando igual que antes. Sin costo de delivery, zonas ni
    // mínimo de compra: eso no entra en este contrato.
    entrega: z.enum(["retiro", "delivery"]).nullish(),
    direccion: z.string().nullish(),
    pago: z.enum(["sinpe", "repartidor", "local"]).nullish(),
    conCuanto: z.number().min(0).nullish(),
    // 038 — Nombre y celular del cliente. AMBOS opcionales en la API a
    // propósito: una página vieja en caché que no los mande debe seguir
    // funcionando; el obligatorio se impone en la página nueva, no aquí.
    nombre: z.string().nullish(),
    telefono: z.string().nullish(),
  })
  .refine((d) => (d.paraLlevar ? !!d.codigo : d.mesa != null), {
    message: "mesa o código para llevar requerido",
  })
  .refine(
    (d) =>
      d.entrega !== "delivery" ||
      (d.direccion != null && d.direccion.trim().length > 0),
    {
      message: "dirección requerida para delivery",
    },
  );

export type MenuOrderInput = z.infer<typeof menuOrderSchema>;
export type MenuOrderItem = z.infer<typeof menuOrderItemSchema>;

/**
 * Etapas del pipeline de pedidos, en orden. `won` es el ancla final.
 * 036 — El pipeline es solo esto: Nuevo pedido → En preparación → Listo
 * → Entregado. El cobro se hace en caja y no es una etapa; para cancelar
 * un pedido ya no hay columna (se borra la tarjeta). La pantalla de cocina
 * sigue mostrando solo Nuevos y En preparación; `Entregado` se mueve en
 * el pipeline de Vocero.
 */
export const ORDER_STAGES = [
  { name: "Nuevo pedido", kind: "open" },
  { name: "En preparación", kind: "open" },
  { name: "Listo", kind: "open" },
  { name: "Entregado", kind: "won" },
] as const;

/** Identidad estable del contacto de un pedido: un pedido, un contacto. */
export function orderContactIdentity(orderId: string): string {
  return `menu:${orderId}`;
}

export function orderContactName(input: MenuOrderInput): string {
  // 038 (corrección del dueño) — El nombre del contacto NO es solo el
  // nombre del cliente: dice LA MESA Y EL NOMBRE juntos, porque si no
  // dice la mesa es difícil entregar. Formato uniforme: identificador
  // actual + " · " + nombre del cliente. Sin nombre (pedido viejo o
  // página vieja en caché), queda la lógica actual sin cambios.
  const base =
    input.paraLlevar && input.entrega === "delivery"
      ? `Delivery ${input.codigo}`
      : input.paraLlevar
        ? `Para llevar ${input.codigo}`
        : `Mesa ${input.mesa}`;
  const nombre = input.nombre?.trim();
  return nombre ? `${base} · ${nombre}` : base;
}

/**
 * 037 — Cómo se lee el pago en el texto del pedido. El pago en
 * efectivo (repartidor o local) es el único que admite "con cuánto":
 * el SINPE ya viene pagado y no pregunta vuelto.
 */
const PAGO_TEXTO = {
  sinpe: "Pago: SINPE de una vez",
  repartidor: "Pago: Al repartidor",
  local: "Pago: En el local",
} as const;

export function formatOrderText(input: MenuOrderInput): string {
  const lines = ["Pedido desde el menú QR"];
  if (input.paraLlevar && input.entrega === "delivery") {
    lines.push(`DELIVERY: ${input.codigo}`);
    lines.push(`Dirección: ${input.direccion}`);
  } else {
    lines.push(
      input.paraLlevar ? `PARA LLEVAR: ${input.codigo}` : `MESA: ${input.mesa}`,
    );
  }
  // 038 — Cliente y celular, justo después del encabezado de mesa/delivery
  // (incluida la dirección) y antes de los platos. La línea MESA: N SE
  // QUEDA: la cocina necesita saber la mesa; lo que cambia es el NOMBRE
  // del contacto, no el texto de la mesa. El teléfono viaja SOLO en el
  // texto: nunca se escribe en `contact.phone` (los contactos del menú
  // no son contactos de WhatsApp y no se les debe poder enviar nada por
  // ese campo). Sin nombre ni teléfono, no se agregan líneas vacías.
  const nombre = input.nombre?.trim();
  if (nombre) lines.push(`Cliente: ${nombre}`);
  const telefono = input.telefono?.trim();
  if (telefono) lines.push(`Celular: ${telefono}`);
  for (const item of input.items) {
    let line = `${item.cantidad}x ${item.nombre}`;
    if (item.nota) line += ` — ${item.nota}`;
    if (item.extras.length > 0) line += ` — extras: ${item.extras.join(", ")}`;
    lines.push(line);
  }
  if (input.pago) lines.push(PAGO_TEXTO[input.pago]);
  if (input.conCuanto != null) {
    lines.push(`Con cuánto cancela: ₡${input.conCuanto}`);
  }
  lines.push(`Total: ₡${input.total}`);
  return lines.join("\n");
}

/**
 * Crea las etapas de pedidos que falten, al final de las existentes.
 * Devuelve el id de cada etapa por nombre.
 */
export async function ensureOrderStages(
  organizationId: string,
): Promise<Map<string, string>> {
  const db = getDb();
  const existing = await db
    .select({
      id: schema.pipelineStage.id,
      name: schema.pipelineStage.name,
      position: schema.pipelineStage.position,
    })
    .from(schema.pipelineStage)
    .where(scoped(schema.pipelineStage.organizationId, organizationId))
    .orderBy(asc(schema.pipelineStage.position));

  const byName = new Map(existing.map((s) => [s.name, s.id]));
  let nextPos = existing.reduce((max, s) => Math.max(max, s.position), -1) + 1;
  for (const stage of ORDER_STAGES) {
    if (byName.has(stage.name)) continue;
    const inserted = await db
      .insert(schema.pipelineStage)
      .values({
        id: newId("stage"),
        organizationId,
        name: stage.name,
        position: nextPos,
        kind: stage.kind,
      })
      .returning({ id: schema.pipelineStage.id });
    nextPos += 1;
    if (inserted[0]) byName.set(stage.name, inserted[0].id);
  }
  return byName;
}

export type MenuOrderResult = {
  leadId: string;
  conversationId: string;
  contactId: string;
  stageId: string;
  duplicate: boolean;
};

/**
 * Convierte un pedido del menú en contacto + conversación + mensaje + lead.
 * Reintentar el mismo `orderId` devuelve lo ya creado, sin duplicar nada.
 */
export async function createMenuOrder(
  organizationId: string,
  input: MenuOrderInput,
): Promise<MenuOrderResult> {
  const db = getDb();
  const stages = await ensureOrderStages(organizationId);
  const nuevoPedidoId = stages.get("Nuevo pedido");
  if (!nuevoPedidoId) throw new Error("etapa Nuevo pedido no disponible");

  const { contact } = await getOrCreateContactByIdentity(organizationId, {
    identity: orderContactIdentity(input.orderId),
    channel: "whatsapp",
    phone: null,
    waUserId: null,
    profileName: orderContactName(input),
  });

  const conversation = await getOrCreateConversation(
    organizationId,
    contact.id,
    { channel: "whatsapp" },
  );

  const existingMessages = await db
    .select({ id: schema.message.id })
    .from(schema.message)
    .where(
      scoped(
        schema.message.organizationId,
        organizationId,
        eq(schema.message.conversationId, conversation.id),
      ),
    )
    .limit(1);

  if (existingMessages.length === 0) {
    await db.insert(schema.message).values({
      id: newId("message"),
      organizationId,
      conversationId: conversation.id,
      direction: "in",
      type: "text",
      text: formatOrderText(input),
      status: "delivered",
    });
  }

  const created = await createLeadForContact({
    organizationId,
    contactId: contact.id,
    stageId: nuevoPedidoId,
    source: "sistema",
  });
  if (created) {
    return {
      leadId: created.id,
      conversationId: conversation.id,
      contactId: contact.id,
      stageId: created.stageId,
      duplicate: false,
    };
  }

  const existingLeads = await db
    .select({ id: schema.lead.id })
    .from(schema.lead)
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        eq(schema.lead.contactId, contact.id),
      ),
    )
    .limit(1);
  if (!existingLeads[0]) throw new Error("lead no encontrado tras upsert");
  return {
    leadId: existingLeads[0].id,
    conversationId: conversation.id,
    contactId: contact.id,
    stageId: nuevoPedidoId,
    duplicate: true,
  };
}
