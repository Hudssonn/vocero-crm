import { apiError, parseBody, withAuth } from "@/lib/api";
import {
  channelDisabledResponse,
  isChannelEnabled,
} from "@/server/channels/enabled";
import { datosEfectivos, emailBodySchema } from "@/server/email/validacion";
import { probarBuzon } from "@/server/email/probar";

export const dynamic = "force-dynamic";

/**
 * 031 — Probar el buzón del formulario SIN guardar nada: la contraseña
 * mala no puede quedar persistida por accidente (decisión del diseño).
 */
export const POST = withAuth(async (session, req: Request) => {
  if (!isChannelEnabled("email")) return channelDisabledResponse();
  if (session.role !== "owner") {
    return apiError(403, "forbidden", "Solo el propietario puede probar el correo");
  }
  const body = await parseBody(req, emailBodySchema);
  if (!body.ok) return body.response;

  const efectivos = await datosEfectivos(session.organizationId, body.data);
  if (!efectivos.ok) return efectivos.response;

  try {
    const resultado = await probarBuzon(efectivos.datos);
    return Response.json({ ok: true, ...resultado });
  } catch (err) {
    return apiError(
      422,
      "email_test_failed",
      err instanceof Error ? err.message : "La prueba de conexión falló"
    );
  }
});
