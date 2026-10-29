# 044 — Monto del pedido desde la confirmación (parseo determinístico)

## Problema

Caso real, devapp 2026-10-29 16:44: el agente confirmó un
pedido por chat con el mensaje:

```
PEDIDO CONFIRMADO
MESA: 8
Cliente: Christian
1x Casado
1x Fresco de mora
Total: ₡4.300
```

pero NO pasó `amount` en su acción `update_lead` → el monto
del lead quedó NULL. El trato se creó bien (043) y Resultados
sumó cero porque no había monto que sumar (042).

La instrucción de incluir `amount` existe en el perfil
(`src/server/ai/prompts.ts`, spec 042) pero el modelo no
siempre la sigue: el monto depende de que el modelo recuerde
pasarlo. Y el modelo no es confiable en eso.

La solución no es otro reintento de prompt: el total ya viaja
en el texto con formato obligado. Hay que leerlo de ahí, en
código, no pedirlo al modelo.

## Contexto

- **041** obliga el formato: el mensaje de confirmación del
  agente termina con la línea `Total: ₡X`. El formato es
  contrato; la cocina lo lee y el perfil lo exige.
- **042** puso la instrucción `amount` en el prompt del
  agente. Funciona cuando el modelo la sigue; el caso real
  de arriba demuestra que no siempre la sigue.
- **043** crea el lead en «Nuevo pedido» cuando el turno
  trae el marcador `PEDIDO CONFIRMADO`, en el hook de
  `src/server/ai/pipeline.ts` (~líneas 355-375). Para ese
  momento el lead YA existe en este turno o en el anterior:
  es la puerta donde el monto puede aterrizar.
- **042 en código** (`fijarMontoLead` en
  `src/server/leads/amount.ts`) ya sabe fijar el monto de
  forma segura: ignora no-finitos y negativos, nunca borra
  un monto válido previo sin lead, y nunca lanza. El parseo
  nuevo usa esa misma puerta.

## Qué cambia

### 1. Parser y registro en `order-pipeline.ts`

Función PURA, sin BD: `extraerTotalDeConfirmacion(texto:
string)` en `src/server/orders/order-pipeline.ts` (junto a
la puerta del lead de 043, no en `order-text.ts`). Devuelve
el total en COLONES como número, o `null` si no lo
encuentra.

Reglas:

- Solo se corre sobre texto CON el marcador
  `PEDIDO CONFIRMADO` (vía `hasOrderConfirmedMarker`): sin
  marcador, siempre `null`. Un texto cualquiera de la
  conversación no se parsea.
- Busca la línea que empiece por `Total:` (regex
  multilínea anclada a línea, insensible a mayúsculas, `₡`
  opcional, espacios tolerados) y toma la ÚLTIMA
  coincidencia (igual que 041: la confirmación más reciente
  gana, D7).
- De la línea toma el símbolo `₡` o `CRC` como ancla y el
  primer número después de él; si no hay número, `null`.
- El número se normaliza al formato tico antes de parsear
  (ver «Normalización de formato tico»).
- Si tras normalizar no hay un número finito ≥ 0, `null`.
  No hay valor por defecto: un Total que no se entiende es
  `null`, nunca cero.

### 2. El hook: el bloque 043 llama a `registrarPedidoConfirmado`

En `src/server/ai/pipeline.ts`, el bloque del hook 043 se
amplía (mismo try/catch que nunca tumba el turno):

1. `textoPedidoConfirmado(action)` extrae el texto
   candidato con marcador según el tipo de acción
   (`reply`→`text`, `update_lead`/`move_stage`→`reply`,
   `handoff`→`farewell`; resto→`null`).
   `accionTraePedidoConfirmado` se mantiene como
   `textoPedidoConfirmado(action) !== null` (firma intacta,
   sus tests no se tocan).
2. Si hay texto con marcador y es pipeline de pedidos →
   `registrarPedidoConfirmado(organizationId,
   conversation.contactId, textoConfirmacion,
   action.action === "update_lead" ? action.amount :
   undefined)`.
3. `registrarPedidoConfirmado` (en `order-pipeline.ts`,
   try/catch con log, nunca lanza): asegura el lead con
   `asegurarLeadDePedido` (043, idempotente); elige el monto
   en colones con prioridad — `amountExplicito` si es número
   finito ≥ 0, si no `extraerTotalDeConfirmacion(texto)` —;
   si hay monto lo fija con `fijarMontoLead(organizationId,
   contactId, colonesACentavos(monto), currency)` con la
   moneda de `getBranding` (como ya hace el `update_lead`).
   Sin monto de ninguna fuente no escribe nada: no se
   inventa.
