import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 021 — El contrato del despacho: lo que el CRM le manda a un cerebro externo
 * cuando un cliente escribe. Ver
 * `specs/021-despacho-estandar/contracts/despacho.md`. Este módulo define la
 * FORMA del evento y la firma; no habla con nadie ni toca la base.
 *
 * La regla que lo sostiene: el cerebro recibe un evento NORMALIZADO. No sabe
 * si el mensaje vino de Meta o de Zernio y no tiene credenciales de canal, así
 * que agregar un canal no toca a los cerebros y agregar un cerebro no toca a
 * los canales.
 *
 * Es la misma forma que el despacho de Vocero Cloud (su
 * `src/server/brains/contract.ts`), para que un mismo cerebro sirva a las dos
 * ediciones. La única diferencia está en `mediaId`, y se explica abajo.
 */

export type CanalDelEvento =
  | "whatsapp"
  | "instagram"
  | "messenger"
  // 031 — el correo entra como un valor más del canal normalizado; los
  // cerebros que no lo conocen lo ignoran como a cualquier canal nuevo.
  | "email"
  | "tiktok";

export type MensajeDelEvento = {
  id: string;
  at: string;
  type: string;
  text: string | null;
  /**
   * El id que acepta `GET /api/bot/media/{mediaId}` (el de Graph), no el id
   * interno del adjunto. En cloud es al revés porque allá la vuelta es
   * `/api/brains/media`; aquí la vuelta es `/api/bot/*` y no cambia.
   */
  mediaId: string | null;
  /** Solo con adjunto. */
  mimeType?: string | null;
  /** Solo con adjunto. */
  caption?: string | null;
};

export type EventoDespacho = {
  dispatchId: string;
  organization: { id: string; slug: string | null };
  conversation: {
    id: string;
    channel: CanalDelEvento;
    aiEnabled: boolean;
    windowOpen: boolean;
    windowExpiresAt: string | null;
  };
  contact: {
    id: string;
    displayName: string;
    identity: string;
  };
  messages: MensajeDelEvento[];
  firstMessageAt: string;
  lastMessageAt: string;
};

/** Lo que hace falta saber de un mensaje para meterlo al evento. */
export type MensajeParaEvento = {
  id: string;
  createdAt: Date;
  type: string;
  text: string | null;
  media: {
    waMediaId: string | null;
    mimeType: string | null;
    caption: string | null;
  } | null;
};

/**
 * Arma el evento. Pura, y es la ÚNICA que lo arma: el orden de las claves es
 * contrato —se firma el JSON tal como sale de aquí— y
 * `tests/unit/despacho-contrato.test.ts` fija un cuerpo y su firma byte a
 * byte. La prueba gemela vive en el repo del cerebro.
 */
export function armarEvento(datos: {
  dispatchId: string;
  organization: { id: string; slug: string | null };
  conversation: {
    id: string;
    channel: CanalDelEvento;
    aiEnabled: boolean;
    windowOpen: boolean;
    windowExpiresAt: Date | null;
  };
  contact: { id: string; displayName: string; identity: string };
  messages: MensajeParaEvento[];
  firstMessageAt: Date;
  lastMessageAt: Date;
}): EventoDespacho {
  return {
    dispatchId: datos.dispatchId,
    organization: {
      id: datos.organization.id,
      slug: datos.organization.slug,
    },
    conversation: {
      id: datos.conversation.id,
      channel: datos.conversation.channel,
      aiEnabled: datos.conversation.aiEnabled,
      windowOpen: datos.conversation.windowOpen,
      windowExpiresAt: datos.conversation.windowExpiresAt?.toISOString() ?? null,
    },
    contact: {
      id: datos.contact.id,
      displayName: datos.contact.displayName,
      identity: datos.contact.identity,
    },
    messages: datos.messages.map(mensajeDelEvento),
    firstMessageAt: datos.firstMessageAt.toISOString(),
    lastMessageAt: datos.lastMessageAt.toISOString(),
  };
}

function mensajeDelEvento(m: MensajeParaEvento): MensajeDelEvento {
  const base = {
    id: m.id,
    at: m.createdAt.toISOString(),
    type: m.type,
    text: m.text,
    mediaId: m.media?.waMediaId ?? null,
  };
  // Sin algo que descargar, `mimeType` y `caption` no dicen nada: una
  // ubicación o una tarjeta de contacto no tienen media id.
  if (!m.media?.waMediaId) return base;
  return { ...base, mimeType: m.media.mimeType, caption: m.media.caption };
}

