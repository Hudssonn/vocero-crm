# 039 — Ficha oculta en pedidos; la tarjeta enseña cuánto tardó la entrega

## Contexto

038 dejó el cajón del pipeline sin Monto ni "Sin teléfono" en
pedidos del menú, pero la sección "Ficha" seguía ahí, siempre vacía:
la Ficha es la ficha del contacto (datos que el agente averigua
conversando + notas manuales) y el pedido llega por el menú, no por
chat, así que nunca hay nada que averiguar. Y la tarjeta de un
pedido en curso decía "Sin actividad" aunque el pedido acababa de
entrar: el lead nacía con `lastActivityAt` null. Con eso, tampoco
había forma de ver cuánto tardó un pedido en entregarse.

Esta spec hace las dos cosas, sin tocar el modelo ni las
escrituras de la bitácora.

## A. Ficha oculta en pedidos

Cajón (`src/components/pipeline/lead-drawer.tsx`): la sección
"Qué se sabe" (`<FichaPanel>`) NO se renderiza cuando el lead es
un pedido del menú (`lead.orderText != null`). Para leads comunes
(`orderText === null`) queda exactamente igual.

La marca de "pedido del menú" es la misma de 037/038:
`lead.orderText !== null`. La carga de la ficha (`cargarFicha`)
sigue corriendo al abrir el cajón porque de ahí sale también el
anuncio de origen, que sí se enseña; lo único que cambia es que
no se pinta el panel.

## B. Hora del pedido: fuera el "Sin actividad"

`createMenuOrder` (`src/server/orders/service.ts`) pasa
`at: new Date()` a `createLeadForContact`. Esa función YA acepta
`at` y lo guarda en `lastActivityAt`
(`lastActivityAt: input.at ?? null` en
`src/server/inbox/lead-activity.ts`), así que la tarjeta de un
pedido en curso muestra "Actividad: {hora del pedido}" (la tarjeta
ya renderiza eso cuando `lastActivityAt` no es null).

NO se modifican `lead-activity.ts` ni `stage-history.ts`: solo se
pasa `at` al crear el pedido y solo se lee `leadStageEvent`.
Efecto colateral, coherente y no un cambio de conducta: el evento
de creación del lead (`recordLeadCreated`) también recibe esa
hora como `occurredAt`, porque `createLeadForContact` ya se la
pasaba antes cuando venía `at`.

## C. Duración de entrega: datos, formato y dónde se muestra

### Datos, sin cambiar el modelo

- Hora del pedido: `lead.createdAt`. El lead se crea con el
  pedido, y la ruta del tablero ya selecciona la fila completa del
  lead, así que `createdAt` está disponible ahí sin consulta extra.
- Hora de entrega: `occurredAt` del evento MÁS RECIENTE en
  `leadStageEvent` para ese lead donde `toStageId` es la etapa
  actual del lead. La etapa actual "Entregado" se identifica por
  `kind === "won"` en la etapa del lead (la ruta del tablero ya
  trae todas las etapas con su `kind`: se arma un mapa stageId →
  kind). NUNCA se identifica la etapa por su nombre, porque los
  nombres se pueden editar.
- El evento de creación del lead (`recordLeadCreated`, con
  `toStageId` = etapa de creación) no interfiere: para pedidos del
  menú esa etapa es "Nuevo pedido", no la de entrega, así que el
  filtro por `toStageId` = etapa actual ya lo deja fuera.
- Duración = hora de entrega − hora del pedido. NO se escribe ni
  se inventa ningún evento; solo se lee.

### Formato (función pura)

`formatDeliveryDuration(orderedAt, deliveredAt)` en
`src/server/orders/order-text.ts`, junto al helper de texto de
pedidos (la ruta solo la llama, regla `route.ts` del fork: la
ruta exporta solo handlers):

| Caso | Salida |
|---|---|
| Menos de 60 min | "X min" (ej. "23 min") |
| 60 o más | "X h YY min", minutos a dos dígitos (ej. "1 h 05 min") |
| Duración 0 | "0 min" |
| Negativa (reloj) | Se limita a 0 → "0 min" |

Los segundos de más se truncan (23 min 59 s son "23 min").

### Elección del evento (función pura)

`latestDeliveryByLead(events, leads)` en el mismo módulo: para
cada lead, gana el evento más reciente cuyo `toStageId` sea su
etapa actual; eventos de otros leads, hacia otras etapas o sin
etapa destino se ignoran; en empate de hora gana el primero que
llegó en la lista.

### API: `GET /api/pipeline/board`

`src/app/api/pipeline/board/route.ts` agrega por lead un campo
`deliveredIn: string | null`: SOLO para pedidos del menú
(`orderText != null`) cuya etapa actual tiene `kind === "won"` y
con evento de entrega encontrado; en cualquier otro caso `null`.
No se cambia nada de lo que la API ya devuelve (solo se agrega
este campo; el cálculo de `orderText` se factorizó a un mapa
previo, con el mismo resultado).

