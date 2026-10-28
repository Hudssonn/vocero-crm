# 035 — Pantalla de cocina interactiva (versión cliente)

## Contexto

033 creó los pedidos del menú QR como leads en el pipeline. 034 les dio
una pantalla de solo lectura a la cocina. Esta spec convierte esa pantalla
en la versión que se le ofrece al cliente: idéntica en datos y aspecto,
pero con botones para mover el pedido y con llave propia del personal.

## Flujo de cocina

```
Nuevo pedido → En preparación → Listo
```

- **Listo** es una etapa nueva (`open`): la cocina terminó el pedido y la
  tarjeta sale de la pantalla. No es el fin de la venta: el cobro
  (`Pagado`) y la entrega (`Entregado`) se siguen en el pipeline de Vocero.
- La pantalla muestra solo dos columnas: NUEVOS y EN PREPARACIÓN. Un pedido
  en `Listo` ya no aparece ahí (queda visible en el pipeline de Vocero).
- La cocina solo avanza: `Nuevo → En preparación` y
  `En preparación → Listo`. No retrocede ni salta etapas desde la pantalla;
  cualquier otro movimiento se hace en Vocero.

## Cambios en el modelo

- `ORDER_STAGES` (033) gana `Listo` (`open`) entre `En preparación` y
  `Pagado`. Las organizaciones nuevas crean las 6 etapas en ese orden.
- Se mantiene la regla 033: las etapas que faltan se agregan AL FINAL de
  las existentes, sin reordenar ni tocar las demás. Una organización que ya
  tenía las 5 etapas verá la columna `Listo` al final de su pipeline; eso
  no afecta a la pantalla (columnas fijas) ni a un cliente nuevo.

## Contrato nuevo: POST /api/bot/orders/[id]/stage

Superficie bot (llave `X-API-Key`, org de la instancia). Solo POST.

- Entrada: `{ "to": "En preparación" | "Listo" }` (Zod; cualquier otro
  valor es 400 por el validador común).
- `id` es el `leadId` del pedido (el que devuelve el board 034).
- Antes de mover, el servicio verifica: el lead existe, su etapa actual es
  una etapa de pedidos, y la transición es una de las dos de cocina.
- Respuestas (error anidado `{"error":{"code}}`, como el resto de
  `/api/bot/*`):
  - Sin llave → 401. Sin organización → 409 `no_org`.
  - Lead inexistente → 404 `lead_not_found`.
  - Lead fuera de las etapas de pedidos → 409 `not_an_order`.
  - Transición fuera del flujo de cocina → 409 `invalid_transition`.
  - Destino igual a la etapa actual → 200 `{duplicate:true}` (no se mueve
    nada, como el reintento de 033).
  - Movimiento aplicado → 200 `{leadId, stage, moved:true}`.
- El movimiento se escribe SOLO por `moveLeadToStage`
  (`src/server/leads/stage-history.ts`), con `source: "bot"` y sin usuario
  actor. Nunca por UPDATE directo: la historia de etapas es la única
  puerta que escribe `lead.stage_id`.

## Pantalla y proxy (acompañan, fuera del fork)

- La página gana botones: `Empezar` en las tarjetas de NUEVOS,
  `Listo` en las de EN PREPARACIÓN. Tras un movimiento exitoso refresca
  de inmediato (además del refresco cada 10 s).
- El proxy gana `POST /pantalla-mover`: valida la llave de pantalla y
  reenvía al endpoint con la llave bot. La página nunca ve la llave bot.
- La pantalla deja de ser pública: `pantalla.html`, `/pantalla-datos` y
  `/pantalla-mover` exigen la llave de pantalla (`SCREEN_KEY` en el
  entorno del servidor del menú, distinta de la llave del menú). Sin llave
  o con llave inválida → 403. La URL con llave es la que se marca en el
  dispositivo de la cocina.

## Pruebas

- Unitarias puras: tabla de transiciones de cocina (las dos válidas, el
  duplicado, y los inválidos: retroceso, salto y etapas fuera de cocina)
  y orden de `ORDER_STAGES` con `Listo` entre `En preparación` y `Pagado`.
- Gates: typecheck + lint + suite completa.
- Verificación en vivo (Principio IX): pantalla sin llave → 403; con
  llave muestra las columnas; `Empezar` mueve un pedido a En preparación;
  `Listo` lo saca de la pantalla y lo deja en la etapa `Listo` del
  pipeline; transición inválida → 409; repetir el mismo destino → 200
  duplicado.
