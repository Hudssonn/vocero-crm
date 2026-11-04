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
 * - El precio mensual NO se confía del frontend: se recalcula en el backend
 *   con `calcularPrecioMensual` (base ₡25.000 + ₡10.000 por módulo, paquete
 *   completo ₡50.000 con 4 módulos, VIP web +₡20.000) y entra como monto del
 *   lead (centavos, moneda de la marca): el pipeline muestra cuánto vale
 *   cada oportunidad. El `precioMensual` del request solo se acepta por
 *   compatibilidad de contrato y se valida finito y positivo.
 * - Idempotencia por contacto: `lead_contact_uq` impide dos leads del mismo
 *   contacto; un segundo diagnóstico del mismo teléfono actualiza la ficha
 *   y devuelve el lead existente (duplicate: true).
 */
export const diagnosticoSchema = z.object({
  tipoNegocio: z.string().min(1, "tipoNegocio requerido").max(60),
  tipoNegocioOtro: z.string().max(60).nullish(),
  problemas: z.array(z.string().min(1).max(200)).min(1, "al menos un problema"),
  problemasOtros: z.string().max(120).nullish(),
  vipWeb: z.boolean().nullish(),
  canales: z.array(z.string().max(60)).nullish(),
  modulos: z.array(z.string().max(120)).nullish(),
  // El precio que manda el frontend NO se confía: el endpoint es público y
  // por curl se podría mandar cualquier valor (BUG 3). El backend lo
  // recalcula con `calcularPrecioMensual` y guarda ese valor; el campo se
  // acepta por compatibilidad de contrato y se valida finito y positivo.
  precioMensual: z
    .number()
    .positive("precioMensual debe ser positivo")
    .finite("precioMensual debe ser un número finito"),
  nombre: z.string().max(120).nullish(),
  nombreNegocio: z.string().max(120).nullish(),
  telefono: z.string().max(30).nullish(),
  email: z.string().max(160).nullish(),
  horario: z.string().max(80).nullish(),
  volumenWhatsapp: z.string().max(60).nullish(),
});

export type DiagnosticoInput = z.infer<typeof diagnosticoSchema>;

