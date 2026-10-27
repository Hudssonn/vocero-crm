import { describe, expect, it } from "vitest";
import { normalizeZernioWhatsappEvent } from "@/server/whatsapp/ingest-zernio";
import { zernioTargetChannel } from "@/server/zernio/dispatch";

const ACCOUNT = "6adce3108e04350618174720";

/** Un evento de Zernio con la forma que trae WhatsApp de verdad. */
function zernioEvent(over: Record<string, unknown> = {}) {
  return {
    id: "5f8e2a1c-0000",
    event: "message.received",
    message: {
      id: "wamid.HBgLNTA2NzAyODYxMDQVAgASGBQzQjM2Q0Q0QzQzQz",
      conversationId: "6adce530bcf0217ccb5d1db3",
      direction: "incoming",
      text: "Hola, me interesa la Formula City 125",
      sentAt: "2026-10-26T19:30:00.000Z",
      sender: { id: "50670286104", name: "Hudson", phoneNumber: "+506 7028-6104" },
    },
    account: { id: ACCOUNT, platform: "whatsapp" },
    ...over,
  };
}

describe("032 · WhatsApp por Zernio: normalización del entrante", () => {
  it("un entrante de WhatsApp sale con teléfono, texto, hilo y hora del evento", () => {
    const [evt] = normalizeZernioWhatsappEvent(zernioEvent());
    expect(evt).toMatchObject({
      routeKey: ACCOUNT,
      phone: "50670286104",
      text: "Hola, me interesa la Formula City 125",
      type: "text",
      profileName: "Hudson",
      threadRef: "6adce530bcf0217ccb5d1db3",
    });
    expect(evt?.timestamp).toBe(String(Date.parse("2026-10-26T19:30:00.000Z") / 1000));
  });

  it("el teléfono se limpia de `+`, espacios y guiones", () => {
    const [evt] = normalizeZernioWhatsappEvent(zernioEvent());
    expect(evt?.phone).toBe("50670286104");
  });

  it("sin phoneNumber, vale el id del remitente si es un número", () => {
    const [evt] = normalizeZernioWhatsappEvent(
      zernioEvent({
        message: {
          id: "wamid.1",
          direction: "incoming",
          text: "Hola",
          sender: { id: "50670286104" },
        },
      })
    );
    expect(evt?.phone).toBe("50670286104");
  });

  it("sin teléfono utilizable no hay nada que ingerir", () => {
    expect(
      normalizeZernioWhatsappEvent(
        zernioEvent({
          message: {
            id: "wamid.1",
            direction: "incoming",
            text: "Hola",
            sender: { id: "no-un-telefono", name: "Alguien" },
          },
        })
      )
    ).toEqual([]);
  });

  it("otra plataforma no se cuela como WhatsApp", () => {
    expect(
      normalizeZernioWhatsappEvent(
        zernioEvent({ account: { id: ACCOUNT, platform: "instagram" } })
      )
    ).toEqual([]);
  });

  it("un saliente (`message.sent`) no es algo que el cliente dijo", () => {
    expect(
      normalizeZernioWhatsappEvent(
        zernioEvent({
          event: "message.sent",
          message: {
            id: "wamid.2",
            direction: "outgoing",
            text: "Nuestra respuesta",
            sender: { id: "50670286104", phoneNumber: "50670286104" },
          },
        })
      )
    ).toEqual([]);
  });

  it("otro evento que no sea `message.received` se descarta", () => {
    expect(
      normalizeZernioWhatsappEvent(zernioEvent({ event: "message.delivered" }))
    ).toEqual([]);
  });

  it("sin texto ni adjunto no hay nada que ingerir", () => {
    expect(
      normalizeZernioWhatsappEvent(
        zernioEvent({
          message: {
            id: "wamid.3",
            direction: "incoming",
            text: null,
            sender: { id: "50670286104", phoneNumber: "50670286104" },
          },
        })
      )
    ).toEqual([]);
  });

  it("una foto sin texto entra como imagen, no se pierde", () => {
    const [evt] = normalizeZernioWhatsappEvent(
      zernioEvent({
        message: {
          id: "wamid.4",
          direction: "incoming",
          text: null,
          attachments: [{ type: "image", url: "https://ejemplo/foto.jpg" }],
          sender: { id: "50670286104", phoneNumber: "50670286104" },
        },
      })
    );
    expect(evt?.type).toBe("image");
    expect(evt?.text).toBeNull();
  });

  it("sin conversationId en el mensaje, vale el id del hilo aparte", () => {
    const [evt] = normalizeZernioWhatsappEvent(
      zernioEvent({
        message: {
          id: "wamid.5",
          direction: "incoming",
          text: "Hola",
          sender: { id: "50670286104", phoneNumber: "50670286104" },
        },
        conversation: { id: "6adce530bcf0217ccb5d1db3" },
      })
    );
    expect(evt?.threadRef).toBe("6adce530bcf0217ccb5d1db3");
  });

  it("el reparto de Zernio reconoce la plataforma whatsapp", () => {
    expect(zernioTargetChannel(zernioEvent())).toBe("whatsapp");
    expect(
      zernioTargetChannel(zernioEvent({ account: { id: ACCOUNT, platform: "x" } }))
    ).toBeNull();
  });
});
