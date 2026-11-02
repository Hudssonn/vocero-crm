import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import {
  getOrCreateContactByIdentity,
  parseIdentity,
  type ResolvedIdentity,
} from "@/server/inbox/identity";
import { getOrCreateConversation } from "@/server/inbox/ingest";
import { createLeadForContact } from "@/server/inbox/lead-activity";
import { upsertFicha } from "@/server/bot/ficha";
import { getBranding } from "@/server/branding";
import { colonesACentavos } from "@/server/leads/amount";

/**
 * 049 — Diagnóstico de ventas: la herramienta web de diagnóstico manda el
 * resultado del prospecto y Vocero lo convierte en contacto + conversación +
 * mensaje + lead en la primera etapa abierta del pipeline.
 *
 * Endpoint público (sin API key): los prospectos no tienen credencial, así
 * que la validación es estricta y el rate limit va por IP en la ruta.
 * Sin migración: reusa contacto (ficha), conversación, mensaje y lead.
 *
 * DECISIONES:
 * - Un diagnóstico, un contacto: si el prospecto da teléfono se vincula por
 *   identidad (reconciliación de la ingesta); si no, identidad única
 *   `diagnostico:<id>` para no mezclar prospectos anónimos.
 * - El diagnóstico vive en la ficha del contacto (llave `diagnostico`) y en
 *   el texto del primer mensaje: lo que el dueño ve en la bandeja.
 * - El precio mensual entra como monto del lead (centavos, moneda de la
 *   marca): el pipeline muestra cuánto vale cada oportunidad.
 * - Idempotencia por contacto: `lead_contact_uq` impide dos leads del mismo
 *   contacto; un segundo diagnóstico del mismo teléfono actualiza la ficha
 *   y devuelve el lead existente (duplicate: true).
 */
export const diagnosticoSchema = z.object({
  tipoNegocio: z.string().min(1, "tipoNegocio requerido").max(60),
  tipoNegocioOtro: z.string().max(60).nullish(),
  problemas: z.array(z.string().min(1).max(200)).min(1, "al menos un problema"),
  canales: z.array(z.string().max(60)).nullish(),
  modulos: z.array(z.string().max(120)).nullish(),
  precioMensual: z.number().positive("precioMensual debe ser positivo"),
  nombre: z.string().max(120).nullish(),
  telefono: z.string().max(30).nullish(),
  email: z.string().max(160).nullish(),
});

export type DiagnosticoInput = z.infer<typeof diagnosticoSchema>;

/** Identidad estable del contacto de un diagnóstico sin teléfono: única por envío. */
export function diagnosticoIdentity(): string {
  const sufijo = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `diagnostico:${sufijo}`;
}

/** Etiqueta del negocio: el texto libre de "Otro" cuando viene, si no el id. */
export function etiquetaNegocio(input: DiagnosticoInput): string {
  const otro = input.tipoNegocioOtro?.trim();
  if (input.tipoNegocio === "otro" && otro) return otro;
  return input.tipoNegocio;
}

const fmtColones = (n: number) =>
  `₡${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;

/**
 * Texto del diagnóstico para el mensaje de la conversación: lo que el dueño
 * lee en la bandeja cuando entra el lead.
 */
export function formatDiagnosticoText(input: DiagnosticoInput): string {
  const lines = ["Diagnóstico web — SolidGround"];
  lines.push(`Negocio: ${etiquetaNegocio(input)}`);
  const nombre = input.nombre?.trim();
  if (nombre) lines.push(`Nombre: ${nombre}`);
  const telefono = input.telefono?.trim();
  if (telefono) lines.push(`Teléfono: ${telefono}`);
  const email = input.email?.trim();
  if (email) lines.push(`Correo: ${email}`);
  const canales = input.canales ?? [];
  if (canales.length > 0) lines.push(`Canales: ${canales.join(", ")}`);
  lines.push("Problemas:");
  for (const p of input.problemas) lines.push(`- ${p}`);
  const modulos = input.modulos ?? [];
  if (modulos.length > 0) {
    lines.push("Módulos recomendados:");
    for (const m of modulos) lines.push(`- ${m}`);
  }
  lines.push(`Precio mensual: ${fmtColones(input.precioMensual)}`);
  return lines.join("\n");
}

export type DiagnosticoResult = {
  leadId: string;
  conversationId: string;
  contactId: string;
  duplicate: boolean;
};

/**
 * Registra un diagnóstico: contacto (+ficha) + conversación + mensaje + lead.
 */
export async function registrarDiagnostico(
  organizationId: string,
  input: DiagnosticoInput,
): Promise<DiagnosticoResult> {
  const db = getDb();

  const telefono = input.telefono?.trim() || null;
  const nombre = input.nombre?.trim() || null;
  const canales = input.canales ?? [];
  const modulos = input.modulos ?? [];

  let resolved: ResolvedIdentity;
  if (telefono) {
    const parsed = parseIdentity(telefono);
    resolved = {
      identity: parsed?.identity ?? telefono,
      channel: "whatsapp",
      phone: parsed?.phone ?? telefono,
      waUserId: null,
      profileName: nombre ?? "Diagnóstico web",
    };
  } else {
    resolved = {
      identity: diagnosticoIdentity(),
      channel: "whatsapp",
      phone: null,
      waUserId: null,
      profileName: nombre ?? "Diagnóstico web",
    };
  }

  const { contact } = await getOrCreateContactByIdentity(organizationId, resolved);

  // El diagnóstico queda en la ficha: la calificación del prospecto.
  await upsertFicha({
    organizationId,
    contactId: contact.id,
    ficha: {
      diagnostico: {
        tipoNegocio: etiquetaNegocio(input),
        problemas: input.problemas,
        modulos,
        canales,
        precioMensual: input.precioMensual,
        fecha: new Date().toISOString(),
      },
    },
  });

  const conversation = await getOrCreateConversation(organizationId, contact.id, {
    channel: "whatsapp",
  });

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
      text: formatDiagnosticoText(input),
      status: "delivered",
    });
  }

  const currency = (await getBranding(organizationId)).currency;
  const created = await createLeadForContact({
    organizationId,
    contactId: contact.id,
    at: new Date(),
    source: "sistema",
    amountCents: colonesACentavos(input.precioMensual),
    currency,
  });
  if (created) {
    return {
      leadId: created.id,
      conversationId: conversation.id,
      contactId: contact.id,
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
    duplicate: true,
  };
}
