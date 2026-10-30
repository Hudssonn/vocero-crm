import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { normalizeMx } from "@/lib/meta/client";
import {
  BSUID_PREFIX,
  getOrCreateContactByIdentity,
  type ResolvedIdentity,
} from "@/server/inbox/identity";
import { ingestInboundMessage } from "@/server/inbox/ingest";
import { getWhatsappKapsoCredentialsByPhoneNumberId } from "@/server/whatsapp/credentials-kapso";
import { KAPSO_THREAD_PREFIX } from "@/server/whatsapp/send-kapso";

/**
 * 046 — Adaptador de entrada de WhatsApp por Kapso (BSP oficial de Meta).
 *
 * Espejo del de Zernio (032): el evento de Kapso se normaliza aquí (función
 * pura, probada sin base de datos) y de ahí en adelante corre el MISMO núcleo
 * de ingesta que resuelve contacto, conversación, idempotencia y bus de
 * eventos (SSE). El transporte se distingue por el prefijo `kapso:` del
 * `channel_thread_ref` (D6/D8); el canal sigue siendo `"whatsapp"` (D1).
 *
 * Forma del payload v2 (docs de Kapso, `platform/webhooks/message-events`):
 * `phone_number_id` a nivel superior para el enrutado; `message.kapso` con
 * `direction`/`content`; `conversation` con `id`, `contact_name`,
 * `phone_number` y, cuando Meta no manda teléfono, `business_scoped_user_id`.
 * Con buffering activo el body es un batch `{type, batch:true, data:[...]}`.
 * Kapso entrega at-least-once y puede llegar desordenado: la idempotencia la
 * da el UNIQUE de `wa_message_id` en el núcleo, no el orden de llegada.
 */

/** Solo el evento de mensaje entrante; el resto se responde 200 y se ignora. */
const KAPSO_EVENT_MESSAGE_RECEIVED = "whatsapp.message.received";

/** Tipos que `message.type` puede traer (docs de Kapso). */
const TIPOS_VALIDOS = new Set([
  "text",
  "image",
  "video",
  "audio",
  "document",
  "location",
  "template",
  "interactive",
  "reaction",
  "contacts",
]);

/** Un teléfono E.164 sin el `+`: entre 7 y 15 dígitos (misma regla que Zernio). */
const PHONE_RE = /^\d{7,15}$/;

/** Lo mínimo que el normalizador necesita de las cabeceras. */
export type KapsoHeaderLike = Pick<Headers, "get">;

/** Un mensaje entrante ya en la forma que entiende el núcleo. */
export type KapsoWhatsappInbound = {
  /** Llave de enrutado: el `phone_number_id` del payload. */
  routeKey: string | null;
  /** Id de la conversación en Kapso (el proceso le pone el prefijo `kapso:`). */
  conversationId: string;
  /** Teléfono del remitente, solo dígitos, o null si Meta no lo mandó. */
  phone: string | null;
  /** BSUID cuando viene (identidad sin teléfono de Meta). */
  bsuid: string | null;
  /** Llave estable del contacto: teléfono normalizado o `bsuid:<id>`. */
  waIdentity: string;
  /** Id del mensaje en Kapso, ya con el prefijo de idempotencia. */
  messageId: string;
  /** `wa_message_id` para el núcleo: `kwa_` + id Kapso (UNIQUE). */
  waMessageId: string;
  text: string | null;
  /** Tipo para la bandeja (v1: el adjunto se registra por tipo, no se descarga). */
  type: string;
  /** Segundos desde epoch, como lo consume el núcleo. */
  timestamp: string;
  /** Nombre del perfil si la fuente lo entrega. */
  profileName: string | null;
  /**
   * D5: sin teléfono el agente no tiene a quién responder (el envío exige
   * `to` con teléfono). El contacto y el mensaje se guardan igual, pero el
   * turno del agente no debe dispararse.
   */
  noDisparaAgente: boolean;
};

export type NormalizeKapsoResult =
  | { ignored: true }
  | { ignored: false; events: KapsoWhatsappInbound[] };

