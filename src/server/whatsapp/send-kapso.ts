/**
 * 046 — Envío de WhatsApp por Kapso (proveedor hermano de Zernio, spec 032).
 *
 * Kapso habla formato Meta Cloud API, así que el cuerpo es el mismo que el
 * de Graph (`{messaging_product:"whatsapp", to, type:"text", text:{body}}`),
 * pero viaja a `api.kapso.ai` autenticado con `X-API-Key` (la llave del
 * proyecto), no con un Bearer de Meta. Por eso NO pasa por
 * `src/lib/meta/client.ts`: esa frontera es solo para Meta.
 *
 * Los errores se traducen a `MetaApiError` para que `send.ts` use el mismo
 * vocabulario que con los demás transportes (incluido `isAuthError`, que
 * distingue una llave muerta de un hipo transitorio).
 *
 * 048 suma `sendKapsoTemplate`: la misma llamada, pero con `type:"template"`
 * para las campañas (plantillas aprobadas de Meta).
 */
import { MetaApiError } from "@/lib/meta/client";

/** Prefijo del `channel_thread_ref` que solo escribe el webhook de Kapso. */
export const KAPSO_THREAD_PREFIX = "kapso:";

export const KAPSO_API_BASE = "https://api.kapso.ai";
export const KAPSO_GRAPH_VERSION = "v24.0";

export type KapsoSendResult = { platformMessageId: string };

/**
 * Lee la respuesta de un envío a Kapso y devuelve el ID del mensaje, o lanza
 * `MetaApiError` con el mismo vocabulario que el resto de transportes.
 *
 * Extraída de `sendKapsoMessage` sin cambiar su comportamiento: 046/D11 —
 * 401/403 de Kapso se normalizan a 401 para que `isAuthError` sea `true`.
 */
async function leerIdDeEnvioKapso(res: Response): Promise<string> {
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // respuesta no-JSON: se conserva el texto crudo en details
  }

  if (!res.ok) {
    const err = (json as { error?: { message?: string; code?: number; type?: string } })
      ?.error;
    // Kapso responde 403 cuando la llave no sirve; para el CRM eso es una
    // llave muerta igual que un 401. El status original queda en details.
    const authFallo = res.status === 401 || res.status === 403;
    throw new MetaApiError(
      err?.message ?? `Kapso respondió ${res.status}`,
      {
        status: authFallo ? 401 : res.status,
        code: err?.code ?? null,
        type: err?.type ?? null,
        details: authFallo ? { kapsoStatus: res.status, body: json ?? text } : (json ?? text),
      }
    );
  }

  const id = (json as { messages?: { id?: string }[] })?.messages?.[0]?.id;
  if (!id) {
    throw new MetaApiError("Kapso no devolvió ID de mensaje", {
      status: 200,
      details: json ?? text,
    });
  }
  return String(id);
}

/** URL del envío para un número de Kapso. */
function urlDeEnvioKapso(phoneNumberId: string): string {
  return (
    `${KAPSO_API_BASE}/meta/whatsapp/${KAPSO_GRAPH_VERSION}/` +
    `${encodeURIComponent(phoneNumberId)}/messages`
  );
}

/**
 * Envía un texto libre por Kapso. `to` es el teléfono en dígitos (el envío
 * exige teléfono: sin `phone` en el contacto no hay nada que mandar).
 *
 * 046/D11 — 401/403 de Kapso se normalizan a 401 para que `isAuthError`
 * sea `true` y el llamador marque `reconnect_required` (igual que Zernio).
 */
export async function sendKapsoMessage(input: {
  phoneNumberId: string;
  apiKey: string;
  to: string;
  text: string;
}): Promise<KapsoSendResult> {
  let res: Response;
  try {
    res = await fetch(urlDeEnvioKapso(input.phoneNumberId), {
      method: "POST",
      headers: {
        "X-API-Key": input.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: input.to,
        type: "text",
        text: { body: input.text },
      }),
    });
  } catch (cause) {
    throw new MetaApiError("No se pudo contactar la API de Kapso", {
      status: 0,
      details: cause,
    });
  }

  return { platformMessageId: await leerIdDeEnvioKapso(res) };
}

/**
 * 048 — Cuerpo del envío de una plantilla aprobada de Meta por Kapso.
 *
 * Puro (sin I/O) para poder probarlo sin red: `variables` son los valores
 * ya fusionados (las del destinatario mandan sobre las globales de la
 * campaña). Sin variables, el `template` no lleva `components`.
 */
export function construirCuerpoPlantillaKapso(input: {
  to: string;
  templateName: string;
  languageCode: string;
  variables?: Record<string, string>;
}): Record<string, unknown> {
  const parameters = parametrosDePlantilla(input.variables ?? {});
  const template: Record<string, unknown> = {
    name: input.templateName,
    language: { code: input.languageCode },
  };
  if (parameters.length > 0) {
    template.components = [{ type: "body", parameters }];
  }
  return {
    messaging_product: "whatsapp",
    to: input.to,
    type: "template",
    template,
  };
}

/**
 * Ordena las variables para los parámetros posicionales `{{1}}`, `{{2}}`…
 * de la plantilla: las claves numéricas ("1", "2", "10") van primero,
 * ordenadas numéricamente; las claves con nombre después, alfabéticamente.
 * Pura, para tests sin BD.
 */
export function parametrosDePlantilla(
  variables: Record<string, string>
): { type: "text"; text: string }[] {
  const claves = Object.keys(variables);
  const numericas = claves
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b));
  const nombradas = claves.filter((k) => !/^\d+$/.test(k)).sort();
  return [...numericas, ...nombradas].map((k) => ({
    type: "text" as const,
    text: variables[k] ?? "",
  }));
}

/**
 * 048 — Envía una plantilla aprobada de Meta por Kapso (campañas).
 * `to` es el teléfono en dígitos. Los errores se traducen a `MetaApiError`
 * igual que `sendKapsoMessage`, para que el worker use el mismo vocabulario
 * (incluido `isAuthError` para detectar la llave muerta).
 */
export async function sendKapsoTemplate(input: {
  phoneNumberId: string;
  apiKey: string;
  to: string;
  templateName: string;
  languageCode: string;
  variables?: Record<string, string>;
}): Promise<KapsoSendResult> {
  let res: Response;
  try {
    res = await fetch(urlDeEnvioKapso(input.phoneNumberId), {
      method: "POST",
      headers: {
        "X-API-Key": input.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        construirCuerpoPlantillaKapso({
          to: input.to,
          templateName: input.templateName,
          languageCode: input.languageCode,
          variables: input.variables,
        })
      ),
    });
  } catch (cause) {
    throw new MetaApiError("No se pudo contactar la API de Kapso", {
      status: 0,
      details: cause,
    });
  }

  return { platformMessageId: await leerIdDeEnvioKapso(res) };
}
