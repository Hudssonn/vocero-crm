# 041 — Pedidos por chat formateados en la cocina

## Contexto

Hoy hay dos clases de pedido que llegan a la pantalla de cocina, y
solo una se lee bien.

Los pedidos del menú QR traen como primer mensaje de la
conversación el texto formateado de `formatOrderText`
(`src/server/orders/service.ts`): encabezado "Pedido desde el
menú QR", línea de identificador (MESA / PARA LLEVAR / DELIVERY),
Dirección si es delivery, Cliente, Celular, un renglón por plato
con cantidad, nota y extras, Pago, "Con cuánto cancela" si
aplica, y Total. La cocina ve ese texto y sabe qué preparar, para
quién y cómo se paga.

Los pedidos por chat no. El cliente saluda ("Buenas"), pide
hablando, y el detalle del pedido queda repartido en la
conversación. El problema es el selector de hoy: la pantalla de
cocina consume `GET /api/bot/board` (`src/server/orders/board.ts`,
`assembleOrderBoard` + `getOrderBoard`) y, por pedido, el campo
`text` es el PRIMER mensaje de la conversación (en orden asc por
`createdAt`) y `orderedAt` es la hora de ese primer mensaje. En
un pedido por chat, el primer mensaje es el saludo: la cocina
pierde el enfoque y tiene que leer toda la conversación para
armar el pedido.

El agente del restaurante YA mueve el lead a "Nuevo pedido"
cuando toma un pedido por chat. Sus acciones son solo texto: NO
hay herramienta de pedido estructurado, así que la vía no es un
objeto nuevo ni un campo nuevo: es un mensaje de confirmación
con formato, que el board aprende a preferir.

## Qué cambia

### 1. El agente: un mensaje final de confirmación con marcador

Al confirmar un pedido por chat, el agente escribe UN mensaje
final de confirmación. No dos mensajes, no un resumen repartido:
un solo mensaje, cuya PRIMERA línea es el marcador fijo:

```
PEDIDO CONFIRMADO
```

Solo, en su propia línea, sin nada antes ni después en esa
línea. Detrás del marcador, el pedido en el MISMO formato que
`formatOrderText`, en el mismo orden de líneas:

1. Línea de identificador: `MESA: N`, `PARA LLEVAR:` o
   `DELIVERY:`, según corresponda. Por chat no hay código P-…
   (ese código lo genera la página del menú QR): no se inventa
   ninguno; el pedido por chat se identifica por Cliente.
2. `Dirección: …` solo si es delivery.
3. `Cliente: …`.
4. `Celular: …` solo si el cliente lo dio.
5. Un renglón por plato, igual que el menú: `Nx nombre`, más
   ` — nota` si hay nota, más ` — extras: a, b` si hay extras.
6. `Pago: …`, con la misma redacción del menú: `SINPE de una
   vez`, `Al repartidor` o `En el local`.
7. `Con cuánto cancela: ₡X` solo si aplica.
8. `Total: ₡X`.

Sin el encabezado "Pedido desde el menú QR": ese encabezado es
del menú; en chat lo reemplaza el marcador. El marcador es lo
que hace encontrable el mensaje; el resto es lo que hace legible
el pedido. El saludo y la conversación previa quedan como están:
esta spec no reescribe ni borra mensajes viejos.

Ejemplo de forma (los valores son ilustrativos, el formato es
el contrato):

```
PEDIDO CONFIRMADO
MESA: 4
Cliente: Andrea
2x Casado — sin cebolla — extras: aguacate
1x Fresco de cas
Pago: En el local
Total: ₡8500
```

### 2. El board: el último marcador gana; si no hay, todo igual

Para cada pedido, el selector de texto cambia de "siempre el
primer mensaje" a esta regla, en este orden:

1. Si la conversación tiene al menos un mensaje con el marcador,
   `text` = el ÚLTIMO mensaje con el marcador (el más reciente
   en orden asc por `createdAt`). Si el pedido se confirma dos
   veces, la cocina ve la última confirmación, no la primera.
2. Si no hay ningún mensaje con el marcador, fallback al primer
   mensaje, EXACTAMENTE como hoy. Así los pedidos del menú QR
   (cuyo primer mensaje es el texto formateado y no lleva
   marcador) y los pedidos viejos por chat quedan EXACTAMENTE
   igual que hoy: mismo `text`, mismo `orderedAt`.

`orderedAt` NO cambia: sigue siendo la hora del PRIMER mensaje
de la conversación, aunque el `text` elegido sea un mensaje
posterior con el marcador. La hora del pedido es cuando el
cliente empezó a pedir, no cuando el agente confirmó.

La FORMA de la respuesta del board NO cambia: los mismos campos
`BoardOrder` (`leadId`, `stageId`, `name`, `text`, `orderedAt`,
`conversationId`), las mismas etapas, el mismo orden de
tarjetas (descendente, spec 040). No se rompe el contrato
`/api/bot/*`: no se quita ni se renombra ningún campo, no se
agrega ninguno obligatorio.

