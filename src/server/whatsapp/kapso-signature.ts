/**
 * 046 — Verificación HMAC-SHA256 del webhook de Kapso (función pura, sin I/O).
 *
 * Kapso firma el body JSON CRUDO con el `secret_key` del webhook y lo manda
 * en el header `X-Webhook-Signature` como hex SIN el prefijo `sha256=`.
 * La comparación es timing-safe. En el handler hay que usar
 * `await req.text()` — nunca re-serializar con `JSON.stringify`, que rompe
 * la firma (ver spec 046/D4).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Firma esperada para un body crudo y un secreto. */
export function kapsoWebhookSignature(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/**
 * ¿Esta entrega la firmó Kapso con este secreto? Sin firma o sin secreto no
 * hay nada contra qué comparar: se rechaza.
 */
export function verifyKapsoWebhookSignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string | null | undefined
): boolean {
  if (!signature || !secret) return false;
  const esperada = kapsoWebhookSignature(rawBody, secret);
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(esperada, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