/**
 * 026 — Quien administra el negocio eliminó una conversación: el cerebro tiene
 * que olvidarla.
 *
 * Viaja a la MISMA URL y con la MISMA firma que un despacho. Se distingue por
 * `type`, que un despacho no lleva: quien no conozca este evento ve un cuerpo
 * sin `messages` y lo rechaza, que es inofensivo — no se reintenta.
 *
 * No lleva el contenido de lo borrado, solo con qué encontrarlo. `identity` va
 * porque un cerebro suele indexar su memoria por persona, no por el id de
 * conversación del CRM.
 */
export type EventoOlvido = {
  type: "conversation.deleted";
  eventId: string;
  organization: { id: string; slug: string | null };
  conversation: { id: string; channel: CanalDelEvento };
  contact: { id: string; identity: string };
  deletedAt: string;
};

export const TIPO_OLVIDO = "conversation.deleted" as const;

/**
 * El orden de las claves es contrato: se firma el JSON tal como sale de aquí.
 * Es el mismo cuerpo que manda Vocero Cloud, y la prueba gemela de `nea-agent`
 * (`tests/test_olvido.py`) lo tiene copiado byte a byte, igual que
 * `tests/unit/olvido-contrato.test.ts` aquí.
 */
export function construirEventoOlvido(datos: {
  eventId: string;
  organization: { id: string; slug: string | null };
  conversation: { id: string; channel: CanalDelEvento };
  contact: { id: string; identity: string };
  deletedAt: Date;
}): EventoOlvido {
  return {
    type: TIPO_OLVIDO,
    eventId: datos.eventId,
    organization: {
      id: datos.organization.id,
      slug: datos.organization.slug,
    },
    conversation: {
      id: datos.conversation.id,
      channel: datos.conversation.channel,
    },
    contact: { id: datos.contact.id, identity: datos.contact.identity },
    deletedAt: datos.deletedAt.toISOString(),
  };
}

export const CABECERA_FIRMA = "x-vocero-signature";
export const CABECERA_DISPATCH = "x-vocero-dispatch-id";
export const CABECERA_ORG = "x-vocero-organization";
/** Para los eventos que no son un turno: hoy, `conversation.deleted` (026). */
export const CABECERA_EVENTO = "x-vocero-event";

/**
 * Firma del cuerpo CRUDO, con prefijo `sha256=`.
 *
 * El prefijo es contrato: el webhook de Zernio NO lo lleva y el nuestro SÍ. La
 * asimetría es del proveedor, no nuestra.
 */
export function firmarCuerpo(cuerpoCrudo: string, secreto: string): string {
  const hex = createHmac("sha256", secreto)
    .update(cuerpoCrudo, "utf8")
    .digest("hex");
  return `sha256=${hex}`;
}

/**
 * Verificación en tiempo constante. El CRM no verifica sus propios despachos:
 * existe para que el cerebro de prueba del arnés y las pruebas comprueben la
 * firma con la misma regla que debe usar un cerebro real.
 */
export function firmaValida(
  cuerpoCrudo: string,
  secreto: string,
  firmaRecibida: string | null
): boolean {
  if (!firmaRecibida) return false;
  const esperada = Buffer.from(firmarCuerpo(cuerpoCrudo, secreto));
  const recibida = Buffer.from(firmaRecibida);
  if (esperada.length !== recibida.length) return false;
  return timingSafeEqual(esperada, recibida);
}

/**
 * Cómo se clasifica lo que respondió el cerebro.
 *
 * Un 4xx (salvo 429) NO se reintenta: si el otro lado considera inválido el
 * cuerpo, mandárselo tres veces solo retrasa la caída a humano, que es lo
 * único que va a atender esa conversación. Un 3xx cae aquí también: no se
 * siguen redirecciones.
 */
export type ResultadoEntrega =
  | { ok: true }
  | { ok: false; reintentable: boolean; detalle: string };

export function clasificarRespuesta(status: number): ResultadoEntrega {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 429 || status >= 500) {
    return {
      ok: false,
      reintentable: true,
      detalle: `el cerebro respondió ${status}`,
    };
  }
  return {
    ok: false,
    reintentable: false,
    detalle: `el cerebro respondió ${status} (no se reintenta)`,
  };
}
