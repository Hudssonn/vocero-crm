# 038 — El pedido del menú lleva el nombre del cliente; fuera Monto y "Sin teléfono"

## Contexto

037 dejó el cajón del pipeline enseñando la sección "Pedido" (texto
del primer mensaje) solo para pedidos del menú (`lead.orderText !=
null`, tipo `BoardLead` en `src/components/pipeline/pipeline-client.tsx`),
y el pedido del menú ya trae entrega, dirección, pago y con cuánto.

El dueño abrió la tarjeta de un pedido y pidió fuera dos cosas:

1. La sección "Monto (CRC)" que dice "Sin monto — captúralo": los
   pedidos nunca tienen monto en ese campo; el total vive en el
   texto del pedido.
2. El nombre "Mesa 4" con "Sin teléfono" debajo: la tarjeta enseña
   el nombre del contacto, y el contacto de un pedido se llamaba
   por su mesa o su código.

En su lugar, el cliente que escanea el código pone su nombre
(obligatorio en la página) y su celular (opcional). Los pedidos
viejos ya creados (como "Mesa 4") conservan su nombre viejo; esto
solo afecta pedidos nuevos.

## A. El pedido trae nombre y celular

Claves nuevas en `menuOrderSchema` (`src/server/orders/service.ts`),
todas opcionales para no romper páginas viejas (compatibles hacia
atrás: un pedido sin ellas pasa igual que antes):

| Clave | Tipo | Regla |
|---|---|---|
| `nombre` | string | Opcional en la API. Si viene no vacío (tras trim), es el nombre del contacto. |
| `telefono` | string | Opcional en la API. Viaja solo en el texto del pedido, nunca en `contact.phone`. |

AMBAS son opcionales en la API a propósito: una página vieja en
caché que no las mande debe seguir funcionando. El obligatorio se
impone en la página nueva, no en la API. La página nueva (el menú
del cliente) NO entra en esta entrega: es trabajo aparte, fuera de
este repo.

### Nombre del contacto

`orderContactName` gana un caso, primero que todos (corrección del
dueño: el nombre del contacto NO es solo el nombre del cliente,
porque si no dice la mesa es difícil entregar). Formato exacto,
uniforme para los tres casos (identificador actual + " · " +
nombre del cliente, recortado):

- Con mesa: `Mesa ${mesa} · ${nombre}` → ejemplo: "Mesa 4 · Andrea".
- Para llevar (retiro): `Para llevar ${codigo} · ${nombre}` →
  ejemplo: "Para llevar P-9202 · Andrea".
- Delivery: `Delivery ${codigo} · ${nombre}` → ejemplo:
  "Delivery P-9201 · Andrea".
- Sin nombre (pedido viejo o página vieja en caché) → queda la
  lógica actual sin cambios: `Mesa ${mesa}`,
  `Para llevar ${codigo}` o `Delivery ${codigo}`.

### Texto del pedido

`formatOrderText` mantiene su formato y agrega, justo después del
encabezado de mesa/delivery (incluida la línea `Dirección:` cuando
la hay) y antes de los platos:

- `Cliente: ${nombre}` si hay nombre (recortado).
- `Celular: ${telefono}` si hay teléfono (recortado).
- Sin nombre ni teléfono, no se agregan líneas vacías.

La línea `MESA: N` SE QUEDA: la cocina necesita saber la mesa. Lo
que cambia es el NOMBRE del contacto, no el texto de la mesa.

### Lo que NO se escribe

`createMenuOrder` sigue pasando `phone: null` al crear el contacto:
el teléfono viaja solo en el texto del pedido. Los contactos del
menú no son contactos de WhatsApp y no se les debe poder enviar
nada por ese campo. Nada de entrega, dirección, pago ni con cuánto
de 037 se toca.

## B. Cajón y tarjeta sin Monto ni "Sin teléfono" en pedidos

La marca de "pedido del menú" es la misma de 037:
`lead.orderText !== null`. Para leads comunes todo queda
exactamente igual.

- Cajón (`src/components/pipeline/lead-drawer.tsx`): la sección
  "Monto" se OCULTA cuando `lead.orderText != null`. La sección
  "Pedido" (037) y el resto del cajón no cambian.
- Cajón, sección "Quién": la línea del teléfono se OCULTA cuando
  `lead.contact.phone` es null Y el lead es un pedido del menú:
  nada de "Sin teléfono" en pedidos. Si un pedido tuviera teléfono
  en el contacto (no pasa hoy: siempre es null), la línea se
  enseña como antes.
- Tarjeta (`src/components/pipeline/pipeline-client.tsx`): el
  botón "+ monto" se OCULTA cuando `lead.orderText != null`. El
  resto de la tarjeta (nombre, actividad, enlace a la
  conversación) no cambia.

## Cambios en el modelo

- `src/server/orders/service.ts`: claves `nombre` y `telefono` en
  el schema, nombre del cliente en `orderContactName`, líneas
  `Cliente:` / `Celular:` en `formatOrderText`.
- `src/components/pipeline/lead-drawer.tsx`: sección "Monto"
  condicional y línea de teléfono condicional.
- `src/components/pipeline/pipeline-client.tsx`: botón "+ monto"
  condicional; comentario en `BoardLead` sobre `orderText` como
  marca de pedido del menú.
- Pruebas: `tests/unit/bot-orders.test.ts` (schema con nombre y
  teléfono, nombre del contacto = mesa/código + " · " + nombre del
  cliente, fallback a Mesa / Para llevar / Delivery sin nombre, líneas Cliente /
  Celular en el texto y ausencia de la línea Celular sin
  teléfono).

## Lo que NO entra

- La página del menú (nombre obligatorio, celular opcional en el
  formulario): trabajo aparte, fuera de este repo.
- Cambios a pedidos viejos: conservan su nombre viejo ("Mesa 4",
  "Para llevar …", "Delivery …") y su texto viejo.
- Cambios a entrega, dirección, pago o con cuánto (037), a la
  pantalla de cocina, a las etapas del pipeline ni a
  `contact.phone`.
- Migración: no hay cambios de esquema de base de datos; el nombre
  y el celular viven en el contacto y en el texto que ya existen.

## Verificación

- Gates: typecheck + lint + suite completa + build.
- No hay tests de componentes del cajón ni de la tarjeta en
  `tests/unit/` (se buscó: ningún test cubre `lead-drawer` ni
  `pipeline-client`); la verificación del cajón y la tarjeta es
  por revisión de código + tsc + build.
- En vivo en devapp tras el merge (Principio IX): mandar un pedido
  nuevo con nombre y celular y verificar que la tarjeta se llama
  "Mesa N · nombre" (o "Para llevar … · nombre" / "Delivery … ·
  nombre", sin "+ monto"), que el cajón no enseña "Monto"
  ni "Sin teléfono" y que el texto del pedido trae `MESA: N`,
  `Cliente:` y `Celular:`; abrir un lead común y verificar que
  Monto, "+ monto" y teléfono siguen exactamente igual; mandar
  un pedido sin nombre ni teléfono y verificar que sale como
  antes (Mesa / Para llevar / Delivery, sin líneas vacías). Sin
  migración y sin despliegue en esta entrega: solo código local,
  sin push ni PR.
