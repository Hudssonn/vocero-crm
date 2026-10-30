import { describe, expect, it } from "vitest";
import { normalizeKapsoWhatsappEvent } from "@/server/whatsapp/ingest-kapso";
import {
  kapsoWebhookSignature,
  verifyKapsoWebhookSignature,
} from "@/server/whatsapp/kapso-signature";

/**
 * 046 — Ingesta de WhatsApp por Kapso: normalización del entrante y
 * verificación HMAC. Espejo de `tests/unit/zernio-whatsapp-ingest.test.ts`.
 *
 * Los fixtures usan la forma v2 real de Kapso (`docs/platform/webhooks/
 * message-events`): el nombre del evento viaja en `X-Webhook-Event`,
 * `phone_number_id` a nivel superior, `message.kapso` con `direction` y
 * `content`, y `conversation` con `id`, `contact_name`, `phone_number` y
 * —cuando Meta no manda teléfono— `business_scoped_user_id`.
 */

const PHONE_NUMBER_ID = "1295326617007791";

/** Un `whatsapp.message.received` con la forma v2 real de Kapso. */
function kapsoEvent(over: Record<string, unknown> = {}) {
  return {
    phone_number_id: PHONE_NUMBER_ID,
    message: {
      id: "msg_kapso_001",
      type: "text",
      timestamp: "1761780600",
      from: "50670286104",
      text: { body: "Hola, ¿cuánto cuesta la Formula City 125?" },
      kapso: {
        direction: "incoming",
        content: "Hola, ¿cuánto cuesta la Formula City 125?",
      },
    },
    conversation: {
      id: "conv_kapso_001",
      contact_name: "Hudson",
      phone_number: "+506 7028-6104",
      phone_number_id: PHONE_NUMBER_ID,
    },
    ...over,
  };
}

const headers = (event = "whatsapp.message.received") =>
  new Headers({ "X-Webhook-Event": event });