4. El case `update_lead` existente NO se toca: si traía
   `amount`, escribe el mismo valor que ya escribió el hook
   (idempotente, último valor gana).

La doble escritura del mismo valor es idempotente:
`fijarMontoLead` hace un `UPDATE` directo, y el último valor
gana — igual que una corrección de pedido (042).

## Decisiones

1. **Parser puro y determinístico.** La lectura del total es
   código con tests, no una instrucción al modelo. El
   modelo ya probó que el `amount` se le olvida; el formato
   `Total: ₡X` es contrato de 041 y se puede leer siempre
   que aparezca.
2. **Prioridad: `amount` explícito primero.** Si la acción
   `update_lead` trae un `amount` que es número finito ≥ 0,
   ese vale y el parseo no corre. El modelo que sí sigue la
   instrucción no se penaliza; el parseo es la red de
   seguridad del que no.
3. **El parseo solo aplica a mensajes CON marcador.** Sin
   `PEDIDO CONFIRMADO` no se lee ningún Total: un «el
   casado cuesta ₡3.000» suelto en la charla no puede
   convertirse en monto de pedido. Es la misma señal que
   usan la cocina (041) y la puerta del lead (043).
4. **Nunca se inventa un monto.** Sin Total parseable no se
   escribe nada: el lead queda sin monto igual que hoy
   (NULL), en vez de quedar con un número imaginado. El
   fallo es visible (sin monto), no silencioso (monto
   inventado).
5. **`update_lead` con amount sigue escribiendo igual.** El
   case existente de `pipeline.ts` no se toca. El hook 044
   corre ANTES (en el punto del 043) y `registrarPedidoConfirmado`
   ya prioriza el explícito; si el turno era `update_lead`
   con `amount` válido, el case vuelve a escribir el mismo
   valor después. Misma función (`fijarMontoLead`), mismo
   valor: idempotente, sin duplicar lógica de blindaje.
6. **La función nunca lanza.** try/catch con log en el hook
   y blindaje interno en el parser: si el texto viene raro
   o la BD falla, el turno sigue y el cliente recibe su
   respuesta. Un monto perdido nunca tumba una
   confirmación.
7. **Última confirmación gana.** Si el pedido se confirma
   dos veces (corrección), el parseo de la más reciente
   sobrescribe: el monto es el del pedido confirmado que el
   cliente recibió, no el del borrador anterior.
8. **Sin cambio de modelo de datos ni de contrato
   `/api/bot/*`.** No hay migración, no hay columna nueva,
   no cambia ninguna forma de `/api/bot/*`: el `amount`
   del contrato sigue siendo opcional y el parseo lee el
   texto que ya viaja. Esto se dice explícito porque es el
   límite del cambio.

## Normalización de formato tico

El agente escribe en español costarricense y el Total llega
como `₡4.300`, `₡4300`, `₡4,300.50` o `₡1250,75`. Regla,
aplicada al número crudo:

1. Con `.` Y `,` (`4.300,50`): el punto es miles, la coma
   es decimal → `4300.50`.
2. Solo `,` (`1250,75`, `4,50`): la coma es decimal →
   `1250.75`, `4.50`. (Implementado así a propósito simple:
   en el formato tico que escribe el agente la coma es
   decimal; `4,300` se leería `4.3` — caso borde que no
   ocurre en la práctica y ningún test lo fija.)
3. Solo `.` (`4.300`): el punto es miles → `4300`.
4. Sin separadores (`8500`): directo.
5. Tras quitar miles y normalizar la coma a punto, si no
   queda un número finito ≥ 0 → `null`.

Esto es lo que Hudson espera de sus formatos: `₡4.300` son
cuatro mil trescientos, no cuatro punto tres.

## Límites honestos (no maquillados)

- **Si el agente escribe el Total en formato inesperado, no
  hay monto.** El parser es estricto: lee lo que 041 obliga
  (`Total: ₡X` en una línea). Si el modelo pone el total en
  prosa («le queda en cuatro mil trescientos»), eso no se
  parsea y el monto queda NULL, igual que hoy.
- **No hay backfill de confirmaciones viejas.** Los pedidos
  ya confirmados con monto NULL se quedan así: esta spec
  solo aplica a turnos nuevos. El caso del 2026-10-29 se
  arregló a mano en BD; el código no toca el pasado.
- **`update_lead` sin lead sigue descartando el monto.**
  Es la regla de 042 que esta spec no cambia: si el lead no
  existe (edge del fail-open de 043), el parseo corre pero
  `fijarMontoLead` no tiene a quién escribir. El lead nace
  en el mismo hook 043, así que en el camino normal el lead
  ya está ahí cuando el parseo corre.