Sin N+1: los eventos de entrega se resuelven en UNA sola consulta
para todos los leads entregados del tablero (`leadId IN (...)`
sobre `leadStageEvent`), y la selección del más reciente la hace
la función pura. Si no hay leads entregados, no se consulta nada.

### Tarjeta y cajón

- `BoardLead` en `src/components/pipeline/pipeline-client.tsx`
  gana `deliveredIn: string | null`.
- Tarjeta (donde hoy dice `lead.lastActivityAt ? "Actividad: …"
  : "Sin actividad"`): si el lead es pedido del menú y
  `deliveredIn` no es null → "Entregado en {duración}" en lugar
  de la línea de actividad. Si es pedido del menú sin duración
  (en curso, o entregado sin evento) → "Actividad: {hora del
  pedido}" (gracias al fix B). Para leads comunes, todo queda
  exactamente igual ("Actividad: {hora}" / "Sin actividad").
- Cajón (`lead-drawer.tsx`, sección "Pedido", donde se pinta
  `lead.orderText`): para un pedido del menú entregado con
  duración conocida, debajo del texto del pedido sale la línea
  "Entregado en {duración}". Sin duración, no se muestra nada
  extra. La comprobación usa valor truthy (`deliveredIn && …`),
  así que una respuesta vieja sin el campo tampoco pinta basura.

## Cambios en el código

- `src/server/orders/service.ts`: `at: new Date()` al crear el
  lead del pedido.
- `src/server/orders/order-text.ts`: `formatDeliveryDuration`,
  `latestDeliveryByLead` y el tipo `DeliveryEventRow` (puras, sin
  base de datos).
- `src/app/api/pipeline/board/route.ts`: campo `deliveredIn`,
  mapa stageId → kind, una consulta de eventos de entrega.
- `src/components/pipeline/pipeline-client.tsx`: `deliveredIn`
  en `BoardLead` y línea de actividad condicional en la tarjeta.
- `src/components/pipeline/lead-drawer.tsx`: Ficha oculta en
  pedidos; línea "Entregado en …" en la sección Pedido.
- Pruebas: `tests/unit/order-delivery.test.ts` (nuevo, 13
  pruebas): `createMenuOrder` pasa `at` = ahora a
  `createLeadForContact` (base simulada, patrón de
  agenda-context.test.ts), formato de duración (minutos,
  horas+minutos, 0, negativa, truncado de segundos) y elección
  del evento de entrega más reciente (creación ignorada, otras
  etapas y otros leads ignorados, empate).

## Lo que NO entra

- Cambios a `stage-history.ts` ni a `lead-activity.ts` (ni a sus
  escrituras: la única puerta que escribe `lead.stage_id` sigue
  intacta; el guardarraíl `stage-history-guard.test.ts` lo cubre).
- Cambios para leads comunes: Monto, "+ monto", teléfono, Ficha y
  actividad quedan iguales cuando `orderText` es null.
- Pantalla de cocina, `/api/estado`, "En espera", buzón/menú:
  esta tarea es SOLO Vocero.
- Cambios a pedidos viejos ya creados: conservan lo que tienen.
  La duración solo sale en pedidos entregados con evento
  registrado; los ya entregados con evento guardado también la
  mostrarán, porque el evento ya está en BD.
- Migración: no hay cambios de esquema de base de datos.

## Verificación

- Gates: tsc limpio, eslint limpio, vitest 1214/1214 (1201
  previos + 13 nuevos), next build OK.
- No hay tests de componentes del cajón ni de la tarjeta en
  `tests/unit/` (se buscó: ningún test cubre `lead-drawer` ni
  `pipeline-client`); la verificación del cajón y la tarjeta es
  por revisión de código + tsc + build, como en 038.
- El camino con BD real no tiene cobertura en la suite: como en
  033–038, bot-orders es puro y sin base de datos. La prueba de
  `createMenuOrder` fija el contrato con base simulada
  (`at` = ahora); el valor guardado en `lastActivityAt` se
  confirma en vivo en devapp tras el merge (Principio IX).
- En vivo en devapp tras el merge (Principio IX): mandar un
  pedido nuevo y verificar que la tarjeta ya no dice "Sin
  actividad" sino "Actividad: {hora del pedido}", que el cajón
  no enseña la sección Ficha y que al moverlo a Entregado la
  tarjeta dice "Entregado en {duración}" y el cajón muestra la
  misma línea bajo el texto del pedido; abrir un lead común y
  verificar que Ficha, Monto, "+ monto", teléfono y actividad
  siguen exactamente igual. Sin migración y sin despliegue en
  esta entrega: solo código local, sin push ni PR.
