import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { getEnv } from "@/lib/env";
import {
  apiKeyLast4,
  getWhatsappKapsoCredentialsByOrg,
  saveWhatsappKapsoCredentials,
} from "@/server/whatsapp/credentials-kapso";
import { validarNumeroKapso } from "@/server/kapso/validar";

export const dynamic = "force-dynamic";

/**
 * 046 — Conexión de WhatsApp por Kapso (BSP oficial de Meta).
 *
 * Igual que con Zernio: WhatsApp está siempre encendido, así que esta ruta no
 * tiene la guarda de canal de los sociales, y vive aparte de
 * `/api/settings/whatsapp` porque el transporte de Kapso guarda sus
 * credenciales en su propia tabla.
 *
 * La llave nunca sale entera. Desconectar borra solo la fila: las
 * conversaciones son de la organización, no de la conexión.
 */

/** Estado de la conexión (la llave nunca sale entera). */
export const GET = withAuth(async (session) => {
  const creds = await getWhatsappKapsoCredentialsByOrg(session.organizationId);
  if (!creds) return Response.json({ connection: null });
  return Response.json({
    connection: {
      source: creds.source,
      phoneNumberId: creds.phoneNumberId,
      wabaId: creds.wabaId,
      displayName: creds.displayName,
      status: creds.status,
      apiKeyLast4: apiKeyLast4(creds.apiKey),
      hasWebhookSecret: Boolean(creds.webhookSecret),
    },
  });
});

const putSchema = z.object({
  /** `phone_number_id` del número en Kapso. */
  phoneNumberId: z.string().trim().min(1),
  /** Llave de proyecto de Kapso (header `X-API-Key`). */
  apiKey: z.string().trim().min(1),
  /** Secreto HMAC que Kapso genera al crear el webhook hacia Vocero. */
  webhookSecret: z.string().trim().min(1),
});

/**
 * Guarda la conexión validando ANTES la llave contra Kapso: una llave que no
 * sirve (o que no calza con el número) no llega a la base. Solo el
 * propietario de la organización puede hacerlo. Devuelve la URL del webhook
 * para pegarla en el panel de Kapso.
 */
export const PUT = withAuth(async (session, req: Request) => {
  if (session.role !== "owner") {
    return apiError(403, "forbidden", "Solo el propietario puede conectar WhatsApp por Kapso");
  }
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;

  const validacion = await validarNumeroKapso(
    body.data.apiKey,
    body.data.phoneNumberId
  );
  if (!validacion.ok) {
    return apiError(
      validacion.falla.status,
      validacion.falla.code,
      validacion.falla.message
    );
  }

  await saveWhatsappKapsoCredentials({
    organizationId: session.organizationId,
    phoneNumberId: body.data.phoneNumberId,
    wabaId: validacion.numero.wabaId,
    displayName: validacion.numero.displayName,
    apiKey: body.data.apiKey,
    webhookSecret: body.data.webhookSecret,
  });

  const webhookUrl = `${getEnv().APP_BASE_URL}/api/webhooks/kapso/${encodeURIComponent(body.data.phoneNumberId)}`;
  return Response.json({
    ok: true,
    phoneNumberId: body.data.phoneNumberId,
    wabaId: validacion.numero.wabaId,
    displayName: validacion.numero.displayName,
    webhookUrl,
  });
});

/**
 * Desconectar el transporte Kapso. No borra la bandeja: las conversaciones
 * son de la organización, no de la conexión. Idempotente: sin conexión
 * responde 200 igual.
 */
export const DELETE = withAuth(async (session) => {
  if (session.role !== "owner") {
    return apiError(403, "forbidden", "Solo el propietario puede desconectar WhatsApp por Kapso");
  }
  await getDb()
    .delete(schema.whatsappKapsoCredentials)
    .where(
      scoped(schema.whatsappKapsoCredentials.organizationId, session.organizationId)
    );
  return Response.json({ ok: true });
});
