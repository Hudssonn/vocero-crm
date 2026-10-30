import { getWhatsappKapsoCredentialsByPhoneNumberId } from "@/server/whatsapp/credentials-kapso";
import { processKapsoWhatsappEvent } from "@/server/whatsapp/ingest-kapso";
import { verifyKapsoWebhookSignature } from "@/server/whatsapp/kapso-signature";

/**
 * 046 — Webhook de WhatsApp por Kapso (D3/D4).
 *
 * Kapso genera UN webhook por número (no hay handshake tipo verify-token de
 * Meta), así que la ruta lleva el `phone_number_id` como segmento: por él se
 * enruta a la organización y se obtiene el secreto para verificar la firma.
 *
 * Capas: [phoneNumberId] desconocido → 404 sin procesar; firma
 * `X-Webhook-Signature` inválida → 401. El POST responde 200 rápido (<10 s):
 * verificar, normalizar y procesar en `after()`.
 */
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ phoneNumberId: string }> };

/**
 * Kapso solo entrega por POST; no hay verificación por GET que atender.
 * Cualquier otro método cae en el 405 de Next por no estar exportado.
 */
export async function POST(req: Request, { params }: Params) {
  const { phoneNumberId } = await params;

  // D4: el body CRUDO para la firma — nunca re-serializar con
  // `JSON.stringify`, que rompe el HMAC.
  const rawBody = await req.text();

  // D3: el número enruta; desconocido → 404 sin procesar ni verificar.
  const creds = await getWhatsappKapsoCredentialsByPhoneNumberId(phoneNumberId);
  if (!creds) {
    return new Response(null, { status: 404 });
  }

  // D4: HMAC-SHA256 en hex del body crudo con el secreto del webhook, sin
  // prefijo `sha256=`, comparación timing-safe.
  const signature = req.headers.get("X-Webhook-Signature");
  if (!verifyKapsoWebhookSignature(rawBody, signature, creds.webhookSecret)) {
    return new Response(null, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Body ilegible con firma válida: 200 igualmente (no se puede procesar
    // y reintentarlo no lo arreglaría).
    return Response.json({ received: true });
  }

  const eventName = req.headers.get("X-Webhook-Event");
  console.log("[whatsapp] Kapso: webhook recibido, event =", eventName);
  try {
    await processKapsoWhatsappEvent(payload, eventName);
  } catch (err) {
    console.error("[whatsapp] Kapso: error procesando el webhook:", err);
  }

  return Response.json({ received: true });
}
