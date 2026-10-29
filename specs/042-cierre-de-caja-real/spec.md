# 042 — Cierre de caja real: monto en cada pedido y descarga del cierre en Resultados

## Contexto

Hoy el total de un pedido vive solo en texto. Los pedidos del
menú QR traen el total en el mensaje formateado de
`formatOrderText` (`src/server/orders/service.ts`) y los pedidos
por chat lo traen en la conversación, pero la columna
`lead.amount_cents` queda en NULL en los dos casos (verificado
en devapp: todos los pedidos recientes tienen `amountCents` y
`currency` en NULL). La tabla ya tiene las dos columnas; no hace
falta migración ni cambio de modelo.

Eso deja el cierre roto en dos puntas:

1. Resultados → Ventas (`src/server/analytics/sales.ts`,
   `salesBlock` + `clasificarCierres`) ya suma `amountCents` de
   los leads ganados en la moneda del negocio. Como ningún
   pedido guarda monto, el total en colones del día sale vacío
   aunque la soda haya vendido. En Resultados NO hay que cambiar
   nada: el problema está antes, en que nadie escribe el monto.
2. Hoy NO existe ninguna exportación en Resultados (verificado
   por grep): el dueño no puede descargar el cierre del período
   en un archivo que abra en Excel.

El piloto es «Soda La Esquina» en devapp, pero el cambio es del
producto: al desplegarse aplica a todas las instancias. La
moneda es la de la marca de la organización
(`getBranding(orgId).currency`, respaldo `DEFAULT_CURRENCY =
CRC` en `src/lib/money.ts`) y los montos se guardan en centavos
enteros, como todo el dinero del sistema.

## Qué significa «cierre» en esta spec (léase antes de verificar)

Resultados → Ventas cuenta un lead cuando su desenlace en el
período es una etapa de tipo `won` (último movimiento del lead
en el rango, según `desenlacesDelPeriodo` en `sales.ts`), y suma
su monto ACTUAL, no un histórico. En pedidos eso significa:
**el cierre del día es lo ENTREGADO en el día**. La etapa
«Entregado» de pedidos ya es `kind: "won"`
(`ORDER_STAGES` en `src/server/orders/service.ts`), así que un
pedido con monto que sigue en «Nuevo pedido», «En
preparación» o «Listo» NO entra en el total de Ventas hasta que
el personal lo pasa a «Entregado». Esto no es un bug que esta
spec arregle: es la semántica de Ventas que ya existe, y la
exportación de esta spec usa la MISMA población para que
pantalla y archivo cuadren. Si el dueño espera que el cierre
cuente pedidos sin entregar, eso es otro cambio, fuera de esta
spec.

## Qué cambia

### 1. Pedidos QR: el monto nace con el lead

`createMenuOrder` (`src/server/orders/service.ts`) ya recibe el
total en colones en el payload (`menuOrderSchema`: `total`,
`z.number().min(0)`). A partir de esta spec:

- `createLeadForContact` (`src/server/inbox/lead-activity.ts`)
  acepta dos campos opcionales nuevos: `amountCents` (entero) y
  `currency` (código ISO). Opcionales a propósito: los demás
  llamadores (webhook, captura manual) no los pasan y siguen
  exactamente igual.
- `createMenuOrder` los pasa en la creación:
  `amountCents = Math.round(input.total * 100)` y
  `currency = (await getBranding(organizationId)).currency`
  (con `DEFAULT_CURRENCY` como respaldo). El monto queda
  guardado en el MISMO `insert` del lead, no en un `update`
  posterior.
- Camino duplicado (reintento del mismo `orderId`): hoy
  `createMenuOrder` devuelve el lead ya existente sin tocarlo.
  Si ese lead existente tiene `amountCents` NULL, se le fija el
  monto del pedido (mismo cálculo, misma moneda). Si ya tiene
  monto, NO se pisa: un reintento nunca sobrescribe un monto
  que alguien pudo corregir a mano. Esta es la única escritura
  posterior a la creación, y solo cubre el hueco del reintento.

No cambia nada del contrato `/api/bot/*`: el payload del menú
sigue igual, no se agrega ninguna llave obligatoria ni se quita
o renombra ninguna. El texto formateado del pedido no cambia.