// Zod en el borde: el payload de Kapso trae decenas de campos que no nos
// importan; `.passthrough()` los tolera y solo exigimos los que usamos.
const kapsoMessageSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().optional(),
    direction: z.string().optional(),
    timestamp: z.string().optional(),
    from: z.string().optional(),
    text: z.object({ body: z.string().optional() }).passthrough().optional(),
    kapso: z
      .object({
        direction: z.string().optional(),
        content: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const kapsoConversationSchema = z
  .object({
    id: z.string().min(1),
    contact_name: z.string().optional(),
    phone_number: z.string().optional(),
    phone_number_id: z.string().optional(),
    business_scoped_user_id: z.string().optional(),
    username: z.string().optional(),
  })
  .passthrough();

const kapsoItemSchema = z
  .object({
    message: kapsoMessageSchema,
    conversation: kapsoConversationSchema,
    phone_number_id: z.string().optional(),
  })
  .passthrough();

const kapsoEnvelopeSchema = z
  .object({
    batch: z.literal(true).optional(),
    data: z.array(z.unknown()).optional(),
  })
  .passthrough();

function digitsOf(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

function textoUtil(value: string | null | undefined): string | null {
  const t = (value ?? "").trim();
  return t.length > 0 ? t : null;
}

/**
 * Un item del payload → mensaje normalizado, o null si no hay nada que
 * ingerir (saliente, tipo desconocido, sin identidad utilizable…).
 */
function normalizeItem(raw: unknown): KapsoWhatsappInbound | null {
  const parsed = kapsoItemSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn("[whatsapp] Kapso: item del webhook con forma inesperada, ignorado");
    return null;
  }
  const { message, conversation } = parsed.data;

  // Solo lo que el cliente escribió: salientes, ecos y estados no son entrantes.
  // La dirección vive en `message.kapso.direction` (o a nivel de mensaje).
  const direction = (message.kapso?.direction ?? message.direction ?? "").toLowerCase();
  if (direction !== "incoming") return null;

  const type = (message.type ?? "").toLowerCase();
  if (!TIPOS_VALIDOS.has(type)) {
    console.log(`[whatsapp] Kapso: tipo de mensaje no soportado (${message.type ?? "?"}), ignorado`);
    return null;
  }

  // Texto de `message.kapso.content` (representación textual del mensaje).
  const text = textoUtil(message.kapso?.content ?? message.text?.body);
  if (type === "text" && !text) {
    console.log("[whatsapp] Kapso: mensaje de texto sin contenido, ignorado");
    return null;
  }

  // Identidad: teléfono 7–15 dígitos desde `conversation.phone_number`, con
  // `message.from` como respaldo. Sin teléfono, el BSUID de Meta.
  let phone = digitsOf(conversation.phone_number);
  if (!PHONE_RE.test(phone)) phone = digitsOf(message.from);
  if (!PHONE_RE.test(phone)) phone = "";
  const telefono = phone || null;

  const bsuid = (conversation.business_scoped_user_id ?? "").trim() || null;
  const waIdentity = telefono ? normalizeMx(telefono) : bsuid ? `${BSUID_PREFIX}${bsuid}` : null;
  if (!waIdentity) {
    console.warn("[whatsapp] Kapso: entrante sin teléfono ni BSUID, ignorado");
    return null;
  }

  const timestamp = /^\d+$/.test(message.timestamp ?? "") && Number(message.timestamp) > 0
    ? String(message.timestamp)
    : String(Math.floor(Date.now() / 1000));

  return {
    routeKey: parsed.data.phone_number_id ?? conversation.phone_number_id ?? null,
    conversationId: conversation.id,
    phone: telefono,
    bsuid,
    waIdentity,
    messageId: message.id,
    waMessageId: `kwa_${message.id}`,
    text,
    type,
    timestamp,
    profileName: textoUtil(conversation.contact_name),
    noDisparaAgente: !telefono,
  };
}

/**
 * Evento de Kapso → mensajes de WhatsApp, o nada. Función pura: no toca
 * red ni base de datos, solo `console` para los descartes.
 */
export function normalizeKapsoWhatsappEvent(
  payload: unknown,
  headers: KapsoHeaderLike
): NormalizeKapsoResult {
  const eventName = headers.get("X-Webhook-Event");
  if (eventName !== KAPSO_EVENT_MESSAGE_RECEIVED) {
    console.log(
      `[whatsapp] Kapso: evento ${eventName ?? "(sin X-Webhook-Event)"} ignorado ` +
        `(solo se procesa ${KAPSO_EVENT_MESSAGE_RECEIVED})`
    );
    return { ignored: true };
  }

  const envelope = kapsoEnvelopeSchema.safeParse(payload);
  if (!envelope.success) {
    console.warn("[whatsapp] Kapso: payload ilegible, ignorado");
    return { ignored: false, events: [] };
  }
  const rawItems =
    envelope.data.batch === true && Array.isArray(envelope.data.data)
      ? envelope.data.data
      : [payload];

  const events: KapsoWhatsappInbound[] = [];
  for (const raw of rawItems) {
    const evt = normalizeItem(raw);
    if (evt) events.push(evt);
  }
  return { ignored: false, events };
}

/**
 * D5 — Sin teléfono el agente no tiene a quién responder (el envío exige
 * `to`): se pausa la IA del contacto ANTES de ingerir, para que el turno que
 * el núcleo encola al final de `ingestInboundMessage` nazca ya apagado.
 *
 * Sin carrera por diseño (patrón 027): la conversación hereda `ai_paused`
 * del contacto en su propio INSERT, y el gate `conversation.aiEnabled` lo
 * leen en fresco tanto el agente incluido (`ai/pipeline.ts`) como el
 * despacho al cerebro externo (`dispatch/encolar.ts`). Si la reconciliación
 * encontró al contacto por su BSUID y ya tiene teléfono, no se pausa: el
 * agente sí puede responderle.
 */
async function pausarIAPorFaltaDeTelefono(
  organizationId: string,
  identity: ResolvedIdentity
): Promise<void> {
  const { contact } = await getOrCreateContactByIdentity(organizationId, identity);
  if (contact.phone || contact.aiPaused) return;
  await getDb()
    .update(schema.contact)
    .set({ aiPaused: true, updatedAt: new Date() })
    .where(scoped(schema.contact.organizationId, organizationId, eq(schema.contact.id, contact.id)));
  console.log(
    `[whatsapp] Kapso: ${contact.waIdentity} llegó sin teléfono: ` +
      "contacto y mensaje guardados, IA pausada — el agente no tiene a quién responder"
  );
}

export async function processKapsoWhatsappEvent(
  payload: unknown,
  headers: KapsoHeaderLike
): Promise<void> {
  const result = normalizeKapsoWhatsappEvent(payload, headers);
  if (result.ignored) return;

  for (const evt of result.events) {
    const creds = evt.routeKey
      ? await getWhatsappKapsoCredentialsByPhoneNumberId(evt.routeKey)
      : null;
    if (!creds) {
      console.warn(
        `[whatsapp] Kapso: evento para un phone_number_id desconocido (${evt.routeKey ?? "ausente"}): ` +
          "conectá el número en Ajustes → WhatsApp para recibir sus mensajes"
      );
      continue;
    }

    const identity: ResolvedIdentity = {
      identity: evt.waIdentity,
      channel: "whatsapp",
      phone: evt.phone,
      waUserId: evt.bsuid,
      profileName: evt.profileName,
    };

    if (evt.noDisparaAgente) {
      await pausarIAPorFaltaDeTelefono(creds.organizationId, identity);
    }

    // Nota: `ingestInboundMessage` ya dispara `maybeRunAgentTurn` al final
    // (`inbox/ingest.ts`); una llamada explícita aquí solo re-armaría el
    // mismo temporizador coalescado. El caso sin teléfono queda cubierto por
    // la pausa previa: el turno encolado se apaga solo al leer la
    // conversación.
    await ingestInboundMessage({
      organizationId: creds.organizationId,
      identity,
      // Prefijo propio: no colisiona jamás con `zwa_*` ni `wamid.*` (D5).
      waMessageId: evt.waMessageId,
      type: evt.type,
      text: evt.text,
      timestamp: evt.timestamp,
      // D6/D8: el prefijo `kapso:` enruta la respuesta al transporte Kapso.
      threadRef: `${KAPSO_THREAD_PREFIX}${evt.conversationId}`,
    });
  }
}
