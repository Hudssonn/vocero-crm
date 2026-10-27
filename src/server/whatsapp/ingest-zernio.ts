import { normalizeMx } from "@/lib/meta/client";
import { ingestInboundMessage } from "@/server/inbox/ingest";
import {
  getWhatsappZernioCredentialsByAccountRef,
} from "@/server/whatsapp/credentials-zernio";
import { zernioSentAtSeconds, type ZernioEvent } from "@/server/zernio";

/**
 * 032 — Adaptador de entrada de WhatsApp por Zernio.
 *
 * Misma forma que los de Messenger y TikTok: el evento de Zernio se
 * normaliza aquí (función pura, probada sin base de datos) y de ahí en
 * adelante corre el MISMO núcleo de ingesta que ya resuelve contacto,
 * conversación, idempotencia y bus de eventos (SSE).
 *
 * Diferencias con los sociales: la identidad del contacto es el teléfono
 * (el remitente de WhatsApp no tiene PSID ni usuario), y el evento real
 * trae el teléfono en `message.sender.phoneNumber` — el tipo de Zernio
 * no lo contemplaba y se amplió para este canal.
 */

/** Un mensaje entrante ya en la forma que entiende el núcleo. */
export type WhatsappZernioInbound = {
  /** Llave de enrutado: la cuenta de WhatsApp en Zernio. */
  routeKey: string;
  /** Teléfono del remitente, solo dígitos. */
  phone: string;
  /** Id del mensaje en Zernio, para deduplicar. */
  messageId: string;
  text: string | null;
  /** Tipo para la bandeja: text | image | video | audio | document | sticker | unsupported */
  type: string;
  /** Segundos desde epoch, como lo consume el núcleo. */
  timestamp: string;
  /** Nombre del perfil si la fuente lo entrega (Zernio sí). */
  profileName: string | null;
  /** Hilo en Zernio: hace falta para responder por Zernio. */
  threadRef: string | null;
};

/**
 * Tipos de adjunto → tipo de mensaje del CRM. En la v1 el adjunto no se
 * descarga (Zernio lo entrega como URL temporal, no como id de media):
 * el mensaje entra con su tipo para que la bandeja enseñe "📎 Imagen" en vez
 * de perder el mensaje, y el operador sepa que hay algo que ver.
 */
const ATTACHMENT_TYPE: Record<string, string> = {
  image: "image",
  video: "video",
  audio: "audio",
  file: "document",
  document: "document",
};

/** Un teléfono E.164 sin el `+`: entre 7 y 15 dígitos. */
const PHONE_RE = /^\d{7,15}$/;

function digitsOf(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

/**
 * Evento de Zernio → mensaje de WhatsApp, o nada. El MISMO webhook trae las
 * demás plataformas conectadas a esa llave: sin el filtro de plataforma
 * acabaríamos ingiriendo un DM de Instagram como si fuera WhatsApp.
 */
export function normalizeZernioWhatsappEvent(
  payload: unknown
): WhatsappZernioInbound[] {
  const evt = payload as ZernioEvent | null;
  if (!evt || typeof evt !== "object") return [];

  const platform = (
    evt.account?.platform ??
    evt.message?.platform ??
    ""
  ).toLowerCase();
  if (platform !== "whatsapp") return [];
  if (evt.event !== "message.received") return [];
  if (evt.message?.direction && evt.message.direction !== "incoming") return [];

  const accountRef = evt.account?.id ?? evt.account?.accountId;
  const messageId = evt.message?.id;
  if (!accountRef || !messageId) return [];

  // El teléfono viene en `sender.phoneNumber`; el `id` del remitente solo
  // vale si también es un número (algunas cuentas lo mandan así).
  const sender = evt.message?.sender;
  let phone = digitsOf(sender?.phoneNumber);
  if (!PHONE_RE.test(phone)) phone = digitsOf(sender?.id);
  if (!PHONE_RE.test(phone)) return [];

  const text =
    typeof evt.message?.text === "string" && evt.message.text.length > 0
      ? evt.message.text
      : null;
  const type = resolveType(text, evt.message?.attachments?.[0]);
  if (!type) return [];

  return [
    {
      routeKey: accountRef,
      phone,
      messageId,
      text,
      type,
      timestamp: zernioSentAtSeconds(evt.message?.sentAt),
      profileName: sender?.name?.trim() || null,
      // Opaco por contrato: se guarda tal cual y no se parsea. Es lo que hace
      // falta para responder por Zernio.
      threadRef: evt.message?.conversationId ?? evt.conversation?.id ?? null,
    },
  ];
}

function resolveType(
  text: string | null,
  attachment: { type?: string } | undefined
): string | null {
  if (text) return "text";
  if (!attachment) return null;
  return ATTACHMENT_TYPE[attachment.type ?? ""] ?? "unsupported";
}

export async function processZernioWhatsappEvent(
  payload: unknown
): Promise<void> {
  for (const evt of normalizeZernioWhatsappEvent(payload)) {
    const creds = await getWhatsappZernioCredentialsByAccountRef(evt.routeKey);

    if (!creds) {
      console.warn(
        `[whatsapp] evento de Zernio para una cuenta desconocida (${evt.routeKey}): ` +
          "guarda la conexión en Configuración → WhatsApp para recibir mensajes"
      );
      continue;
    }

    const identity = normalizeMx(evt.phone);
    await ingestInboundMessage({
      organizationId: creds.organizationId,
      identity: {
        identity,
        channel: "whatsapp",
        phone: identity,
        waUserId: null,
        profileName: evt.profileName,
      },
      // Prefijado para que no colisione jamás con un `wamid.*` de Meta en
      // el índice único de mensajes.
      waMessageId: `zwa_${evt.messageId}`,
      type: evt.type,
      text: evt.text,
      timestamp: evt.timestamp,
      threadRef: evt.threadRef,
    });
  }
}
