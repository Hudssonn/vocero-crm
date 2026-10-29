# 043 — Leads de pedidos solo con pedido confirmado

## Problema

Hoy cualquier conversación que arranca mete un lead al
pipeline, aunque no haya ningún pedido. En la soda eso es
ruido: la pantalla de cocina y el pipeline se llenan de
tarjetas de gente que solo dijo «Hola».

Hudson, tajante: «no debe salir en el pipeline un pedido que
no se ha confirmado».

## Contexto

`onLeadActivity` (`src/server/inbox/lead-activity.ts:12`)
crea un lead en la primera etapa abierta con CUALQUIER
actividad de la conversación. El flujo es: llega el primer
entrante del contacto → `ingest.ts` → `onLeadActivity` →
`createLeadForContact` → lead en la primera etapa abierta
(verificado en código).

En la soda el pipeline es de pedidos («Nuevo pedido», «En
preparación», «Listo», «Entregado»). Con el comportamiento de
hoy, el contacto que solo saluda termina como tarjeta en
«Nuevo pedido» sin que nadie haya confirmado nada.

En la Tienda el pipeline es de ventas y NO tiene etapa «Nuevo
pedido». Ahí crear el lead en el primer entrante es el
comportamiento correcto: es su manera de registrar a cada
persona que escribe. Esta spec no cambia la Tienda ni ningún
otro negocio sin pipeline de pedidos.

## Qué cambia

### 1. La puerta: solo se crea en la creación, y solo con pedido confirmado

En `onLeadActivity`, SOLO la rama de CREACIÓN del lead se
condiciona: si `await esPipelineDePedidos(organizationId)` →
`return` sin crear. Nada más.

La rama de lead existente (la que actualiza `lastActivityAt`)
no se toca: un contacto que ya tiene lead sigue registrando
actividad exactamente como hoy, confirmado o no.

### 2. Módulo nuevo `src/server/orders/order-pipeline.ts`

Tres funciones, una sola responsabilidad: decidir cuándo y
cómo nace el lead de un pedido.

- `esPipelineDePedidos(organizationId)`: devuelve `true` si la
  organización tiene una etapa llamada «Nuevo pedido», con
  query bajo `scoped()`. Ante error de BD retorna `false` y
  loguea: fail-open hacia el comportamiento viejo, no hacia
  un turno tumbado. No hay columna de bandera ni migración:
  la detección es por convención de nombre, que es la que usa
  el piloto de la soda.
- `asegurarLeadDePedido(organizationId, contactId)`: busca la
  etapa «Nuevo pedido» con `scoped()` y llama al
  `createLeadForContact` existente pasándole ese `stageId` (o
  sin `stageId` si no la encuentra, que entonces crea en la
  primera etapa abierta, como hoy). Es idempotente por el
  único `lead_contact_uq`: si el lead ya existe, no duplica.
  Nunca lanza: todo en try/catch con log. Como guard del
  Laboratorio, salta los contactos archivados (`is_test`):
  una corrida simulada no debe dejar leads de pedido reales.
- `accionTraePedidoConfirmado(action)`: función PURA. Junta
  `text` / `reply` / `farewell` según `action.action` y usa
  `hasOrderConfirmedMarker` de
  `src/server/orders/order-text.ts` — el mismo detector del
  marcador `PEDIDO CONFIRMADO` de la spec 041. Si el agente
  confirmó el pedido en este turno, esta función lo sabe; si
  no, no inventa.

### 3. El hook: antes del `move_stage`, no literalmente antes del switch

En `src/server/ai/pipeline.ts` el hook corre ANTES del bloque
`if (action.action === "move_stage")` previo al switch. El
desvío del «antes del switch» literal es justificado: ese
bloque retorna temprano, así que si el hook corriera después
del switch, el `move_stage` del turno buscaría un lead que
todavía no existe.

La lógica del hook:

- Si `accionTraePedidoConfirmado(action)` es `true` y
  `await esPipelineDePedidos(organizationId)` es `true` →
  `await asegurarLeadDePedido(organizationId,
  conversation.contactId)`.
- Todo en try/catch con log: si algo falla, el turno sigue y
  el cliente recibe su respuesta. Un fallo en la puerta de
  creación nunca tumba un turno.