### 2. Pedidos por chat: `update_lead` gana un campo de monto opcional

La acción `update_lead` hoy SOLO guarda notas
(`src/server/ai/actions.ts:12`, ejecución en
`src/server/ai/pipeline.ts` con `appendLeadNote`). A partir de
esta spec:

- El esquema Zod gana un campo opcional:
  `amount: z.number().optional()` — total del pedido EN
  COLONES, no en centavos. En colones porque es el número que
  el agente ya escribe en su mensaje («Total: ₡4300»): pedirle
  centavos lo obligaría a multiplicar por 100 y equivocarse.
- La descripción de la acción en el prompt
  (`src/server/ai/prompts.ts:91`) se actualiza a:
  `update_lead` guarda una nota del lead y, opcionalmente, su
  monto; al confirmar un pedido, incluye `amount` con el total
  en colones que estás confirmando en `reply`. Regla para el
  agente: el monto es SOLO el total ya confirmado al cliente
  en ese mismo mensaje; nunca se inventa ni se estima.
- Ejecución (`pipeline.ts`, caso `update_lead`): si la acción
  trae `amount`, se llama a la función nueva
  `fijarMontoLead` (archivo nuevo `src/server/leads/amount.ts`)
  con `amountCents = Math.round(amount * 100)` y
  `currency = (await getBranding(organizationId)).currency`.
  La función busca el lead por `contactId` de la conversación,
  con `scoped()`; si no hay lead, el monto se ignora en
  silencio (la nota igual se guarda); si lo hay, actualiza
  `amountCents`, `currency` y `updatedAt`. Cada confirmación
  con monto sobrescribe el anterior: la última confirmación
  gana, igual que una corrección de pedido.
- Blindaje (el monto viene de un modelo, no de un humano):
  `fijarMontoLead` ignora montos no finitos o negativos y
  nunca lanza una excepción que tumbe el turno: la nota y la
  respuesta al cliente se preservan aunque el monto se
  descarte. Un monto inválido no borra un monto válido previo.
- NO se crea una acción combinada «confirmar + mover etapa»:
  el contrato de UNA acción por turno se mantiene. El agente
  sigue moviendo el lead a «Nuevo pedido» con `move_stage`
  como hoy y confirma con `update_lead` como hoy; el monto
  aterriza en el mismo lead (por contacto) sin importar en qué
  orden ocurran ambas acciones.
- `fijarMontoLead` NO toca `lead.stage_id`: solo escribe
  `amountCents`, `currency` y `updatedAt`. La prueba
  guardián `tests/unit/stage-history-guard.test.ts` (que
  escanea `src/` buscando escrituras de `stage_id` fuera de
  `src/server/leads/stage-history.ts`) sigue pasando sin
  cambios.

### 3. Resultados: botón para descargar el cierre del período

- Botón en el encabezado de `ResultsClient`
  (`src/components/results/results-client.tsx`), junto al
  `RangePicker`, con el texto «Descargar cierre (CSV)». Es un
  enlace (`<a>`) a la ruta de descarga con el MISMO rango
  elegido (`from`/`to` del estado `range`): hoy, 7 días, 30
  días, este mes, mes pasado, 90 días o rango personalizado,
  todo fluye por los mismos parámetros que ya usan los bloques.
  Enlace y no `fetch` + blob: la sesión viaja en la cookie y
  el navegador descarga el archivo sin código extra de
  autenticación.
- Ruta nueva `GET /api/analytics/cierre` (archivo
  `src/app/api/analytics/cierre/route.ts`): interna, con
  sesión (`withAuth`, como la ruta de ventas). NO es una ruta
  `/api/bot/*` ni acepta `organizationId` por parámetro: la
  organización sale siempre de la sesión. La `route.ts` solo
  exporta el handler; toda la lógica vive en
  `src/server/analytics/cierre.ts`.
- Validación del período: reutiliza `periodFromRequest`
  (`src/server/analytics/period.ts`), la misma que usa la ruta
  de ventas — fechas `AAAA-MM-DD`, inicial antes que final,
  máximo 366 días — y mapea `PeriodError` a 422 con el mismo
  patrón de la ruta de ventas. No se inventa un validador
  nuevo para lo mismo.
