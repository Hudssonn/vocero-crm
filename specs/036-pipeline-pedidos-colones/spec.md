# 036 — Pipeline de pedidos: 4 etapas, colones y sin prioridad

## Contexto

033 creó los pedidos del menú QR como leads en el pipeline. 034 les dio
una pantalla de solo lectura a la cocina. 035 hizo esa pantalla
interactiva (Nuevo → En preparación → Listo, con llave propia).

El dueño pidió tres correcciones sobre ese pipeline:

1. Las etapas deben ser solo cuatro.
2. El monto debe salir en colones, no en pesos mexicanos.
3. La prioridad debe quitarse: todos los pedidos son de alta prioridad.

## Pipeline en 4 etapas

```
Nuevo pedido → En preparación → Listo → Entregado
```

- `ORDER_STAGES` pierde `Pagado` y `Perdido`. `Entregado` (`won`) es el
  ancla final.
- El cobro se hace en caja y no es una etapa del pipeline.
- Para cancelar un pedido ya no hay columna: se borra la tarjeta.
- La pantalla de cocina no cambia: sigue mostrando solo NUEVOS y EN
  PREPARACIÓN, con los botones Empezar y Listo. `Entregado` se mueve en
  el pipeline de Vocero (arrastre), no desde la pantalla.
- `kitchenTransition` no cambia: la pantalla solo avanza
  `Nuevo → En preparación → Listo`.
- Se mantiene la regla 033: las etapas que faltan se agregan AL FINAL de
  las existentes, sin reordenar ni tocar las demás. Por eso, en una
  organización que ya tenía las 6 etapas, el despliegue debe limpiar:
  borrar las filas `Pagado` y `Perdido` (sin leads en devapp, verificado)
  y reordenar posiciones a Nuevo (0), En preparación (1), Listo (2),
  Entregado (3). Las organizaciones nuevas crean directamente las 4.

## Monto en colones

- La moneda por defecto del fork era `MXN` (herencia del upstream): el
  diálogo de monto decía "Cuánto vale este trato (MXN)" y los totales
  de columna se sumaban en pesos.
- `DEFAULT_CURRENCY` pasa de `MXN` a `CRC` (`src/lib/money.ts`) y el
  estado inicial del cliente del pipeline pasa de `"MXN"` a `"CRC"`.
- La marca sin moneda configurada resuelve a `CRC` por el mismo
  default. Los leads con moneda explícita no se tocan (en devapp no
  hay ninguno: todos los montos son nulos y siguen la moneda del
  negocio).

## Sin prioridad

- Se quita la prioridad de la interfaz del pipeline, no del modelo:
  - La tarjeta ya no pinta `PriorityBadge`.
  - El diálogo de monto ya no pide prioridad (título `Monto`).
  - El cajón del lead ya no tiene sección de prioridad.
- El componente `priority-picker.tsx` se queda: lo sigue usando la
  pantalla de contactos (fuera del pipeline).
- El campo `lead.priority` y la ruta PATCH que lo acepta quedan
  intactos: no hay migración y el cambio es reversible.

## Cambios en el modelo

- `ORDER_STAGES` (`src/server/orders/service.ts`): 4 etapas.
- `DEFAULT_CURRENCY` (`src/lib/money.ts`): `CRC`.
- Cliente del pipeline: default `CRC`, sin badge ni guardado de
  prioridad.
- Pruebas: `bot-orders` (4 etapas), `bot-board` (filtro sin Pagado
  ni Perdido), `bot-order-stage` (Listo entre En preparación y
  Entregado).

## Verificación

- Gates: typecheck + lint + suite completa.
- En vivo en devapp tras el merge (Principio IX): desplegar, limpiar
  las filas `Pagado`/`Perdido` y reordenar posiciones, y verificar que
  el pipeline muestra exactamente 4 columnas, que el diálogo de monto
  dice colones y que no aparece prioridad en tarjetas, diálogo ni
  cajón.