El orden de llegada no importa: si la confirmación
(`update_lead` + `PEDIDO CONFIRMADO`) ocurre en un turno
antes de que el agente haga `move_stage` en otro, el lead ya
existe cuando `move_stage` corre. Y si el agente hace
`move_stage` a «Nuevo pedido» sobre un lead que
`asegurarLeadDePedido` ya puso en «Nuevo pedido», la puerta
`moveLeadToStage` ve `changed=false`: un no-op inofensivo, sin
segundo movimiento ni error.

### 4. Lo que NO se toca (regla dura)

- `/api/bot/*`: sin cambios de forma ni de códigos.
- `src/server/orders/service.ts` (QR): `createMenuOrder` crea
  su lead explícitamente por su propio camino, como hoy. Un
  pedido del menú es confirmado por definición: nunca pasa
  por la puerta nueva.
- `src/app/api/contacts/route.ts` (alta manual): sin
  cambios. Un contacto creado a mano sigue su flujo normal.
- El perfil del agente: sin cambios. Su `move_stage` a
  «Nuevo pedido» pasa a ser no-op inofensivo cuando el lead
  ya está ahí (punto 3); no hay que reescribir el prompt para
  esta spec.
- `src/server/leads/stage-history.ts`: sin cambios. El lead
  de pedido nace por `createLeadForContact` con `stageId`,
  que es el camino existente.
- Esquema de BD y `drizzle/`: sin cambios, sin migración.

## Decisiones

1. **Puerta por convención de nombre («Nuevo pedido»), NO
   por columna de bandera.** No hay migración ni configuración
   nueva: si la org tiene esa etapa, su pipeline es de
   pedidos. La Tienda y cualquier otro negocio sin esa etapa
   conservan el comportamiento viejo sin tocar nada.
2. **Fail-open en `esPipelineDePedidos`.** Ante error de BD
   retorna `false` y loguea: un fallo transitorio deja el
   comportamiento viejo por ese turno, no un turno muerto ni
   una conversación sin respuesta.
3. **Solo la rama de CREACIÓN se condiciona.** La rama de
   lead existente (`lastActivityAt`) no se toca: la
   actividad de un contacto que ya tiene lead se sigue
   registrando siempre.
4. **Punto de inserción: antes del bloque `move_stage`,
   previo al switch.** Desvío justificado del «antes del
   switch» literal: ese bloque retorna temprano, así que el
   hook debe correr antes para que el `move_stage` del turno
   encuentre el lead ya creado.
5. **Detección del pedido confirmado reutilizando el
   marcador de 041.** `accionTraePedidoConfirmado` es pura y
   usa `hasOrderConfirmedMarker`: la misma señal que lee la
   cocina, sin un segundo detector que diverja.
6. **Perfil del agente sin cambios.** Su `move_stage` a
   «Nuevo pedido» se vuelve no-op inofensivo
   (`changed=false`) cuando el lead ya está en esa etapa.
   No se abre una segunda puerta de creación ni se reescribe
   el prompt.
7. **La puerta nunca lanza.** try/catch con log en el hook
   y en `asegurarLeadDePedido`: el cliente siempre recibe su
   respuesta aunque la creación falle. Además salta
   contactos archivados (guard del Laboratorio).
8. **Ciclo de imports ESM aceptado y documentado.**
   `lead-activity.ts` ↔ `order-pipeline.ts` forman un ciclo,
   seguro porque ambos módulos se usan solo dentro de
   cuerpos de función, nunca en la evaluación del módulo. No
   hay regla `import/no-cycle` en el eslint del repo; si un
   día se agrega, el ciclo deberá romperse moviendo la
   detección a un tercer módulo.

## Límites honestos (no maquillados)

- **Chats sin pedido no generan lead en la soda: no hay
  tracking de «interesados».** Un saludo, una pregunta de
  precios, alguien que nunca confirma: nada de eso deja
  tarjeta en el pipeline. En la soda el pipeline cuenta
  pedidos confirmados, no curiosos. Si Hudson quiere después
  una vista de interesados, es otro cambio, fuera de esta
  spec.
- **`update_lead` sin lead: la nota va al contacto, el
  monto se descarta.** Es el comportamiento que ya define la
  spec 042 (`fijarMontoLead`: sin lead, el monto se ignora en
  silencio). En la soda, un chat que confirma sin haber
  pasado por la puerta (edge: fail-open, punto 2) guarda su
  nota pero no su monto.
- **QR y alta manual intactos.** El menú QR y la creación
  manual de contactos no pasan por la puerta: crean leads
  como hoy.
- **El fail-open tiene un edge visible.** Si la detección
  falla por un error transitorio de BD en el turno exacto
  del primer «Hola», ese contacto crea lead como antes. Se
  loguea; no es silencioso.
