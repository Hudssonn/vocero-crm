import { apiError, parseBody } from "@/lib/api";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { resolveInstanceOrg } from "@/server/bot/auth";
import {
  registrarLlamadaVoz,
  validVozKey,
  vozPostLlamadaSchema,
} from "@/server/voice/calls";
import { procesarPedidoDeVoz } from "@/server/voice/voice-order";
import { vozDisabledResponse, vozEnabled } from "@/server/voice/flag";

export const dynamic = "force-dynamic";

/**
 * 050 — Entrada del puente de voz (n8n) tras cada llamada de un agente.
 *
 * CONTRATO: público, con llave. El puente manda `X-Voz-Key` igual a
 * `VOZ_API_KEY` (mínimo 16 caracteres; sin ella todo responde 401). Crear
 * responde **201**; repetir el mismo `conversation_id` devuelve la llamada
 * ya guardada con **200** (`duplicate: true`), sin duplicar nada. El error
 * va anidado (`{"error":{"code":…}}`). Solo POST. Rate limit básico por IP:
 * 20 envíos cada 10 minutos. Sin `VOZ=on`, 404: la superficie no existe.
 *
 * `instance` se acepta y se ignora: no existe ningún mapeo instance→org.
 * La org es la de la instancia (`resolveInstanceOrg`: la primera
 * organización de la BD; una instancia = un negocio). Multi-negocio en una
 * instancia no está soportado (ver spec 050 y `src/server/voice/calls.ts`).
 *
 * Acepta los campos que el puente envía hoy (`phone`, `name`, `direction`,
 * `duration_sec`, `summary`, `recording_url`) MÁS los opcionales
 * `agent_id`, `conversation_id` y `transcript` (el puente aún no los manda).
 * Lo que no viene queda NULL: el endpoint no inventa datos.
 *
 * 050 — Pedido por voz → cocina: tras registrar la llamada (y solo si no es
 * duplicada), se intenta crear el pedido en el pipeline de pedidos
 * (`procesarPedidoDeVoz` en `src/server/voice/voice-order.ts`). Ese intento
 * nunca tumba el 201: si no hay texto usable, la org no tiene pipeline de
 * pedidos, el modelo no extrae con confianza o la validación contra el menú
 * falla, la llamada queda en el historial para revisión humana y el pedido
 * no se crea.
 */
const RATE_LIMIT = { windowMs: 10 * 60 * 1000, max: 20 };

export async function POST(req: Request) {
  if (!vozEnabled()) return vozDisabledResponse();

  if (!validVozKey(req.headers.get("x-voz-key"))) {
    const ip = clientIp(req.headers);
    const fails = checkRateLimit(`voz-api-fail:${ip}`, {
      windowMs: 60_000,
      max: 30,
    });
    return fails.allowed
      ? apiError(401, "unauthorized", "No autorizado")
      : apiError(429, "rate_limited", "Demasiados intentos fallidos");
  }

  const ip = clientIp(req.headers);
  const rl = checkRateLimit(`voz-post-llamada:${ip}`, RATE_LIMIT);
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

  const body = await parseBody(req, vozPostLlamadaSchema);
  if (!body.ok) return body.response;

  try {
    const result = await registrarLlamadaVoz(organizationId, body.data);
    // 050 — Pedido por voz → cocina (solo llamadas nuevas, no duplicadas:
    // un reintento del puente no debe crear el pedido dos veces). Nunca
    // afecta la respuesta: el pedido es un intento aparte, con su propio
    // try/catch en `procesarPedidoDeVoz`.
    if (!result.duplicate) {
      const pedido = await procesarPedidoDeVoz(organizationId, {
        summary: body.data.summary,
        transcript: body.data.transcript,
        phone: body.data.phone,
        name: body.data.name,
        conversationId: body.data.conversation_id,
      });
      if (pedido.creado) {
        console.log(
          `[voz] pedido creado desde la llamada ${result.id} (conversación ${body.data.conversation_id ?? "sin id"})`,
        );
      } else {
        console.log(
          `[voz] llamada ${result.id} sin pedido: ${pedido.motivo}`,
        );
      }
    }
    return Response.json(
      { ok: true, id: result.id, duplicate: result.duplicate },
      { status: result.duplicate ? 200 : 201 },
    );
  } catch (err) {
    // El detalle va al log del servidor, no a la respuesta: un 500 no filtra
    // mensajes internos (que pueden llevar datos de la BD o del puente).
    console.error("[voz] no se pudo registrar la llamada:", err);
    return apiError(500, "voz_failed", "No se pudo registrar la llamada");
  }
}