describe("046 · WhatsApp por Kapso: normalización del entrante", () => {
  it("un entrante de texto válido sale con teléfono, texto, hilo e identidad", () => {
    const result = normalizeKapsoWhatsappEvent(kapsoEvent(), headers());
    expect(result.ignored).toBe(false);
    if (result.ignored) return;
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      routeKey: PHONE_NUMBER_ID,
      conversationId: "conv_kapso_001",
      phone: "50670286104",
      waIdentity: "50670286104",
      messageId: "msg_kapso_001",
      text: "Hola, ¿cuánto cuesta la Formula City 125?",
      type: "text",
      profileName: "Hudson",
      noDisparaAgente: false,
    });
    expect(result.events[0]?.timestamp).toBe("1761780600");
  });

  it("el `wa_message_id` lleva el prefijo `kwa_`", () => {
    const result = normalizeKapsoWhatsappEvent(kapsoEvent(), headers());
    if (result.ignored) return;
    expect(result.events[0]?.waMessageId).toBe("kwa_msg_kapso_001");
  });

  it("el teléfono se limpia de `+`, espacios y guiones", () => {
    const result = normalizeKapsoWhatsappEvent(kapsoEvent(), headers());
    if (result.ignored) return;
    expect(result.events[0]?.phone).toBe("50670286104");
  });

  it("sin `phone_number` en la conversación, vale `message.from`", () => {
    const payload = kapsoEvent({
      conversation: { id: "conv_kapso_003", phone_number_id: PHONE_NUMBER_ID },
    });
    const result = normalizeKapsoWhatsappEvent(payload, headers());
    if (result.ignored) return;
    expect(result.events[0]?.phone).toBe("50670286104");
    expect(result.events[0]?.noDisparaAgente).toBe(false);
  });

  it("sin teléfono: identidad `bsuid:<id>` y el agente NO se dispara", () => {
    const payload = kapsoEvent({
      message: {
        id: "msg_kapso_sin_tel",
        type: "text",
        timestamp: "1761780600",
        kapso: { direction: "incoming", content: "Hola sin teléfono" },
      },
      conversation: {
        id: "conv_x",
        phone_number_id: PHONE_NUMBER_ID,
        business_scoped_user_id: "bsuid_estable_123",
      },
    });
    const result = normalizeKapsoWhatsappEvent(payload, headers());
    if (result.ignored) return;
    expect(result.events).toHaveLength(1);
    const [evt] = result.events;
    expect(evt?.phone).toBeNull();
    // El BSUID de Meta es la identidad estable (no el id del mensaje: ese
    // cambiaría con cada mensaje y crearía un contacto por mensaje).
    expect(evt?.waIdentity).toBe("bsuid:bsuid_estable_123");
    expect(evt?.noDisparaAgente).toBe(true);
    // El contacto y el mensaje se guardan igual: solo el turno se omite.
    expect(evt?.text).toBe("Hola sin teléfono");
  });

  it("sin teléfono ni BSUID no hay identidad: se ignora", () => {
    const payload = kapsoEvent({
      message: {
        id: "msg_kapso_005",
        type: "text",
        timestamp: "1761780600",
        kapso: { direction: "incoming", content: "Hola" },
      },
      conversation: { id: "conv_kapso_005", phone_number_id: PHONE_NUMBER_ID },
    });
    const result = normalizeKapsoWhatsappEvent(payload, headers());
    if (result.ignored) return;
    expect(result.events).toEqual([]);
  });

  it("un batch entrega cada item como evento propio", () => {
    const payload = {
      type: "whatsapp.message.received",
      batch: true,
      batch_info: { count: 2 },
      data: [
        kapsoEvent(),
        kapsoEvent({
          message: {
            id: "kapso_msg_b",
            type: "text",
            timestamp: "1761780660",
            from: "50688887777",
            kapso: { direction: "incoming", content: "Segundo" },
          },
          conversation: {
            id: "conv_b",
            phone_number: "50688887777",
            phone_number_id: PHONE_NUMBER_ID,
          },
        }),
      ],
    };
    const result = normalizeKapsoWhatsappEvent(payload, headers());
    if (result.ignored) return;
    expect(result.events).toHaveLength(2);
    expect(result.events.map((e) => e.text)).toEqual([
      "Hola, ¿cuánto cuesta la Formula City 125?",
      "Segundo",
    ]);
    expect(result.events.map((e) => e.waMessageId)).toEqual([
      "kwa_msg_kapso_001",
      "kwa_kapso_msg_b",
    ]);
  });

  it("un evento no soportado se ignora con `{ignored:true}`", () => {
    expect(
      normalizeKapsoWhatsappEvent(kapsoEvent(), headers("whatsapp.message.sent"))
    ).toEqual({ ignored: true });
    expect(
      normalizeKapsoWhatsappEvent(
        kapsoEvent(),
        headers("whatsapp.message.delivered")
      )
    ).toEqual({ ignored: true });
  });

  it("sin cabecera de evento también se ignora", () => {
    expect(normalizeKapsoWhatsappEvent(kapsoEvent(), new Headers())).toEqual({
      ignored: true,
    });
  });

  it("un saliente (`direction: outgoing`) no es algo que el cliente dijo", () => {
    const payload = kapsoEvent({
      message: {
        id: "msg_kapso_out",
        type: "text",
        timestamp: "1761780600",
        kapso: { direction: "outgoing", content: "Nuestra respuesta" },
      },
    });
    const result = normalizeKapsoWhatsappEvent(payload, headers());
    if (result.ignored) return;
    expect(result.events).toEqual([]);
  });

  it("una imagen entra como imagen: se registra por tipo, no se descarga", () => {
    const payload = kapsoEvent({
      message: {
        id: "kapso_msg_img",
        type: "image",
        timestamp: "1761780600",
        kapso: { direction: "incoming", has_media: true },
      },
    });
    const result = normalizeKapsoWhatsappEvent(payload, headers());
    if (result.ignored) return;
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ type: "image", text: null });
  });

  it("un tipo fuera de la lista no se ingiere", () => {
    const payload = kapsoEvent({
      message: {
        id: "msg_kapso_009",
        type: "sticker_futurista",
        timestamp: "1761780600",
        kapso: { direction: "incoming" },
      },
    });
    const result = normalizeKapsoWhatsappEvent(payload, headers());
    if (result.ignored) return;
    expect(result.events).toEqual([]);
  });

  it("sin id de mensaje no hay nada que deduplicar", () => {
    const payload = kapsoEvent({
      message: {
        type: "text",
        timestamp: "1761780600",
        kapso: { direction: "incoming", content: "Hola" },
      },
    });
    const result = normalizeKapsoWhatsappEvent(payload, headers());
    if (result.ignored) return;
    expect(result.events).toEqual([]);
  });

  it("la re-entrega del mismo evento produce el mismo `wa_message_id` (el UNIQUE del núcleo la colapsa)", () => {
    const payload = kapsoEvent();
    const primero = normalizeKapsoWhatsappEvent(payload, headers());
    const segundo = normalizeKapsoWhatsappEvent(payload, headers());
    if (primero.ignored || segundo.ignored) return;
    expect(primero.events[0]?.waMessageId).toBe("kwa_msg_kapso_001");
    expect(segundo.events[0]?.waMessageId).toBe("kwa_msg_kapso_001");
  });

  it("payload ilegible no revienta: cero eventos", () => {
    const result = normalizeKapsoWhatsappEvent({ disparate: true }, headers());
    expect(result).toEqual({ ignored: false, events: [] });
  });
});

describe("046 · WhatsApp por Kapso: verificación HMAC del webhook", () => {
  const SECRET = "secreto_del_webhook";
  const BODY = JSON.stringify(kapsoEvent());

  it("firma válida → ok", () => {
    const firma = kapsoWebhookSignature(BODY, SECRET);
    expect(verifyKapsoWebhookSignature(BODY, firma, SECRET)).toBe(true);
  });

  it("firma inválida → rechazo", () => {
    expect(verifyKapsoWebhookSignature(BODY, "firma_mala", SECRET)).toBe(false);
  });

  it("body alterado después de firmar → rechazo", () => {
    const firma = kapsoWebhookSignature(BODY, SECRET);
    expect(verifyKapsoWebhookSignature(BODY + " ", firma, SECRET)).toBe(false);
  });

  it("secreto equivocado → rechazo", () => {
    const firma = kapsoWebhookSignature(BODY, SECRET);
    expect(verifyKapsoWebhookSignature(BODY, firma, "otro_secreto")).toBe(false);
  });

  it("sin firma o sin secreto → rechazo", () => {
    const firma = kapsoWebhookSignature(BODY, SECRET);
    expect(verifyKapsoWebhookSignature(BODY, null, SECRET)).toBe(false);
    expect(verifyKapsoWebhookSignature(BODY, "", SECRET)).toBe(false);
    expect(verifyKapsoWebhookSignature(BODY, firma, null)).toBe(false);
  });
});