- Población del archivo: EXACTAMENTE la de Ventas. Los leads
  cuyo desenlace en el período es `won` (mismo DISTINCT ON
  sobre `leadStageEvent` que `desenlacesDelPeriodo`), sin
  contactos del Laboratorio (`notLabContact`), con
  `scoped()` sobre la organización de la sesión. La fecha de
  cada fila es la fecha del evento de cierre en la zona del
  negocio, no la fecha de creación del lead: un pedido creado
  ayer y entregado hoy cierra hoy.
- Columnas exactas, en este orden (encabezado literal):

  ```
  Fecha;Cliente;Mesa o código;Total (₡);Etapa
  ```

  - `Fecha`: `AAAA-MM-DD` del cierre, en la zona del negocio.
  - `Cliente`: nombre del contacto del lead.
  - `Mesa o código`: para pedidos del menú, el prefijo del
    nombre del contacto antes de ` · ` (contrato de la spec
    038: «Mesa 4 · Andrea», «Para llevar P-9202 · Andrea»);
    vacío en pedidos por chat, cuyo contacto no lleva
    identificador. Es un derivado del nombre, NO una columna
    nueva: no hay migración.
  - `Total (₡)`: monto del lead en colones. Vacío cuando el
    lead no tiene monto (pedidos viejos, decisión 5) o cuando
    su moneda no es la del negocio (misma regla `sumable` de
    `src/lib/money.ts` que usa Ventas: jamás se convierte
    moneda, jamás se inventa un tipo de cambio).
  - `Etapa`: nombre de la etapa de cierre (en la soda,
    «Entregado»; en otros negocios, su etapa `won`).
- Orden de filas: fecha ascendente, luego cliente.
- Fila final de total: `TOTAL` en la primera columna, la suma
  de la columna `Total (₡)` en la cuarta y el resto vacío
  (`TOTAL;;;4300,00;`). Suma SOLO las filas con monto en la
  moneda del negocio, igual que `wonCents` en Ventas. Si no hay
  filas, el archivo trae encabezado + `TOTAL;;;0,00;`: nunca
  un archivo vacío.
- Formato del archivo (CSV para Excel en español, sin
  dependencias nuevas):
  - Delimitador punto y coma (`;`): en Excel en español la
    coma es separador decimal, así que la coma como
    delimitador partiría los números.
  - Codificación UTF-8 con BOM (`\uFEFF` al inicio) para que
    los acentos no salgan rotos al abrir con doble clic.
  - Saltos de línea CRLF, los que espera Excel en Windows.
  - Números en colones con coma decimal y 2 decimales
    (`4300,00`), para que Excel en español los lea como
    números y no como texto.
  - Escape CSV estándar: un campo que contenga `;`, comillas
    o salto de línea va entre comillas dobles, y cada comilla
    doble dentro se duplica.
- Respuesta HTTP: `Content-Type: text/csv; charset=utf-8` y
  `Content-Disposition: attachment; filename="cierre-<from>-a-<to>.csv"`
  (ejemplo: `cierre-2026-10-28-a-2026-10-28.csv`, con las
  fechas del período resuelto).
- Funciones puras y testeables: el armado del CSV
  (encabezado, escape, fila de total) vive separado de la
  consulta, para probarse sin BD, igual que `clasificarCierres`
  en `sales.ts`.

### 4. Lo que NO se toca (regla dura)

- `src/server/analytics/sales.ts`: sin cambios. Ventas ya suma
  bien; solo le faltaban montos que sumar.
- El cajón y la tarjeta del pedido en el pipeline: el Monto
  SIGUE oculto para pedidos del menú (comportamiento 038). El
  monto es para Resultados y para el archivo, NO para duplicar
  el total en la vista del pedido. Esta spec no agrega ninguna
  visualización de monto en bandeja, pipeline, cocina ni
  buzón.
- `src/server/leads/stage-history.ts`: sin cambios.
- `/api/bot/*`: sin cambios de forma ni de códigos.
- `src/lib/db/schema.ts` y `drizzle/`: sin cambios, sin
  migración.

## Decisiones

