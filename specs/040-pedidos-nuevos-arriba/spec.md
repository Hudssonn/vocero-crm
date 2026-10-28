# 040 — Pedidos nuevos arriba: la tarjeta nueva entra primero

## Contexto

Tanto en el pipeline como en la pantalla de cocina, las tarjetas
se ordenaban por posición ascendente: el pedido más viejo quedaba
arriba y el nuevo entraba abajo, donde nadie lo veía primero. Los
leads nuevos ya nacen con `maxPos + 1` (la posición más alta, en
`src/server/inbox/lead-activity.ts`), así que basta con dar vuelta
el orden: con sort descendente, el nuevo queda arriba solo, sin
migración ni reescritura de posiciones en BD.

## Qué cambia

### Pipeline (API + cliente)

- `GET /api/pipeline/board` (`src/app/api/pipeline/board/route.ts`):
  los leads pasan de `orderBy(asc(schema.lead.position))` a
  `orderBy(desc(schema.lead.position))`. Solo cambia el orden de
  las TARJETAS: las etapas siguen ascendentes, los mensajes siguen
  ascendentes por fecha (de ahí sale el primer mensaje, el texto
  del pedido) y los eventos de entrega siguen ascendentes por
  fecha (el más reciente lo elige la función pura, no el orden).
- Cliente (`src/components/pipeline/pipeline-client.tsx`): el sort
  de cada columna pasa de `(a, b) => a.position - b.position` a
  `comparePositionDesc` (`src/lib/pipeline-order.ts`, puro): mayor
  primero. El cliente reordena lo que trae la API, así que los dos
  lados tienen que decir lo mismo; si solo cambiara uno, el
  refetch reordenaría la columna bajo los pies del dueño.

### Pantalla de cocina (API; la página NO se toca)

- `getOrderBoard` (`src/server/orders/board.ts`): los leads pasan
  de `orderBy(asc(schema.lead.position))` a
  `orderBy(desc(schema.lead.position))`. Las etapas siguen
  ascendentes.
- `pantalla.html` (VPS, `/opt/dsh/prueba/menu-qr-soda/`): NO se
  toca. Se leyó entera: solo filtra `datos.orders` por etapa
  (`Nuevo pedido`, `En preparación`) y pinta en el orden que
  trae; `filter` conserva el orden de entrada, así que el orden
  descendente de la API llega tal cual a la cocina. Tampoco se
  toca `server.js` ni `index.html`: `pantalla-datos` es un proxy
  puro hacia `GET /api/bot/board` (que usa `getOrderBoard`), sin
  orden propio.

### Arrastre: lo que realmente hace hoy, y qué cambió

Lectura exacta del código, no suposición: el arrastre NO calcula
una posición a partir de vecinos, porque no hay vecinos que
calcular. El destino es la columna entera (`useDroppable` en
`StageColumn`) y `onDragEnd` solo sabe a qué etapa cayó
(`event.over.id`); no existe un hueco "entre dos tarjetas" como
destino, y reordenar dentro de la misma columna tampoco existe
(`onDragEnd` ignora el arrastre si la etapa destino es la misma
que la de origen). El cálculo viejo era:

```ts
const position = leads.filter((l) => l.stageId === overStage).length;
```

es decir, la CANTIDAD de tarjetas en la columna destino. Con
orden ascendente eso dejaba la tarjeta soltada abajo (más o menos:
con huecos empataba, ver abajo). Con orden descendente, la misma
fórmula ya no garantiza nada: no es necesariamente mayor que la
del actual primero.

El cálculo nuevo (`dropPositionAtTop` en
`src/lib/pipeline-order.ts`, puro y probado) es:

```ts
dropPositionAtTop(posicionesDestino) =
  posicionesDestino.length === 0 ? 0 : Math.max(...posicionesDestino) + 1;
```

Y lo usa `moverLead` en `pipeline-client.tsx` (el mismo camino
que el arrastre y que "mover desde el cajón"). Por qué funciona
con el nuevo orden, punto por punto:

- La tarjeta soltada recibe una posición MAYOR que la de todas
  las de la columna destino, así que con sort descendente queda
  ARRIBA de esa columna, sin empate. Toda tarjeta soltada
  aterriza arriba: es el único extremo que el gesto de hoy puede
  prometer, y es coherente con "lo nuevo arriba".
- Con huecos no empata: si la columna destino tiene posiciones
  0 y 2 (una tarjeta salió), la cantidad es 2 y ya hay una
  tarjeta con 2; `max + 1` da 3.
