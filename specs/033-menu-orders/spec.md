# 033 — Pedidos del menú QR en Vocero

## Problema

El menú QR de un restaurante (página web aparte, un QR por mesa) recibe
pedidos, pero hoy esos pedidos caen en un buzón de prueba fuera de Vocero:
no se ven en la bandeja ni en el pipeline, y el personal no puede
moverlos por etapas ni darles seguimiento desde el CRM.

## Solución

Un endpoint nuevo en la superficie bot, `POST /api/bot/orders`, que
convierte cada pedido en contacto + conversación + mensaje + lead en la
etapa "Nuevo pedido". El menú le manda el pedido estructurado; Vocero lo
deja como tarjeta del pipeline, lista para moverla por etapas.

## Contrato

- Auth: header `X-API-Key` contra `BOT_API_KEY`, igual que el resto de
  `/api/bot/*`. Sin llave configurada, 401 siempre.
- Entrada (Zod, todo externo validado):
  `orderId` (string, único por pedido), `mesa` (entero, comer ahí),
  `paraLlevar` (bool), `codigo` (para llevar, p. ej. `P-1234`),
  `items` (nombre, cantidad ≥ 1, nota opcional, extras),
  `total` (número ≥ 0). Comer ahí exige `mesa`; para llevar exige `codigo`.
- Salida: `{ leadId, conversationId, contactId, stageId, duplicate }`.
  Crear responde **201**; reintentar el mismo `orderId` responde **200**
  con lo ya creado, sin duplicar nada.
- Errores: sobre anidado `{"error":{"code":…}}`. Sin organización: 409
  `no_org`. Solo existe POST: no hay listar, editar ni borrar pedidos
  por esta superficie.

## Decisiones (piloto)

- **Un contacto por pedido** (`wa_identity = menu:<orderId>`). La tabla
  de leads admite un lead por contacto, así que compartir contacto entre
  pedidos impediría ver cada pedido como tarjeta.
- **Canal `whatsapp`**: el enum de canales no tiene `menu`. El origen
  queda escrito en el texto ("Pedido desde el menú QR") y por WhatsApp
  es por donde la soda da seguimiento. Un canal `menu` propio sería una
  migración y queda como evolución, no como piloto.
- **Etapas al final**: las cinco etapas (Nuevo pedido, En preparación,
  Pagado, Entregado, Perdido; las dos últimas son las anclas `won` y
  `lost`) se crean solo si faltan, después de las existentes. Nunca se
  reordenan ni se tocan las etapas de la organización.
- **Sin migración**: reusa contacto, conversación, mensaje, lead y
  pipeline_stage. No se toca `lead.stage_id` fuera de su puerta
  (`createLeadForContact`); las consultas nuevas usan `scoped()`.
- **Nombre del contacto**: "Mesa N" o "Para llevar P-XXXX". El operador
  puede renombrarlo desde el CRM.

## Pruebas

- `tests/unit/bot-orders.test.ts`: validación del esquema, texto del
  pedido, orden y kinds de las etapas, identidad y nombre del contacto.
  Son pruebas puras, sin base de datos, como exige el árbol de tests.
- Camino con BD: verificación en vivo en la instancia de prueba
  (devapp), Principio IX, antes de declarar la feature hecha: un pedido
  de mesa debe aparecer como conversación y como tarjeta en "Nuevo
  pedido", y reintentarlo no debe duplicarlo.

## Despliegue

- Solo devapp (instancia de prueba). No toca la instancia principal ni
  la de la Tienda. La llave bot de devapp vive en su `.env`
  (`BOT_API_KEY`); el adaptador del menú la lee de su entorno, nunca
  del archivo ni del chat.
- Versión: no se sube en este cambio; el salto de versión y el
  CHANGELOG van con el release, cuando el cambio salga de devapp.