/** Identidad estable del contacto de un diagnóstico sin teléfono: única por envío. */export function diagnosticoIdentity(): string {
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

/* ---------- Precios de SolidGround (replica del backend de la herramienta) ----------
 * Base ₡25.000/mes (Agente WhatsApp 24/7 + CRM); +₡10.000 por módulo; con 4 o
 * más módulos aplica el paquete completo de ₡50.000; el servicio VIP web
 * (página profesional) suma ₡20.000/mes. Copia la regla de la herramienta de
 * diagnóstico (`~/workspace/diagnostico-solidground/index.html`): el frontend
 * la usa para mostrar el total, el backend la usa para guardar el precio real.
 */
const PRECIO_BASE = 25_000;
const PRECIO_MODULO = 10_000;
const PRECIO_PAQUETE_COMPLETO = 50_000;
const PRECIO_VIP_WEB = 20_000;
const MODULOS_PAQUETE_COMPLETO = 4;

/**
 * Calcula el precio mensual de un diagnóstico en el backend, IGNORANDO el
 * precio que manda el frontend (el endpoint es público: un atacante puede
 * mandar por curl ₡1 o ₡999.999.999). Función pura y testeable.
 *
 * Regla: con 4 o más módulos distintos aplica el paquete completo (₡50.000);
 * si no, base + ₡10.000 por módulo; el VIP web suma ₡20.000.
 */
export function calcularPrecioMensual(
  modulos: readonly string[] | null | undefined,
  vipWeb: boolean | null | undefined,
): number {
  const unicos = new Set(
    (modulos ?? [])
      .map((m) => m.trim().toLowerCase())
      .filter((m) => m.length > 0),
  );
  const cantidad = unicos.size;
  const base =
    cantidad >= MODULOS_PAQUETE_COMPLETO
      ? PRECIO_PAQUETE_COMPLETO
      : PRECIO_BASE + cantidad * PRECIO_MODULO;
  return base + (vipWeb ? PRECIO_VIP_WEB : 0);
}

/**
 * Devuelve el input del diagnóstico con el precio recalculado por el backend.
 * Es lo que se guarda en la ficha, el mensaje y el monto del lead: el
 * `precioMensual` del request nunca llega a persistirse.
 */
export function aplicarPrecioBackend(input: DiagnosticoInput): DiagnosticoInput {
  return {
    ...input,
    precioMensual: calcularPrecioMensual(input.modulos, input.vipWeb),
  };
}

/**
 * Texto del diagnóstico para el mensaje de la conversación: lo que el dueño
 * lee en la bandeja cuando entra el lead.
 */
export function formatDiagnosticoText(input: DiagnosticoInput): string {
  const lines = ["Diagnóstico web — SolidGround"];
  lines.push(`Negocio: ${etiquetaNegocio(input)}`);
  const nombre = input.nombre?.trim();
  if (nombre) lines.push(`Nombre: ${nombre}`);
  const nombreNegocio = input.nombreNegocio?.trim();
  if (nombreNegocio) lines.push(`Nombre del negocio: ${nombreNegocio}`);
  const telefono = input.telefono?.trim();
  if (telefono) lines.push(`Teléfono: ${telefono}`);
  const email = input.email?.trim();
  if (email) lines.push(`Correo: ${email}`);
  const horario = input.horario?.trim();
  if (horario) lines.push(`Horario: ${horario}`);
  const volumenWhatsapp = input.volumenWhatsapp?.trim();
  if (volumenWhatsapp) lines.push(`WhatsApp/día: ${volumenWhatsapp}`);
  const canales = input.canales ?? [];
  if (canales.length > 0) lines.push(`Canales: ${canales.join(", ")}`);
  lines.push("Problemas:");
  for (const p of input.problemas) lines.push(`- ${p}`);
  const problemasOtros = input.problemasOtros?.trim();
  if (problemasOtros) lines.push(`Otros problemas: ${problemasOtros}`);
  if (input.vipWeb) lines.push(`Servicio VIP web: Sí (+₡20.000/mes)`);
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

  // BUG 3: el precio nunca sale del request. Se recalcula en el backend a
  // partir de los módulos y el VIP; de aquí en adelante todo (ficha, mensaje
  // y monto del lead) usa el precio recalculado.
  const seguro = aplicarPrecioBackend(input);
  const precioMensual = seguro.precioMensual;

  const telefono = seguro.telefono?.trim() || null;
  const nombre = seguro.nombre?.trim() || null;
  const canales = seguro.canales ?? [];
  const modulos = seguro.modulos ?? [];

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
  // NOTA: la ficha solo acepta escalares (normalizeFicha ignora objetos),
  // así que las claves van aplanadas con prefijo `diagnostico_`.
  await upsertFicha({
    organizationId,
    contactId: contact.id,
    ficha: {
      diagnostico_tipoNegocio: etiquetaNegocio(input),
      diagnostico_nombreNegocio: input.nombreNegocio?.trim() || null,
      diagnostico_horario: input.horario?.trim() || null,
      diagnostico_volumenWhatsapp: input.volumenWhatsapp?.trim() || null,
      diagnostico_problemas: input.problemas.join(", "),
      diagnostico_problemasOtros: input.problemasOtros?.trim() || null,
      diagnostico_vipWeb: input.vipWeb ? true : null,
      diagnostico_modulos: modulos.join(", "),
      diagnostico_canales: canales.join(", "),
      diagnostico_precioMensual: precioMensual,
      diagnostico_fecha: new Date().toISOString(),
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
      text: formatDiagnosticoText(seguro),
      status: "delivered",
    });
  }

  const currency = (await getBranding(organizationId)).currency;
  const created = await createLeadForContact({
    organizationId,
    contactId: contact.id,
    at: new Date(),
    source: "sistema",
    amountCents: colonesACentavos(precioMensual),
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
