/**
 * 037 — Primer mensaje de una conversación, para el cajón del pipeline.
 *
 * El pedido del menú QR queda guardado como el primer mensaje de su
 * conversación (033), así que el cajón del pipeline lo enseña leyendo
 * ese mensaje, sin tocar la pantalla de cocina ni la conversación.
 *
 * Puro y sin base de datos: la ruta lee las filas y esta función elige.
 */

/**
 * 041 — Marcador fijo del pedido confirmado por chat. El agente cierra
 * el pedido con un mensaje que empieza por este marcador (primera
 * línea, tras trim); la pantalla de cocina enseña ese mensaje en vez
 * del primero de la conversación, para no perder el pedido entre la
 * charla previa.
 */
export const ORDER_CONFIRMED_MARKER = "PEDIDO CONFIRMADO";

export type OrderBoardMessageRow = {
  text: string | null;
};

/** Un mensaje "tiene marcador" si su texto, tras trim, empieza por
 * "PEDIDO CONFIRMADO". Un mensaje sin texto nunca tiene marcador. */
export function hasOrderConfirmedMarker(text: string | null): boolean {
  return text !== null && text.trim().startsWith(ORDER_CONFIRMED_MARKER);
}

/**
 * 041 — Texto a mostrar por tarjeta en la pantalla de cocina, a
 * partir de los mensajes de UNA conversación en orden asc por
 * createdAt (el orden en que los entrega `getOrderBoard`).
 *
 * Si hay mensajes con marcador, gana el ÚLTIMO de ellos (el pedido
 * confirmado más reciente); si no hay ninguno, se devuelve el PRIMER
 * mensaje, igual que antes (fallback idéntico: un primer mensaje sin
 * texto da null, no lo tapa el siguiente). Sin mensajes, null.
 */
export function boardOrderText(
  messages: OrderBoardMessageRow[],
): string | null {
  if (messages.length === 0) return null;
  let lastConfirmed: OrderBoardMessageRow | undefined;
  for (const message of messages) {
    if (hasOrderConfirmedMarker(message.text)) {
      lastConfirmed = message;
    }
  }
  if (lastConfirmed) return lastConfirmed.text;
  return messages[0]?.text ?? null;
}

export type FirstMessageRow = {
  conversationId: string;
  text: string | null;
  createdAt: Date;
};

/**
 * Devuelve, por conversación, el texto de su mensaje más antiguo.
 * Gana el más antiguo aunque la lista venga desordenada; en empate de
 * hora gana el primero que llegó en la lista, para no depender del
 * orden de la base. El texto puede ser null (mensaje sin texto): en
 * ese caso el cajón no muestra sección de pedido.
 */
export function firstMessageTextByConversation(
  messages: FirstMessageRow[],
): Map<string, string | null> {
  const firstByConversation = new Map<string, FirstMessageRow>();
  for (const message of messages) {
    const current = firstByConversation.get(message.conversationId);
    if (!current || message.createdAt.getTime() < current.createdAt.getTime()) {
      firstByConversation.set(message.conversationId, message);
    }
  }
  const result = new Map<string, string | null>();
  for (const [conversationId, message] of firstByConversation) {
    result.set(conversationId, message.text);
  }
  return result;
}

/**
 * 039 — Cuánto tardó un pedido en entregarse, en texto para la tarjeta
 * y el cajón. Pura: la ruta le pasa las dos horas y esto solo formatea.
 *
 * Menos de 60 min → "X min" (ej. "23 min"); 60 o más → "X h YY min"
 * con los minutos a dos dígitos (ej. "1 h 05 min"). Se trunca a
 * minutos enteros (23 min 59 s son "23 min") y una duración negativa
 * (reloj) se limita a 0: nunca se enseña un tiempo negativo.
 */
export function formatDeliveryDuration(
  orderedAt: Date,
  deliveredAt: Date,
): string {
  const minutes = Math.max(
    0,
    Math.floor((deliveredAt.getTime() - orderedAt.getTime()) / 60000),
  );
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} h ${String(rest).padStart(2, "0")} min`;
}

export type DeliveryEventRow = {
  leadId: string;
  // Nullable en el esquema: un evento sin etapa destino nunca coincide con
  // la etapa actual de un lead, así que se ignora solo.
  toStageId: string | null;
  occurredAt: Date;
};

/**
 * 039 — Hora de entrega por lead, a partir de filas ya leídas de
 * `leadStageEvent`. Solo lectura: nada se escribe ni se inventa.
 *
 * Para cada lead, gana el evento MÁS RECIENTE cuyo `toStageId` sea la
 * etapa actual del lead. El evento de creación del lead (`toStageId` =
 * etapa de creación, "Nuevo pedido" en pedidos del menú) nunca coincide
 * con la etapa de entrega, así que no interfiere aunque sea el único
 * evento viejo. En empate de hora gana el primero que llegó en la
 * lista. Los eventos de otros leads o hacia otras etapas se ignoran.
 */
export function latestDeliveryByLead(
  events: DeliveryEventRow[],
  leads: { id: string; stageId: string }[],
): Map<string, Date> {
  const stageByLead = new Map(leads.map((l) => [l.id, l.stageId]));
  const latest = new Map<string, Date>();
  for (const event of events) {
    if (stageByLead.get(event.leadId) !== event.toStageId) continue;
    const current = latest.get(event.leadId);
    if (!current || event.occurredAt.getTime() > current.getTime()) {
      latest.set(event.leadId, event.occurredAt);
    }
  }
  return latest;
}