- **Renombrar la etapa desactiva la puerta.** Si alguien
  renombra «Nuevo pedido» en la soda, la detección deja de
  verla y vuelve el comportamiento viejo. La convención es
  el contrato: documentado, no validado por código.

## Lo que NO entra

- Columna de bandera, migración ni configuración por
  organización.
- Vista o tracking de «interesados» en la soda.
- Cambios al perfil del agente ni a sus reglas de saludo o
  pedido.
- Cambios a `src/server/leads/stage-history.ts`, al
  contrato `/api/bot/*`, a la pantalla de cocina, al menú QR
  ni a Resultados.
- La ruta manual-chat: queda APARCADA, no se reactiva ni se
  usa.
- Push, PR, merge ni despliegue: esta entrega es solo la
  spec. El código lo hace otro subagente y los gates los
  corre el coordinador.

## Criterios de aceptación

1. Contacto nuevo dice «Hola» a la soda: no se crea ningún
   lead, el pipeline no muestra tarjeta nueva.
2. El agente confirma un pedido por chat (mensaje con
   `PEDIDO CONFIRMADO` en la acción del turno): el lead se
   crea en «Nuevo pedido». Si el agente después hace
   `move_stage` a «Nuevo pedido», no hay duplicado ni error
   (`changed=false`).
3. Tienda (sin etapa «Nuevo pedido»): contacto nuevo dice
   «Hola» y el lead se crea en la primera etapa abierta,
   exactamente como hoy.
4. Pedido del menú QR: lead creado con su monto (042
   intacto); la puerta nueva no interviene.
5. `update_lead` con `amount` en un chat sin lead: la nota
   se guarda en el contacto y el monto se descarta sin
   tumbar el turno.
6. Contactos archivados del Laboratorio: la puerta los
   salta, no crean leads de pedido.
7. Gates en verde: tsc limpio, eslint limpio, vitest en
   verde (incluidas las pruebas nuevas), next build OK.

## Pruebas unitarias (vitest, sin BD)

1. `accionTraePedidoConfirmado` (pura, sin mocks de BD):
   acción `reply` con marcador → `true`; `text` sin
   marcador → `false`; `farewell` con marcador → `true`;
   acción sin texto → `false`; marcador en línea posterior
   (no primera línea) → `false`, igual que el detector de
   041.
2. `esPipelineDePedidos` fail-open: con la consulta
   lanzando error → retorna `false` (mock de BD que lanza).
3. `asegurarLeadDePedido` nunca lanza: con
   `createLeadForContact` lanzando → la función resuelve
   sin propagar (mock).
4. Guardián existente de `stage_id` en verde: ningún archivo
   nuevo escribe `stage_id` fuera de
   `src/server/leads/stage-history.ts`.

## Verificación en vivo en devapp (la hace Shey, no el autor de esta spec)

1. Contacto nuevo escribe «Hola» a la soda por WhatsApp:
   verificar en BD que NO se creó lead y que el pipeline no
   muestra tarjeta nueva. Repetir con una pregunta de
   precios sin confirmar: mismo resultado.
2. Seguir la conversación hasta que el agente confirme el
   pedido (mensaje `PEDIDO CONFIRMADO`): verificar en BD que
   el lead se creó en «Nuevo pedido», con `orderedAt` en la
   hora del primer mensaje (041 intacto). Dejar que el
   agente haga su `move_stage`: sin duplicados en el
   pipeline.
3. Tienda: contacto nuevo escribe «Hola»: el lead se crea en
   la primera etapa abierta, como siempre. Sin cambios.
4. Pedido QR con total (ej.: Imperial + Stella = ₡4300):
   el lead se crea con `amountCents = 430000` y `CRC` (042
   intacto); la puerta nueva no interviene.
5. Alta manual de un contacto desde la UI: el flujo es el
   mismo de siempre, la puerta no interviene.
6. Pedido por chat completo Nuevo → En preparación → Listo
   → Entregado: el tablero y Resultados funcionan como hoy;
   la única diferencia es que el lead nació al confirmar,
   no al saludar.

## Dependencias

- Ninguna. 043 es independiente de 041 y 042 en código, y
  convive con ambas: el marcador de 041 es la señal que usa
  la puerta, y el monto de 042 sigue aterrizando en el lead
  que la puerta crea (o descartándose sin lead, según la
  regla honesta de arriba). Si 043 se mergea antes o después
  que ellas, el orden no importa.
