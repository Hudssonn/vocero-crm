import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaApiError } from "@/lib/meta/client";
import {
  KAPSO_API_BASE,
  KAPSO_GRAPH_VERSION,
  KAPSO_THREAD_PREFIX,
  sendKapsoMessage,
} from "@/server/whatsapp/send-kapso";
import {
  kapsoWebhookSignature,
  verifyKapsoWebhookSignature,
} from "@/server/whatsapp/kapso-signature";

/**
 * 046 — Envío de WhatsApp por Kapso. El `fetch` va falso para ver la URL,
 * el header `X-API-Key` y el cuerpo formato Meta que salen por el cable,
 * sin tocar la API real ni la base de datos.
 */

const PHONE_NUMBER_ID = "1295326617007791";
const API_KEY = "kapso_llave_de_prueba";
const URL_ESPERADA =
  `${KAPSO_API_BASE}/meta/whatsapp/${KAPSO_GRAPH_VERSION}/` +
  `${PHONE_NUMBER_ID}/messages`;

function respuesta(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("046 · envío por Kapso", () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("el hilo de Kapso se reconoce por el prefijo `kapso:`", () => {
    expect(KAPSO_THREAD_PREFIX).toBe("kapso:");
  });

  it("hace POST a la API de Kapso con X-API-Key y cuerpo formato Meta", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      respuesta({ messages: [{ id: "wamid.kapso123" }] })
    );

    const r = await sendKapsoMessage({
      phoneNumberId: PHONE_NUMBER_ID,
      apiKey: API_KEY,
      to: "50670286104",
      text: "Hola, ¿en qué le ayudo?",
    });

    expect(r.platformMessageId).toBe("wamid.kapso123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL_ESPERADA);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe(API_KEY);
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: "whatsapp",
      to: "50670286104",
      type: "text",
      text: { body: "Hola, ¿en qué le ayudo?" },
    });
  });

  it("un 401 de Kapso es error de auth (la llave murió)", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      respuesta({ error: { message: "Invalid API key", code: 401 } }, 401)
    );

    const err = await sendKapsoMessage({
      phoneNumberId: PHONE_NUMBER_ID,
      apiKey: API_KEY,
      to: "50670286104",
      text: "Hola",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.isAuthError).toBe(true);
  });

  it("un 403 de Kapso también es error de auth (llave sin permiso)", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      respuesta({ error: { message: "Forbidden", code: 403 } }, 403)
    );

    const err = await sendKapsoMessage({
      phoneNumberId: PHONE_NUMBER_ID,
      apiKey: API_KEY,
      to: "50670286104",
      text: "Hola",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.isAuthError).toBe(true);
  });

  it("un 500 de Kapso NO es error de auth (hipo transitorio)", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(respuesta({ error: { message: "x" } }, 500));

    const err = await sendKapsoMessage({
      phoneNumberId: PHONE_NUMBER_ID,
      apiKey: API_KEY,
      to: "50670286104",
      text: "Hola",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.isAuthError).toBe(false);
    expect(err.status).toBe(500);
  });

  it("si la red falla, el error lleva status 0", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockRejectedValue(new Error("red caída"));

    const err = await sendKapsoMessage({
      phoneNumberId: PHONE_NUMBER_ID,
      apiKey: API_KEY,
      to: "50670286104",
      text: "Hola",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.status).toBe(0);
  });

  it("sin id en la respuesta, falla en vez de inventar uno", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(respuesta({ messages: [] }));

    await expect(
      sendKapsoMessage({
        phoneNumberId: PHONE_NUMBER_ID,
        apiKey: API_KEY,
        to: "50670286104",
        text: "Hola",
      })
    ).rejects.toThrow("no devolvió ID de mensaje");
  });
});

describe("046 · firma HMAC del webhook de Kapso", () => {
  const SECRET = "secreto_del_webhook";
  const BODY = '{"type":"whatsapp.message.received","data":[]}';

  it("firma válida → ok", () => {
    const firma = kapsoWebhookSignature(BODY, SECRET);
    expect(verifyKapsoWebhookSignature(BODY, firma, SECRET)).toBe(true);
  });

  it("firma inválida → rechazo", () => {
    expect(verifyKapsoWebhookSignature(BODY, "0".repeat(64), SECRET)).toBe(
      false
    );
  });

  it("secreto equivocado → rechazo", () => {
    const firma = kapsoWebhookSignature(BODY, SECRET);
    expect(verifyKapsoWebhookSignature(BODY, firma, "otro_secreto")).toBe(
      false
    );
  });

  it("body alterado → rechazo", () => {
    const firma = kapsoWebhookSignature(BODY, SECRET);
    expect(
      verifyKapsoWebhookSignature(BODY + " ", firma, SECRET)
    ).toBe(false);
  });

  it("sin firma o sin secreto → rechazo", () => {
    expect(verifyKapsoWebhookSignature(BODY, null, SECRET)).toBe(false);
    expect(verifyKapsoWebhookSignature(BODY, "", SECRET)).toBe(false);
    const firma = kapsoWebhookSignature(BODY, SECRET);
    expect(verifyKapsoWebhookSignature(BODY, firma, null)).toBe(false);
  });

  it("la firma es hex sin prefijo `sha256=`", () => {
    const firma = kapsoWebhookSignature(BODY, SECRET);
    expect(firma).toMatch(/^[0-9a-f]{64}$/);
  });
});
