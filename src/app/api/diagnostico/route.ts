import { apiError, parseBody } from "@/lib/api";
import { clientIp, checkRateLimit } from "@/lib/rate-limit";
import { resolveInstanceOrg } from "@/server/bot/auth";
import {
  diagnosticoSchema,
  registrarDiagnostico,
} from "@/server/diagnostico/service";

export const dynamic = "force-dynamic";

/**
 * 049 — Entrada de diagnósticos de la herramienta web de ventas.
 *
 * CONTRATO: público, sin API key (los prospectos no tienen credencial).
 * Crear responde **201**; repetir el mismo teléfono devuelve el lead ya
 * creado con **200** (`duplicate: true`), sin duplicar nada. El error va
 * anidado (`{"error":{"code":…}}`). Solo POST.
 * Rate limit básico por IP: 20 envíos cada 10 minutos.
 */
const RATE_LIMIT = { windowMs: 10 * 60 * 1000, max: 20 };

export async function POST(req: Request) {
  const ip = clientIp(req.headers);
  const rl = checkRateLimit(`diagnostico:${ip}`, RATE_LIMIT);
  if (!rl.allowed) {
    return apiError(
      429,
      "rate_limited",
      "Demasiados intentos, probá de nuevo en unos minutos",
    );
  }

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }

  const body = await parseBody(req, diagnosticoSchema);
  if (!body.ok) return body.response;

  try {
    const result = await registrarDiagnostico(organizationId, body.data);
    return Response.json(
      { ok: true, ...result },
      { status: result.duplicate ? 200 : 201 },
    );
  } catch (err) {
    return apiError(
      500,
      "diagnostico_failed",
      err instanceof Error
        ? err.message
        : "No se pudo registrar el diagnóstico",
    );
  }
}