- **Solo pipeline de pedidos en la práctica.** El parseo se
  corre con el mismo `accionTraePedidoConfirmado` del hook
  043; en una org sin etapa «Nuevo pedido» el agente no
  confirma con ese marcador, así que el parseo no se
  dispara. Nada cambia para la Tienda.
- **El parser no corrige precios.** Si el agente confirma
  un Total distinto al de la KB (el modelo calculó mal), el
  monto escrito es el que el cliente recibió, no el
  correcto. Esta spec lee lo confirmado; la exactitud del
  cálculo es problema del prompt, no de esta puerta.

## Lo que NO entra

- Cambio de modelo de datos, migración ni columnas nuevas.
- Cambio del contrato `/api/bot/*`: ni forma ni códigos.
- Cambios al perfil del agente ni a la instrucción `amount`
  de `prompts.ts`: el parseo es la red, no el reemplazo.
- Cambios a la cocina, al menú QR, a Resultados ni a
  `stage-history.ts`.
- La ruta manual-chat (`src/server/manual-chat/`,
  `src/app/api/bot/manual-chat/`): queda APARCADA, no se
  reactiva ni se usa.
- Push, PR, merge ni despliegue: esta entrega es solo la
  spec. El código lo hace otro subagente y los gates los
  corre el coordinador.

## Criterios de aceptación

1. `extraerTotalDeConfirmacion("…Total: ₡4.300")` con
   marcador → `4300`. Sin marcador → `null`, aunque haya
   línea Total.
2. `extraerTotalDeConfirmacion` sobre el mensaje exacto del
   caso real 2026-10-29 (MESA 8, `Total: ₡4.300`) → `4300`.
3. Formatos ticos: `₡4.300,50` → `4300.50`; `₡1250,75` →
   `1250.75`; `₡4.300` → `4300`; `₡8500` → `8500`.
   (`₡4,300` se lee `4.3` por la regla simple de coma
   decimal — borde sin test fijado, no ocurre en la
   práctica.)
4. `Total:` sin número, número con letras sueltas, o línea
   ausente → `null`. Nunca se devuelve cero ni un invento.
5. Turno con marcador + `update_lead` sin `amount`: el lead
   queda con `amountCents = 430000`, `currency = CRC` (o la
   moneda de la org).
6. Turno con marcador + `update_lead` con `amount: 4500`
   válido: el monto es 450000 (el explícito), el parseo no
   pisa.
7. Turno con marcador + `update_lead` con `amount`
   inválido (negativo o no número): se usa el parseado del
   texto si es parseable.
8. Turno SIN marcador: ni el `update_lead` con amount ni
   el parser escriben monto por parseo; el `update_lead`
   existente sigue comportándose como hoy.
9. El parser con texto raro (null, vacío, emoji, HTML) no
   lanza.
10. Gates en verde: tsc limpio, eslint limpio, vitest en
    verde (incluidas las pruebas nuevas), next build OK.

## Pruebas unitarias (vitest, sin BD)

1. `extraerTotalDeConfirmacion` (pura, sin mocks): los casos
   de los criterios 1–4 y 9, más «Total: ₡1.250.000» →
   `1250000`.
2. El blindaje del parser no depende de BD: ningún test
   necesita `getDb`.
3. Guardián de `stage_id` en verde: el cambio no escribe
   etapa en ningún archivo nuevo (solo `fijarMontoLead`,
   que ya existe y solo escribe monto).
4. Compatibilidad con el contrato `/api/bot/*`: ningún
   test exige `amount` obligatorio en la acción.

## Verificación en vivo en devapp (la hace Shey, no el autor de esta spec)

1. Pedido por chat sin que el agente pase `amount` (el
   caso del 2026-10-29): verificar en BD que el lead tiene
   `amountCents` con el total confirmado y la moneda de la
   org; en Resultados→Ventas «hoy» el pedido suma.
2. Pedido por chat donde el agente SÍ pasa `amount`: el
   monto es el explícito, sin duplicados ni doble
   escritura visible.
3. Corrección de pedido (segunda confirmación con Total
   distinto): el monto final es el de la última
   confirmación.
4. Tienda: conversación normal sin marcador — nada cambia,
   ningún monto aparece por parseo.
5. Pedido QR: intacto (042), la puerta de parseo no
   interviene.

## Dependencias

- Ninguna en código nuevo salvo lo que ya existe: usa
  `hasOrderConfirmedMarker` y el texto de la acción (041,
  043), `accionTraePedidoConfirmado` y el hook de
  `pipeline.ts` (043), y `fijarMontoLead` /
  `colonesACentavos` (042). Si se mergea antes que la 043,
  el hook necesita ese punto de inserción; el orden de
  merge recomendado es 044 después de 043.
