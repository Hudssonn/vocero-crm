# Spec 046 — Canal WhatsApp vía Kapso

## Contexto

El número +506 7037-0091 (SolidGround) quedó conectado en Kapso por
coexistencia el 2026-10-29 (Phone ID 1295326617007791,
WABA 1464430865509930, portafolio 3923365861138585).
Inbound y outbound probados en vivo y funcionando.

Vocero ya tiene WhatsApp nativo vía Zernio (spec 032, "un canal, dos
transportes"). Esta spec clona ese patrón para Kapso como proveedor
hermano. Org objetivo: `org_wxya00oqnpvsl8hj62s0` (instancia principal).

Docs oficiales: `https://docs.kapso.ai/docs/platform/webhooks/overview`
(webhooks), `https://docs.kapso.ai/docs/whatsapp/send-messages/text`
(envío).

## Decisión de diseño

**D1. Kapso es un proveedor, no un canal nuevo.** El `Channel` sigue siendo
`"whatsapp"` (no se agrega valor `"kapso"` al enum de `src/lib/channels.ts`
ni al schema). Igual que Zernio: el núcleo ve canal whatsapp + hilo, y el
transporte se resuelve por proveedor. Como en 032, entra como transporte del
canal (no como conector tras bandera): Kapso es BSP oficial de Meta y su API
habla formato Cloud API — no es Baileys ni sesión web, así que no viola
"Solo WhatsApp Cloud API oficial".

**D2. Tabla propia de credenciales.** Nueva tabla `whatsapp_kapso_credentials`
(migración aditiva vía `pnpm db:generate`, nunca a mano):
`id` (text PK), `organization_id` (FK cascade), `source` (default `'kapso'`),
`phone_number_id` NOT NULL (llave de enrutado del webhook),
`waba_id`, `display_name`,
`api_key_cipher/_iv/_tag` NOT NULL (AES-256-GCM vía `src/lib/crypto`),
`webhook_secret_cipher/_iv/_tag` NOT NULL,
`status` (`connected`|`reconnect_required`),
`created_at/updated_at`. Única por organización
(y única por `phone_number_id`).

**D3. Ruta de webhook propia por número.** Kapso genera un webhook por número
(no hay handshake tipo verify-token de Meta).
`POST /api/webhooks/kapso/[phoneNumberId]/route.ts`:
enruta por `phone_number_id` (viene a nivel superior del payload v2) y
autentica por HMAC (D4). `phone_number_id` desconocido → 404 sin procesar.

**D4. Verificación HMAC-SHA256 del body crudo.** Header `X-Webhook-Signature`
= HMAC-SHA256 hex del **body JSON crudo** con el `secret_key` del webhook
(sin prefijo `sha256=`), comparación timing-safe. En el handler usar
`await req.text()` — **nunca** re-serializar con `JSON.stringify` (rompe la
firma). Firma inválida → 401. Responder `200` en <10 s (verificar, normalizar
y encolar; el turno del agente ya es asíncrono).

**D5. Normalizador puro.** `normalizeKapsoWhatsappEvent` (nuevo,
`src/server/whatsapp/ingest-kapso.ts`), testeable sin I/O:
- Acepta solo `X-Webhook-Event: whatsapp.message.received` (otros eventos se
  responden 200 y se ignoran con log).
- Desenvuelve batch: `{type, batch:true, data:[…]}` → procesa cada item.
- Filtra `direction === "incoming"` (o equivalente en `message.kapso`).
- Texto de `message.kapso.content`; `type` ∈ text/image/video/audio/document/
  location/template/interactive/reaction/contacts. v1: solo texto dispara al
  agente; adjuntos se registran por tipo (no se descargan), como Zernio v1.
- Identidad: `normalizeMx(phone)` (7–15 dígitos, misma regla que Zernio) desde
  `conversation.phone_number` (fallback: campos de identidad del payload).
  Sin teléfono se usa `bsuid:<id>` como `wa_identity` (forma ya prevista en
  el invariante de identidad del repo): el contacto y el mensaje se guardan,
  pero **no** se dispara el turno del agente (el envío exige `to` con
  teléfono) y se deja log.
- Idempotencia: `wa_message_id = "kwa_" + <id mensaje Kapso>` (UNIQUE; no
  colisiona con `zwa_*` ni `wamid.*`). Además se respeta `X-Idempotency-Key`:
  Kapso entrega at-least-once y puede llegar desordenado → el UNIQUE es la
  red de seguridad, no el orden.

**D6. Ingesta por el núcleo existente.** `processKapsoWhatsappEvent`:
credenciales por `getWhatsappKapsoCredentialsByPhoneNumberId`;
`channel_thread_ref = "kapso:" + <conversation.id Kapso>` (prefijo propio;
ver D8); luego `ingestInboundMessage` (`src/server/inbox/ingest.ts`) →
`maybeRunAgentTurn` (`src/server/ai/trigger.ts`). Sin cambios al núcleo.

**D7. Envío por Kapso.** `POST https://api.kapso.ai/meta/whatsapp/v24.0/{phone_number_id}/messages`,
header `X-API-Key: <project API key>`, body formato Meta Cloud API
(`{messaging_product:"whatsapp", to, type:"text", text:{body}}`).
`phone_number_id` sale de la fila de credenciales; `to` del contacto.

**D8. Resolución de transporte en `prepareSend`** (`src/server/inbox/send.ts`,
sin tocar las ramas Zernio/Meta):
- `channel === "whatsapp"` y `channel_thread_ref` empieza con `"kapso:"`
  y la org tiene credenciales Kapso → transporte Kapso.
- Si no, se mantiene la lógica actual (Zernio por threadRef sin prefijo +
  credenciales Zernio; si no, Meta directo).
Rationale: los threadRef de Zernio existentes (sin prefijo) siguen enrutando
a Zernio; los de Meta son NULL. Caveat heredado de 032 (D2): si un número
cambia de proveedor hay que limpiar `channel_thread_ref` a mano.

**D9. Ventana 24h compartida.** Se reutiliza `capabilitiesFor("whatsapp")` +
`src/server/inbox/window.ts`: fuera de ventana → `SendError("window_closed")`
sin intentar el envío. Plantillas por Kapso quedan **fuera de v1**
(Kapso las soporta; se harían en spec futura).

**D10. Credenciales y ajustes.** Módulo `src/server/whatsapp/credentials-kapso.ts`
espejo de `credentials-zernio.ts`: `encryptSecret`/`decryptSecret`,
`getWhatsappKapsoCredentialsByOrg`, `getWhatsappKapsoCredentialsByPhoneNumberId`,
`saveWhatsappKapsoCredentials`, `markWhatsappKapsoReconnectRequired`,
`apiKeyLast4` (la llave nunca sale entera).
Pantalla: nueva tarjeta en Ajustes → WhatsApp (`PUT /api/settings/whatsapp/kapso`,
solo owner, zod `{phoneNumberId, apiKey, webhookSecret}`):
valida la llave contra Kapso **antes de guardar** (ej. leer el número por API;
si la llave o el número no calzan → 4xx sin guardar),
muestra la URL del webhook para pegarla en el panel de Kapso,
`GET` devuelve estado sin secretos, `DELETE` borra solo la fila.
El `webhook_secret` lo genera Kapso al crear el webhook (el usuario lo pega).

**D11. Errores.** Auth de Kapso (401/403 en envío) → `reconnect_required`
(igual que Zernio). `marketing_preference_stopped` (opt-out de marketing) →
log + descarte, no reintento. Fuera de ventana → `window_closed`.

## Criterios de aceptación (verificables)

1. Migración aditiva crea `whatsapp_kapso_credentials`; gates en verde
   (`tsc`, `eslint`, `vitest`, `next build`).
2. Tests unitarios nuevos para `normalizeKapsoWhatsappEvent` y la
   verificación HMAC (casos: firma válida/inválida, batch, evento no
   soportado, sin teléfono, duplicado) — espejo de
   `tests/unit/zernio-whatsapp-ingest.test.ts`.
3. `PUT /api/settings/whatsapp/kapso` con llave/número válidos → 200 y fila
   guardada; con llave inválida → error sin guardar; `GET` nunca devuelve
   secretos completos.
4. Webhook: HMAC válido → 200; HMAC inválido → 401; `phone_number_id`
   desconocido → 404.
5. Entrante de texto válido → contacto + conversación + mensaje creados,
   `wa_message_id` con prefijo `kwa_*`, `channel_thread_ref` con prefijo
   `kapso:`, y turno del agente disparado (`maybeRunAgentTurn`).
6. Re-entrega del mismo evento (mismo id / mismo `X-Idempotency-Key`) →
   una sola fila de mensaje.
7. Respuesta del agente en conversación Kapso → `POST` a la API de Kapso con
   `X-API-Key` y cuerpo formato Meta; mensaje marcado `sent`.
8. Fuera de la ventana 24h → `window_closed`, sin llamada a Kapso.
9. Suite existente intacta: ramas Zernio y Meta directo sin cambios de
   comportamiento (sus tests siguen en verde).
10. Verificación en vivo (post-despliegue, pilotaje de Hudson): mensaje real
    al 7037 → el agente responde por Kapso.

Recomendado (no bloqueante en v1): guion E2E `tests/e2e/us-whatsapp-kapso.md`
espejo de `tests/e2e/us-whatsapp-zernio.md`.

## Qué NO se toca

- El enum `Channel` (no hay canal `"kapso"`); el contrato `/api/bot/*`;
  escrituras de `lead.stage_id` fuera de `stage-history.ts`.
- Código de Zernio (ingesta, envío, ajustes) ni el path Meta directo.
- Las rutas de webhook existentes (`wa`, `ig`, `messenger`, `tiktok`,
  `messenger/[webhookToken]` de Zernio).
- Plantillas de Kapso, descarga de adjuntos, multi-número por org más allá de
  una fila: fuera de v1.

## Notas de coexistencia (no código, contexto operativo)

- El número sigue en la app WhatsApp Business (perfil/foto/nombre se editan
  ahí, no por API).
- Plan Kapso $0: 2.000 mensajes/mes, 1 número. La WABA debe tener billing
  Approved para mensajería de pago; fuera de ventana 24h solo plantillas
  aprobadas.