### 3. Función pura para el selector + tests

El selector vive como función pura junto a `assembleOrderBoard`
(`src/server/orders/board.ts`), para poder probarla sin BD. Su
contrato:

- Entrada: los mensajes de UNA conversación, en orden asc por
  `createdAt`, cada uno con su `text` (que puede ser nulo) y su
  `createdAt`. El orden asc lo garantiza hoy la consulta de
  `getOrderBoard`; la función no reordena.
- Detección del marcador: un mensaje "tiene el marcador" cuando
  su primera línea, recortada de espacios, es exactamente
  `PEDIDO CONFIRMADO`. Un marcador en una línea posterior no
  cuenta: el marcador es primera línea o no es marcador.
- Salida: el texto a mostrar (`string | null`) y, por separado,
  la hora del primer mensaje para `orderedAt` (que
  `assembleOrderBoard` ya calcula hoy y que esta spec no toca).
  - Con marcador: el texto completo del último mensaje con
    marcador, incluida la línea del marcador (que hace de
    encabezado en la cocina, como "Pedido desde el menú QR" lo
    hace en el menú).
  - Sin marcador: el texto del primer mensaje, como hoy
    (incluido `null` si ese primer mensaje no tiene texto).
  - Sin mensajes: `null`, como hoy.
- La función no escribe en BD, no consulta nada y no cambia el
  modelo de datos.

Pruebas unitarias (vitest, en `tests/unit/bot-board.test.ts`,
donde ya vive `assembleOrderBoard`):

1. Con marcador usa el último marcador: conversación con saludo,
   detalle y DOS mensajes con marcador → el `text` es el segundo
   marcador, no el primero ni el saludo.
2. Sin marcador usa el primer mensaje: conversación de chat sin
   ningún marcador → el `text` es el primer mensaje, como hoy.
3. Pedido del menú sin cambios: conversación con un solo mensaje
   igual al de `formatOrderText` (encabezado "Pedido desde el
   menú QR", sin marcador) → el `text` es ese mensaje y
   `orderedAt` es su hora, idénticos a hoy.
4. Recomendadas (no opcionales en espíritu, pero fuera del
   mínimo): `orderedAt` sigue siendo la hora del primer mensaje
   aunque el texto sea un marcador posterior; un `PEDIDO
   CONFIRMADO` que aparece en una línea posterior de un mensaje
   no cuenta como marcador; conversación sin mensajes → `text`
   `null` y `orderedAt` `null`.

## Lo que NO entra

- Cambios a `src/server/leads/stage-history.ts`: `lead.stage_id`
  solo se escribe ahí. El agente ya mueve el lead a "Nuevo
  pedido" por ese camino; esta spec no abre otra puerta.
- Cambios al contrato `/api/bot/*`: no quitar ni renombrar
  campos, no agregar campos obligatorios. El board devuelve la
  misma forma de siempre.
- Cambios a `pantalla.html` del buzón: la pantalla sigue
  pintando `datos.orders` tal como los trae la API; el cambio es
  solo qué texto elige el selector.
- Cambios al buzón o al menú: el menú QR sigue mandando su
  texto formateado como primer mensaje y no lleva marcador; el
  buzón no se toca.
- La ruta manual-chat: queda APARCADA. No se reactiva, no se
  usa, no se mezcla con este cambio.
- Herramienta de pedido estructurado para el agente: no entra.
  Las acciones del agente siguen siendo solo texto; el formato
  lo pone el mensaje de confirmación, no un objeto nuevo.
- Migración: no cambia el modelo de datos, no hay columnas
  nuevas, no hay reescritura de mensajes viejos. Los pedidos
  viejos por chat, sin marcador, se siguen mostrando como hoy.
- Dependencias nuevas: ninguna.
- Push, PR, merge ni despliegue: esta entrega es solo la spec.
  El código lo hace otro subagente y los gates los corre el
  coordinador.

## Verificación

- Gates (los corre el coordinador, no esta spec): tsc limpio,
  eslint limpio, vitest en verde (incluidas las pruebas nuevas
  de arriba), next build OK.
- En vivo en devapp tras el merge (la hace Shey, no el autor de
  esta spec): sembrar un mensaje con el marcador en una
  conversación de pedido por chat y leer el board: la tarjeta
  debe mostrar el texto de ese mensaje (con el marcador como
  primera línea) y conservar como `orderedAt` la hora del primer
  mensaje. Y comprobar que un pedido del menú sigue igual: mismo
  texto formateado, misma hora, sin marcador.
- Criterio de aceptación: una tarjeta de pedido por chat se lee
  en la cocina sin abrir la conversación; una tarjeta de pedido
  del menú no cambia en nada; ningún pedido viejo cambia en
  nada.
