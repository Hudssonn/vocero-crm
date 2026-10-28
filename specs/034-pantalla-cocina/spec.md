# 034 — Pantalla de cocina (prototipo)

## Problema

Los pedidos del menú QR ya caen en Vocero (033), pero la cocina no los
ve si no abre la bandeja: un tele en la cocina necesita una vista
grande, en vivo, sin login.

## Solución

Un endpoint de solo lectura en la superficie bot, `GET /api/bot/board`,
que devuelve solo las tarjetas de pedidos (etapas Nuevo pedido, En
preparación, Pagado, Entregado, Perdido) con el texto del pedido y su
hora. La página de la pantalla lo consume a través del servidor del
menú, que guarda la llave: la página nunca ve la llave y no pide login.

## Contrato

- Auth: header `X-API-Key` contra `BOT_API_KEY`, igual que el resto de
  `/api/bot/*`. Sin llave configurada, 401 siempre.
- Solo GET, solo lectura, sin body. Respuesta:
  `{ stages: [{ id, name, kind }], orders: [{ leadId, stageId, name,
  text, orderedAt, conversationId }] }`.
- `text` es el primer mensaje de la conversación (el que dejó el
  endpoint 033); si la tarjeta no tiene conversación, queda en null.
- Sin organización: 409 `no_org`.

## Decisiones (prototipo)

- **Filtro por nombre de etapa**: las etapas de pedidos son las cinco
  de 033. Las demás etapas de la organización no salen en la pantalla.
- **Lectura simple**: las tarjetas salen con la misma consulta del
  tablero del CRM, y los mensajes se traen en una segunda consulta
  ordenada por hora. A volumen de cocina (decenas de pedidos) alcanza;
  si un día hace falta, se optimiza sin cambiar el contrato.
- **Sin secretos en la página**: la llave vive en el servidor del menú
  (su entorno), nunca en el HTML ni en el repo. El proxy y la página
  son públicos en el prototipo porque los datos son de prueba; en
  producción llevan llave de pantalla.
- **Sin migración**: solo SELECT sobre tablas existentes. No se toca
  `lead.stage_id` ni ninguna escritura.

## Pruebas

- `tests/unit/bot-board.test.ts`: filtro de etapas, primer mensaje por
  tarjeta (no el último), tarjeta sin conversación en null. Puras, sin
  BD, como exige el árbol de tests.
- Camino con BD: verificación en vivo en devapp (Principio IX): un
  pedido nuevo aparece en el tablero y mover su etapa se refleja.

## Despliegue

- Solo devapp (instancia de prueba). La llave bot de devapp es la misma
  que ya usa el adaptador del menú; va en el entorno, nunca en el repo.
- Versión: no se sube en este cambio; va con el release.
