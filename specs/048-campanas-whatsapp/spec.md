# Spec 048 — Campañas por WhatsApp (base: backend + API, sin UI)

## Contexto

Agregado vendible del Paquete SolidGround: el negocio envía mensajes masivos
por **plantillas aprobadas de Meta** vía Kapso API. V1 = backend y API; la UI
viene después (spec futura).

El coordinador ya creó el modelo: tablas `campaign` y `campaign_recipient` en
`src/lib/db/schema.ts`, prefijos `cmp`/`cmpr` en `src/lib/db/ids.ts` y la
migración `drizzle/0024_tiresome_moondragon.sql`. Esta spec no toca nada de eso.

## Decisiones de diseño

**D1. Opt-in explícito por API.** Agregar un destinatario
(`POST /api/campaigns/[id]/recipients`) **es** el opt-in: no hay importación
masiva automática, ni scraping, ni listas compradas. El negocio es responsable
del consentimiento de cada número que agrega; la API solo registra lo que le
dan. V1 no valida el opt-in contra ninguna fuente externa.

**D2. Estados de campaña.**
`borrador → programada → enviando ⇄ pausada → completada`.
- `POST` con `scheduledAt` futuro crea la campaña en `programada`; sin él, en
  `borrador`.
- `POST …/start` pasa `borrador`/`programada`/`pausada` → `enviando` (acción
  explícita del usuario: envía **ahora**, aunque hubiera fecha futura).
- `POST …/pause` pasa `enviando`/`programada` → `pausada`.
- El worker promueve `programada` con `scheduledAt` vencido → `enviando`.
- `DELETE` borra la fila (cascada a destinatarios), salvo en `enviando`
  (409: primero se pausa).
- `cancelada` existe en el enum pero v1 no lo usa; queda para la UI futura.

**D3. Variables de plantilla.** La campaña trae variables globales; cada
destinatario puede traer las suyas y **las del destinatario mandan**.
Claves `"1"`, `"2"`, … → parámetros `{{1}}`, `{{2}}` ordenados numéricamente;
claves con nombre → orden alfabético. Sin variables, el cuerpo no lleva
`components`.

**D4. Estados del envío (destinatario).**
`pendiente → enviado | fallido`. `enviado` guarda `platformMessageId` y
`sentAt`; `fallido` guarda `lastError` (nunca el secreto ni la llave).
`entregado` y `leido` quedan reservados para cuando el webhook de Kapso mapee
estados de vuelta (futuro); v1 no los escribe.

**D5. Rate limiting.** ~5 envíos/segundo por instancia (pausa de 200 ms entre
envíos), tandas de 25 destinatarios por campaña por pasada, barrido del worker
cada 10 s. Razón: no pisar los límites de Kapso/Meta y no saturar la
instancia. Los límites viven como constantes en `worker.ts`, no incrustados en
el envío.

**D6. Envío por plantilla.** `sendKapsoTemplate` (nueva, **aditiva** en
`src/server/whatsapp/send-kapso.ts`): `POST
api.kapso.ai/meta/whatsapp/v24.0/{phoneNumberId}/messages` con `X-API-Key` y
cuerpo
`{messaging_product:"whatsapp", to, type:"template",
template:{name, language:{code}, components:[{type:"body",
parameters:[{type:"text", text}…]}]}}`.
Los errores se traducen a `MetaApiError` igual que `sendKapsoMessage`
(046/D11): 401/403 → 401 (`isAuthError`, marca `reconnect_required`).

**D7. Teléfonos.** Dígitos, sin `+` (7–15, misma regla que 046/D5); se
normalizan al agregar y se congelan (si el contacto cambia de número, el envío
usa el registrado). Dedupe por índice único `(campaign_id, phone)`: el
duplicado se ignora y se reporta, no falla el lote.

**D8. Sin credenciales, no se quema.** Si la org no tiene credenciales Kapso o
la llave murió, la campaña pasa a `pausada` (no se marcan destinatarios como
fallidos en masa); el destinatario en curso queda `fallido` con `lastError`.

**D9. Worker en proceso**, estilo `src/server/dispatch/worker.ts`: singleton
en `globalThis`, `unref`, sin colas externas. `resumeCampaigns()` al arranque:
las campañas en `enviando` siguen donde quedaron y las `programada` vencidas
se promueven.

## API (solo handlers; la lógica vive en `src/server/campaigns/`)

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/api/campaigns` | Lista con conteos (total, enviados, fallidos) |
| `POST` | `/api/campaigns` | Crea (`name`, `templateName`, `templateLanguage`, `variables?`, `scheduledAt?`) → 201 |
| `GET` | `/api/campaigns/[id]` | Detalle |
| `PUT` | `/api/campaigns/[id]` | Edita (solo `borrador`; en `programada` solo `scheduledAt`) |
| `DELETE` | `/api/campaigns/[id]` | Borra, salvo `enviando` → 409 |
| `POST` | `/api/campaigns/[id]/recipients` | `{recipients:[{phone, contactId?, variables?}]}` → `{agregados, duplicados, invalidos}` |
| `POST` | `/api/campaigns/[id]/start` | → `enviando`; exige ≥1 pendiente y `templateName` |
| `POST` | `/api/campaigns/[id]/pause` | → `pausada` |
| `GET` | `/api/campaigns/[id]/report` | `{campana, conteos:{pendiente, enviado, entregado, leido, fallido, total}}` |

Errores de dominio: `CampaignError` con código (`not_found` → 404,
`estado_invalido` → 409, `sin_destinatarios`/`sin_plantilla` → 422).

## Criterios de aceptación (verificables)

1. Gates en verde: `tsc --noEmit`, `eslint` en los archivos nuevos/editados,
   `vitest run` en los tests nuevos.
2. `sendKapsoTemplate` con `fetch` falso: URL, `X-API-Key` y cuerpo formato
   Meta con `components` de plantilla; 401 de Kapso → `MetaApiError` con
   `isAuthError === true`; sin `messages[0].id` → error.
3. Puras sin BD: normalización de teléfonos (dígitos, 7–15), orden de
   parámetros (`1,2,10` numérico; nombres alfabético; destinatario manda sobre
   global), cuerpo sin `components` cuando no hay variables, validaciones Zod
   (nombre de plantilla, idioma, lote de destinatarios).
4. `start` sin destinatarios pendientes → 422; `start` en `enviando` → 409;
   duplicado teléfono+campaña → `duplicados`, no error.
5. La suite existente sigue en verde (nada de Zernio/Meta directo tocado).

## Qué NO se toca

- `src/lib/db/schema.ts`, `src/lib/db/ids.ts`, `drizzle/` (del coordinador).
- UI (viene después); `lead.stage_id`; contrato `/api/bot/*`; código de
  Zernio y Meta directo; `sendKapsoMessage` (solo se le suma la función
  hermana).
- Mapeo de estados del webhook a destinatarios (`entregado`/`leido`): futuro.
