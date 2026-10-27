import { apiError, parseBody, withAuth } from "@/lib/api";
import {
  channelDisabledResponse,
  isChannelEnabled,
} from "@/server/channels/enabled";
import {
  deleteEmailCredentials,
  getEmailCredentialsByOrg,
  saveEmailCredentials,
} from "@/server/email/credentials";
import { probarBuzon } from "@/server/email/probar";
import { datosEfectivos, emailBodySchema } from "@/server/email/validacion";

export const dynamic = "force-dynamic";

/**
 * 031 — El buzón del negocio: estado, conexión y desconexión.
 *
 * La contraseña nunca sale (ni cifrada): hacia fuera van los datos del
 * servidor y la salud del sondeo. Guardar prueba ANTES contra el buzón,
 * como en los demás canales; si la prueba falla no se guarda nada.
 */

export const GET = withAuth(async (session) => {
  if (!isChannelEnabled("email")) return channelDisabledResponse();
  const creds = await getEmailCredentialsByOrg(session.organizationId);
  if (!creds) return Response.json({ connection: null });
  return Response.json({
    connection: {
      emailAddress: creds.emailAddress,
      displayName: creds.displayName,
      imapHost: creds.imapHost,
      imapPort: creds.imapPort,
      imapSecure: creds.imapSecure,
      smtpHost: creds.smtpHost,
      smtpPort: creds.smtpPort,
      smtpSecure: creds.smtpSecure,
      username: creds.username,
      status: creds.status,
      lastError: creds.lastError,
      lastCheckAt: creds.lastCheckAt?.toISOString() ?? null,
    },
  });
});

export const PUT = withAuth(async (session, req: Request) => {
  if (!isChannelEnabled("email")) return channelDisabledResponse();
  if (session.role !== "owner") {
    return apiError(403, "forbidden", "Solo el propietario puede conectar el correo");
  }
  const body = await parseBody(req, emailBodySchema);
  if (!body.ok) return body.response;

  const efectivos = await datosEfectivos(session.organizationId, body.data);
  if (!efectivos.ok) return efectivos.response;

  try {
    await probarBuzon(efectivos.datos);
  } catch (err) {
    return apiError(
      422,
      "email_test_failed",
      err instanceof Error ? err.message : "La prueba de conexión falló"
    );
  }

  await saveEmailCredentials({
    organizationId: session.organizationId,
    emailAddress: body.data.emailAddress.toLowerCase(),
    displayName: body.data.displayName?.trim() || null,
    imapHost: body.data.imapHost,
    imapPort: body.data.imapPort,
    imapSecure: body.data.imapSecure,
    smtpHost: body.data.smtpHost,
    smtpPort: body.data.smtpPort,
    smtpSecure: body.data.smtpSecure,
    username: body.data.username,
    password: efectivos.esNueva ? efectivos.datos.password : undefined,
  });

  return Response.json({ ok: true });
});

export const DELETE = withAuth(async (session) => {
  if (!isChannelEnabled("email")) return channelDisabledResponse();
  if (session.role !== "owner") {
    return apiError(403, "forbidden", "Solo el propietario puede desconectar el correo");
  }
  await deleteEmailCredentials(session.organizationId);
  return Response.json({ ok: true });
});