- Nunca es negativa, que es lo que exige el PATCH del lead
  (`position: z.number().int().min(0)` en
  `src/app/api/pipeline/leads/[id]/route.ts`). Por eso "soltar
  abajo con una posición menor que la del último" NO se puede
  prometer en general como gesto: si el último tiene 0, menor
  sería −1 y el PATCH lo rechaza.
- La actualización optimista usa la misma posición, y el
  `refetch` posterior reordena con el mismo comparador, así que
  la tarjeta no salta de sitio al confirmarse.

Lo que NO cambia el arrastre: seguir sin poder soltar una
tarjeta en medio o abajo de una columna, ni reordenar dentro de
la misma columna. Eso exigiría destinos por tarjeta (sortable),
renumerar o posiciones fraccionarias, y el PATCH solo acepta
enteros ≥ 0: es trabajo aparte, fuera de esta spec, y no se
inventó aquí un sortable a medias.

Nota aparte, sin cambio: el botón de la cocina ("Empezar" /
"Listo") mueve por `POST /api/bot/orders/[id]/stage` con solo
`{ to }`, sin posición, así que `moveKitchenOrder` conserva la
posición vieja. Un pedido movido desde la cocina mantiene su
rango relativo en la columna destino según su posición vieja
(si era el más nuevo, queda arriba; si era el más viejo, abajo).
Eso no se tocó.

## Alcance: global en el pipeline, solo pedidos en la cocina

El cambio de orden del pipeline es GLOBAL para el tablero (todas
las instancias que usan ese tablero), porque una columna puede
mezclar leads comunes y pedidos del menú y no existe un tablero
solo-pedidos: no se puede dar vuelta solo para pedidos sin
romper el orden de la columna. La pantalla de cocina sí es solo
pedidos (sus etapas son las de pedidos). No se cambió nada fuera
de los archivos listados abajo.

## Cambios en el código

- `src/app/api/pipeline/board/route.ts`: `desc` en leads (línea
  36, antes `asc`); etapas, mensajes y eventos sin cambio.
- `src/server/orders/board.ts`: `desc` en leads (línea 112,
  antes `asc`); etapas sin cambio.
- `src/components/pipeline/pipeline-client.tsx`: sort de columna
  con `comparePositionDesc`; `moverLead` con `dropPositionAtTop`.
- `src/lib/pipeline-order.ts` (nuevo, puro): `comparePositionDesc`
  y `dropPositionAtTop`, con el porqué en comentarios.
- Pruebas: `tests/unit/pipeline-order.test.ts` (nuevo, 10
  pruebas): sort descendente (nuevo arriba), posición mayor que
  el primero → arriba, entre dos vecinas → en medio, menor que
  el último → abajo, `dropPositionAtTop` en columna vacía,
  contigua, con huecos y desordenada, resultado arriba con sort
  descendente, y nunca negativo. `tests/unit/bot-board.test.ts`:
  `assembleOrderBoard` conserva el orden de entrada (no reordena
  a ascendente), así que el `desc` de la consulta llega a la
  cocina.
- `pantalla.html`: sin cambios (ver arriba por qué).

## Lo que NO entra

- Migración ni reescritura de posiciones en BD.
- Cambios a `stage-history.ts`, `lead-activity.ts`, `server.js`,
  `index.html` ni `pantalla.html` del buzón.
- Cambios al orden de las etapas (columnas), que siguen
  ascendentes en ambos tableros.
- Reordenar dentro de una columna, soltar en medio/abajo, ni
  sortable por tarjeta (ver "Arrastre").
- Cambios para pedidos viejos ya creados: conservan su posición;
  solo cambia el orden en que se pintan (el más viejo queda
  abajo, no se mueve de columna ni se reescribe).
- Push, PR ni despliegue: esta entrega es solo código local.

## Verificación

- Gates: tsc limpio, eslint limpio, vitest 1225/1225 (1214 previos
  + 11 nuevos), next build OK.
- No hay tests de componentes del pipeline en `tests/unit/` (se
  buscó: ningún test cubre `pipeline-client`); la verificación
  del cliente es por revisión de código + la lógica pura probada
  + tsc + build, como en 038/039.
- El camino con BD real no tiene cobertura en la suite (como en
  033–039): el `desc` de las consultas se confirma en vivo en
  devapp tras el merge (Principio IX).
- En vivo en devapp tras el merge (Principio IX): mandar un
  pedido nuevo y verificar que queda ARRIBA en el pipeline y en
  la pantalla de cocina; arrastrar una tarjeta a otra columna y
  verificar que queda arriba de la columna destino; abrir un
  lead común y verificar que su columna también ordena nuevo
  arriba (cambio global, por diseño).
