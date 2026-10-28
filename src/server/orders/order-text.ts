/**
 * 037 — Primer mensaje de una conversación, para el cajón del pipeline.
 *
 * El pedido del menú QR queda guardado como el primer mensaje de su
 * conversación (033), así que el cajón del pipeline lo enseña leyendo
 * ese mensaje, sin tocar la pantalla de cocina ni la conversación.
 *
 * Puro y sin base de datos: la ruta lee las filas y esta función elige.
 */

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