1. **Monto por chat: extender `update_lead` (opción a), NO
   extraer el Total del mensaje PEDIDO CONFIRMADO (opción
   b).** Un número estructurado validado por Zod es robusto
   frente a reformateos del mensaje («Total: ₡4.300»,
   «Total: 4300 colones», una confirmación sin marcador); el
   parseo de texto se rompería con cada variación y acoplaría
   esta spec al formato de la cocina. Además, (a) hace a 042
   INDEPENDIENTE de 041: no espera al PR #10 (sin mergear) ni
   a su marcador, y un pedido por chat confirmado sin marcador
   igual guarda su monto.
2. **Monto QR: extender `createLeadForContact` con
   `amountCents`/`currency` opcionales, NO actualizar el lead
   tras crearlo.** El monto queda en el mismo `insert` del
   lead (atómico, sin segunda escritura ni carrera con el
   `onConflictDoNothing`); la única actualización posterior es
   el caso reintento con monto NULL. Extender la única función
   de creación evita que dos caminos diverjan, que es justo
   por lo que `createLeadForContact` vive en un solo sitio.
3. **Exportación en CSV (`;` + BOM UTF-8 + CRLF + coma
   decimal), NO `.xlsx` real.** Abre en Excel en español con
   doble clic y no agrega ninguna dependencia (regla dura del
   fork). Un `.xlsx` real con formato y varias hojas queda
   FUERA de esta spec: si el dueño lo pide después, requiere
   aprobación explícita de la dependencia que lo genere.
4. **Ruta interna `GET /api/analytics/cierre` con sesión,
   período validado por `periodFromRequest` y consultas con
   `scoped()`.** La API interna no es contrato público y la
   descarga no pertenece a `/api/bot/*` (llave de servicio,
   no sesión de dueño). Reutilizar el validador de período de
   ventas evita un segundo validador que diverja.
5. **Pedidos VIEJOS con `amountCents` NULL: se quedan fuera
   del total, sin backfill.** Re-parsear textos viejos
   inventaría montos (los textos de chat no tienen formato
   fijo) y un «cierre real» no puede apoyarse en números
   adivinados. El cierre real aplica desde el despliegue en
   adelante; los pedidos viejos ganados que caigan en un
   período exportado aparecen con `Total (₡)` vacío y no
   suman. Honesto y visible, no silencioso.
6. **Alcance UI: solo el botón en `ResultsClient` junto al
   `RangePicker`, respetando el rango elegido; Monto oculto
   en cajón y tarjeta de pedidos (038) sin tocar.** El dueño
   pidió el cierre en Resultados, no otro lugar donde ver el
   total del pedido; duplicarlo en la vista del pedido
   rompería la decisión 038 que él mismo pidió.

## Limitaciones conocidas (no maquilladas)

- **Un lead por contacto en chat.** El modelo admite UN lead
  por contacto, así que si el mismo cliente por chat hace dos
  pedidos, la segunda confirmación sobrescribe el monto de la
  primera en ese lead (el menú QR no tiene este problema
  porque crea un contacto por pedido, `menu:<orderId>`). Para
  el piloto es aceptable; un lead por pedido en chat sería un
  cambio de modelo, fuera de esta spec.
- **El monto es el actual, no un histórico.** Igual que
  Ventas: si alguien edita el monto de un lead después, el
  cierre de un período pasado cambia. Pantalla y archivo
  cambian juntos, así que nunca se contradicen entre sí.
- **Sin entregar, sin cierre.** Un pedido con monto que el
  personal nunca pasa a «Entregado» no entra en Ventas ni en
  el archivo. El cierre mide entregas, no pedidos tomados.
- **Tope del período: 366 días** (el de `periodFromRequest`).
  No hay paginación del archivo: el período ya lo acota.

## Lo que NO entra

- Cambios a `src/server/leads/stage-history.ts` ni a cómo se
  escribe `lead.stage_id`.
- Cambios al contrato `/api/bot/*`: no quitar ni renombrar
  campos, no agregar campos obligatorios.
- Cambios a la pantalla de cocina, al buzón, al menú QR ni a
  la página del cliente: el menú sigue mandando su JSON y su
  texto como hoy.
- Cambios al cajón/tarjeta del pedido (Monto oculto, 038) ni
  a `SalesSection`: la pantalla ya muestra el total, solo le
  faltaban montos.
