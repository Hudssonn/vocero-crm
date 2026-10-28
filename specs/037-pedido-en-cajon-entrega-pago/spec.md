# 037 — El cajón muestra el pedido + el pedido del menú trae entrega y pago

## Contexto

033 convirtió cada pedido del menú QR en un lead del pipeline, con el
texto del pedido como primer mensaje de su conversación. 034 y 035 le
dieron ese texto a la pantalla de cocina. Pero en el pipeline de
Vocero la tarjeta solo enseñaba nombre, actividad y monto: para ver
qué lleva el pedido había que abrir la conversación o la pantalla.

El dueño pidió dos cosas:

1. Que el cajón del trato enseñe lo que lleva el pedido.
2. Que el pedido del menú traiga entrega y pago, para que la cocina
   y el repartidor no tengan que preguntarlos por chat.

## A. El cajón muestra el pedido

- `GET /api/pipeline/board` (`src/app/api/pipeline/board/route.ts`)
  devuelve por cada lead un campo nuevo `orderText: string | null`:
  el texto del primer mensaje de su conversación, SOLO cuando el
  contacto es un pedido del menú (su `wa_identity` empieza con
  `menu:`). Para los demás leads, null, y el cajón no pinta la
  sección.
- La ruta sigue la regla del fork: solo exporta handlers. La lógica
  vive en `src/server/orders/order-text.ts`:
  `firstMessageTextByConversation` recibe las filas de mensajes y
  devuelve, por conversación, el texto del más antiguo. Gana el más
  antiguo aunque la lista venga desordenada; en empate de hora gana
  el primero de la lista. Solo se leen los mensajes de las
  conversaciones de pedidos del menú, no los de todo el tablero.
- `BoardLead` (`src/components/pipeline/pipeline-client.tsx`) gana
  el campo `orderText: string | null`.
- El cajón (`src/components/pipeline/lead-drawer.tsx`) pinta una
  sección "Pedido" (texto con saltos de línea, clase
  `whitespace-pre-line`) justo después de "Quién" y antes de
  "Monto", solo cuando `orderText` no es null.
- Solo lectura: `lead.stage_id` no se escribe en ningún lado aquí.
  La pantalla de cocina (bot-board) no se toca, y el texto que
  enseña el cajón es el mismo primer mensaje que ya enseña la
  pantalla.

## B. El pedido del menú trae entrega y pago

Claves nuevas en `menuOrderSchema` (`src/server/orders/service.ts`),
todas opcionales para no romper menús viejos (compatibles hacia
atrás: un pedido sin ellas pasa igual que antes):

| Clave | Tipo | Regla |
|---|---|---|
| `entrega` | `"retiro" \| "delivery"` | Opcional. |
| `direccion` | string | Solo delivery. Si `entrega === "delivery"`, debe venir no vacía (refinamiento nuevo; espacios en blanco no cuentan). |
| `pago` | `"sinpe" \| "repartidor" \| "local"` | Opcional. |
| `conCuanto` | número ≥ 0 | Opcional. Solo aplica cuando el pago es en efectivo (repartidor o local); el SINPE ya viene pagado y no pregunta vuelto. |

Combinaciones que el contrato contempla (el menú las ofrece así, el
servidor no las impone más allá de la dirección):

- Delivery: pago SINPE o Al repartidor.
- Retiro: pago SINPE o En el local.

Lo demás del schema NO cambia: `orderId`, `mesa`, `paraLlevar`,
`codigo`, `items`, `total` y el refine existente mesa/código
quedan intactos.

### Nombre del contacto

`orderContactName` gana un caso:

- Para llevar + delivery → `Delivery ${codigo}`.
- Para llevar sin delivery → `Para llevar ${codigo}` (como antes).
- Si no → `Mesa ${mesa}` (como antes).

### Texto del pedido

`formatOrderText` mantiene su formato ("Pedido desde el menú QR",
platos con nota y extras, `Total: ₡${total}`) y cambia esto:

- Delivery: la línea es `DELIVERY: ${codigo}` (en vez de
  `PARA LLEVAR: ${codigo}`), seguida de `Dirección: ${direccion}`.
- Antes del Total agrega la línea de pago: `Pago: SINPE de una
  vez` (sinpe), `Pago: Al repartidor` (repartidor) o `Pago: En el
  local` (local), y si `conCuanto` no es null,
  `Con cuánto cancela: ₡${conCuanto}`.
- Sin pago ni con cuánto (pedido viejo), el texto sale exactamente
  como antes: no se agregan líneas vacías.

### Lo que NO entra

- Costo de delivery, zonas, mínimo de compra ni cambios al flujo
  con mesa. El delivery no cobra envío en este contrato: el pago es
  el total del pedido, en SINPE o al repartidor.

## Cambios en el modelo

- `src/app/api/pipeline/board/route.ts`: campo `orderText` por
  lead + lectura de primeros mensajes (solo pedidos del menú).
- `src/server/orders/order-text.ts` (nuevo): helper puro
  `firstMessageTextByConversation`.
- `src/components/pipeline/pipeline-client.tsx`: `BoardLead`
  gana `orderText`.
- `src/components/pipeline/lead-drawer.tsx`: sección "Pedido"
  entre "Quién" y "Monto".
- `src/server/orders/service.ts`: claves `entrega`, `direccion`,
  `pago`, `conCuanto` en el schema, nombre `Delivery` y líneas
  nuevas en el texto.
- Pruebas: `tests/unit/pipeline-order-text.test.ts` (nueva, el
  helper) y `tests/unit/bot-orders.test.ts` (schema nuevo, nombre
  Delivery, líneas de texto nuevas). `bot-board.test.ts` no se
  toca.

## Verificación

- Gates: typecheck + lint + suite completa + build.
- En vivo en devapp tras el merge (Principio IX): abrir el cajón
  de un pedido del menú y ver la sección "Pedido" con el mismo
  texto de la pantalla de cocina; abrir el cajón de un lead común
  y no ver la sección; mandar un pedido delivery y un pedido
  retiro desde el menú y verificar nombre (`Delivery …` /
  `Para llevar …`), dirección y líneas de pago en el mensaje
  guardado. Sin migración y sin despliegue en esta entrega: solo
  código local, sin push ni PR.
