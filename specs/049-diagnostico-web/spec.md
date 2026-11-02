# 049 — Diagnóstico web de ventas

La herramienta de diagnóstico (`diagnostico-solidground/index.html`) la llena
un prospecto y, al completarla, el resultado debe llegar a Vocero como un lead
sin que el prospecto tenga que enviar nada manualmente.

## Contrato

`POST /api/diagnostico` — público, sin autenticación (los prospectos no tienen
API key). Rate limit por IP: 20 envíos cada 10 minutos (429 `rate_limited`).

Request (JSON, validado con Zod):

| Campo | Tipo | Requerido |
|---|---|---|
| `tipoNegocio` | string | sí |
| `tipoNegocioOtro` | string | no (texto libre cuando el tipo es "otro") |
| `problemas` | string[] | sí, no vacío |
| `canales` | string[] | no |
| `modulos` | string[] | no |
| `precioMensual` | number > 0 | sí |
| `nombre` | string | no |
| `telefono` | string | no |
| `email` | string | no |

Respuestas:
- **201** `{ ok: true, leadId, conversationId, contactId, duplicate: false }`
- **200** igual con `duplicate: true` (el teléfono ya tenía lead: no se duplica)
- **422** `{ error: { code: "invalid_body", message } }` con el detalle de Zod
- **429** `{ error: { code: "rate_limited", … } }`
- **409** `{ error: { code: "no_org", … } }` si la instancia no tiene organización
- **500** `{ error: { code: "diagnostico_failed", … } }`

## Efecto

1. Contacto: con teléfono se vincula por identidad (reconciliación de la
   ingesta); sin teléfono, identidad única `diagnostico:<id>`.
2. Ficha del contacto, llave `diagnostico`: tipo de negocio, problemas,
   módulos, canales, precio y fecha (merge con `upsertFicha`).
3. Conversación (canal whatsapp) + un mensaje entrante con el diagnóstico en
   texto (solo si la conversación no tenía mensajes).
4. Lead en la primera etapa abierta del pipeline (`createLeadForContact`, la
   única puerta que escribe `lead.stage_id`), con el precio mensual como monto
   en centavos y la moneda de la marca.

## Archivos

- `src/server/diagnostico/service.ts` — schema, formato y `registrarDiagnostico`
- `src/app/api/diagnostico/route.ts` — solo el handler POST
- `tests/unit/diagnostico.test.ts` — schema, identidad, etiqueta y formato