- Migración: no cambia el modelo de datos, no hay columnas
  nuevas, no hay reescritura de pedidos viejos.
- `.xlsx` real, dependencias nuevas, push, PR, merge ni
  despliegue: esta entrega es solo la spec. El código lo hace
  otro subagente y los gates los corre el coordinador.

## Criterios de aceptación

1. Un pedido QR con total guarda su lead con `amountCents =
   total × 100` y `currency` = moneda de la marca; un
   reintento del mismo `orderId` no duplica nada y no pisa un
   monto ya guardado.
2. Un pedido por chat confirmado con `update_lead` + `amount`
   guarda su lead con el mismo cálculo; una acción
   `update_lead` sin `amount` sigue funcionando exactamente
   como hoy (nota guardada, sin monto tocado).
3. Un monto inválido del agente (negativo, no finito) no tumba
   el turno, no borra el monto previo y la nota/respuesta se
   preservan.
4. Resultados del día, con ambos pedidos pasados a
   «Entregado», muestra el total en colones igual a la suma de
   los dos totales. Sin pasar a «Entregado», el total es 0:
   el cierre mide entregas.
5. La descarga del período trae las filas de los pedidos
   entregados en ese período, la fila `TOTAL` igual a Ventas,
   y abre en Excel en español con acentos y números correctos.
6. Un pedido viejo ganado (monto NULL) aparece en el archivo
   con total vacío y NO suma al total.
7. El cajón y la tarjeta de un pedido del menú siguen sin
   mostrar Monto (038 intacto).
8. Gates en verde: tsc limpio, eslint limpio, vitest en verde
   (incluidas las pruebas nuevas), next build OK.

## Pruebas unitarias (vitest, sin BD)

1. CSV: encabezado exacto, delimitador `;`, BOM al inicio,
   CRLF, escape de `;`, comillas y saltos de línea en nombres,
   total con coma decimal y 2 decimales, fila `TOTAL` con la
   suma solo de montos en la moneda del negocio, monto NULL y
   moneda distinta con total vacío y fuera de la suma, archivo
   sin filas con encabezado + `TOTAL;;;0,00;`.
2. Conversión a centavos: colones enteros y con decimales
   (`4300` → `430000`, `12.5` → `1250`), redondeo
   (`10.005` → `1001` por `Math.round`).
3. `update_lead`: el esquema viejo sin `amount` sigue
   validando; con `amount` válido valida; el prompt describe
   el campo opcional y la regla de no inventar el total.
4. Guardián existente de `stage_id` en verde (ningún archivo
   nuevo escribe `stage_id`).

## Verificación en vivo en devapp (la hace Shey, no el autor de esta spec)

1. Pedido QR con total (ej.: Imperial + Stella = ₡4300):
   verificar en BD que el lead quedó con `amountCents =
   430000` y `currency = CRC`. Reintentar el mismo `orderId`:
   sin duplicados y sin cambio de monto.
2. Pedido por chat con un contacto nuevo: que el agente
   confirme el pedido con total; verificar en BD que el lead
   quedó con el monto en centavos y `CRC`.
3. Pasar ambos leads a «Entregado» desde el pipeline y abrir
   Resultados del día: el total de Ventas en colones debe ser
   la suma de ambos totales. Antes de pasarlos a «Entregado»,
   el total debe ser 0 (criterio 4).
4. Descargar el cierre del día desde el botón nuevo, abrir el
   archivo en Excel y comprobar: filas de ambos pedidos, mesa
   o código donde aplique, total por fila, fila `TOTAL` igual
   a Ventas, acentos legibles y números como números.
5. Comprobar que un pedido viejo ganado (monto NULL) sale con
   total vacío y no suma, y que el cajón/tarjeta de un pedido
   del menú sigue sin mostrar Monto.
6. Cambiar el período en Resultados (7 días, este mes) y
   descargar de nuevo: el archivo debe respetar el período
   elegido, no el día fijo.

## Dependencias

- Ninguna. 042 es independiente de 041 (decisión 1): no espera
  al PR #10 ni al marcador `PEDIDO CONFIRMADO`. Si 041 se
  mergea después, ambas conviven: el marcador alimenta la
  cocina y el campo `amount` alimenta el cierre, sin tocarse.
