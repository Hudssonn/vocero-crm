import { z } from "zod";
import { eq } from "drizzle-orm";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import {
  getWhatsappZernioCredentialsByOrg,
  saveWhatsappZernioCredentials,
  tokenLast4,
} from "@/server/whatsapp/credentials-zernio";
import { ensureWebhookForOrg } from "@/server/zernio/conexiones";
import { accountHealth, zernioAccountName } from "@/server/zernio/cuentas";
import { resolveZernioAccount } from "@/server/zernio/guardar";

export const dynamic = "force-dynamic";

/**
 * 032 — Conexión de WhatsApp por Zernio.
 *
 * WhatsApp está siempre encendido, así que esta ruta no tiene la guarda de
 * canal de los sociales. Vive aparte de `/api/settings/whatsapp` porque el
 * transporte de Meta y el de Zernio guardan sus credenciales en tablas
 * distintas: mezclarlos en una sola ruta sería mezclar dos conexiones.
 *
 * La llave nunca sale entera. Desconectar borra solo la fila: el webhook de
 * Zernio es compartido por llave y puede servir a otros canales, así que se
 * queda; sin fila, lo que llegue por esa cuenta se descarta con aviso.
 */

/** Estado de la conexión (la llave nunca sale entera). */
export const GET = withAuth(async (session) => {
  const creds = await getWhatsappZernioCredentialsByOrg(session.organizationId);
  if (!creds) return Response.json({ connection: null });
  return Response.json({
    connection: {
      source: creds.source,
      accountRef: creds.accountRef,
      displayName: creds.displayName,
      status: creds.status,
      tokenLast4: tokenLast4(creds.token),
      hasWebhookSecret: Boolean(creds.webhookSecret),
    },
  });
});

const putSchema = z.object({
  /**
   * `accountId` de la cuenta de WhatsApp en Zernio. Opcional si la llave
   * tiene una sola cuenta de WhatsApp (023).
   */
  accountRef: z.string().trim().min(1).nullish(),
  token: z.string().trim().min(1),
  webhookSecret: z.string().trim().min(1).nullish(),
});

/**
 * Guarda la conexión validando ANTES la llave contra Zernio, igual que los
 * demás canales: una llave que no sirve no llega a la base. Solo el
 * propietario de la organización puede hacerlo.
 */
export const PUT = withAuth(async (session, req: Request) => {
  if (session.role !== "owner") {
    return apiError(403, "forbidden", "Solo el propietario puede conectar WhatsApp por Zernio");
  }
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;

  // 023: la cuenta se resuelve contra Zernio, no se guarda a ciegas.
  const cuenta = await resolveZernioAccount(body.data.token, body.data.accountRef, "whatsapp");
  if (!cuenta.ok) return cuenta.response;

  const previa = await getWhatsappZernioCredentialsByOrg(session.organizationId);
  const displayName = zernioAccountName(cuenta.account);
  await saveWhatsappZernioCredentials({
    organizationId: session.organizationId,
    accountRef: cuenta.account._id,
    displayName,
    token: body.data.token,
    // Sin secreto nuevo se conserva el que había: reconectar no debe apagar
    // la verificación de firma.
    webhookSecret: body.data.webhookSecret ?? previa?.webhookSecret ?? null,
  });
  const webhook = await ensureWebhookForOrg(session.organizationId, {
    secret: body.data.webhookSecret ?? previa?.webhookSecret ?? null,
  });

  return Response.json({
    ok: true,
    displayName,
    accountRef: cuenta.account._id,
    accountName: displayName,
    health: accountHealth(cuenta.account, "whatsapp"),
    webhook,
  });
});

/**
 * Desconectar el transporte Zernio. No borra la bandeja: las conversaciones
 * son de la organización, no de la conexión. Idempotente: sin conexión
 * responde 200 igual.
 */
export const DELETE = withAuth(async (session) => {
  if (session.role !== "owner") {
    return apiError(403, "forbidden", "Solo el propietario puede desconectar WhatsApp por Zernio");
  }
  await getDb()
    .delete(schema.whatsappZernioCredentials)
    .where(eq(schema.whatsappZernioCredentials.organizationId, session.organizationId));
  return Response.json({ ok: true });
});
