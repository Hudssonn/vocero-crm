# 050 — Agentes de voz

Los agentes de voz de ElevenLabs (Alex, Sofía, Luciano y Soda La Esquina) ya atienden por
teléfono, pero el CRM no los enseña por ningún lado: ni para probarlos ni
para ver qué llamadas atendieron. Esta spec les da su pestaña en el CRM,
detrás de la bandera `VOZ` (patrón ADR-001, igual que `AGENDA`).

## Pestaña "Agentes de voz" (`/voice`)

- Entrada en el menú, grupo "Agente", tras "Laboratorio" (`src/lib/nav.ts`).
- Selector con los 4 agentes + widget web de ElevenLabs para probarlos:
  `<elevenlabs-convai agent-id="…">` con el script
  `https://unpkg.com/@elevenlabs/convai-widget-embed@0.25.1/dist/index.js`
  cargado una vez (`next/script`, `afterInteractive`), con versión fijada e
  `integrity` SRI (sha384 del archivo de esa versión; si se sube la versión,
  hay que regenerar el hash). Al cambiar de agente se re-monta el
  elemento con `key={agentId}` (corta la llamada activa: la UI lo avisa).
  El contenedor lleva altura mínima de 320 px (`.widget-wrap`). Si el
  script no carga, la UI enseña un aviso visible bajo el contenedor.
- El widget solo usa el agent ID PÚBLICO: aquí no va ninguna llave API.
  Probar el agente gasta minutos del plan de ElevenLabs (hoy gratis); la UI
  lo dice en una línea discreta.
- Catálogo estático en `src/lib/voice-agents.ts`: Alex (Expresiones
  Artísticas, vendedor, `agent_7601m4f7a5swe9et2q3c2hmrn7pb`), Sofía
  (asesora laboral, `agent_1401m4fnaet4fda9q53rwx6ceh5h`), Luciano
  (vendedor de SolidGround, `agent_8801m4gb7nnze8kaqsh1gc5ddpxx`) y Soda
  La Esquina (pedidos y reservas, `agent_3901m6vhmjszf1x97hbttpa5mcpt`).
  Visible en todas las instancias con `VOZ=on` (no hay filtro por org: una
  instancia = un negocio).
- Estado "activo" = estado CONFIGURADO, no health-check en vivo: ElevenLabs
  no expone endpoint público de estado del agente. Número asignado: ninguno
  todavía (Telnyx pendiente) → "Sin número asignado".

## Bandera `VOZ`

- Declarada en `src/lib/env.ts`; `src/server/voice/flag.ts` con
  `vozEnabled()` y `vozDisabledResponse()` (mismo patrón que `AGENDA`).
- Prop `voz` por `layout.tsx` → `AppShell` → `AppNav` → `appNavGroups`.
- Apagada: la pestaña y las rutas responden 404 (no 403, ADR-001).
- `GET /api/health` la reporta en `features.voz`.

## Historial de llamadas

La pestaña lee los registros que deja el puente de voz (n8n,
`Puente_Voz_Vocero.json`, inactivo hoy): tabla `voice_call` + `POST
/api/voz/post-llamada` + `GET /api/voice/calls`.

### Tabla `voice_call` (migración aditiva `0025`; `0026` corrige el UNIQUE
a compuesto por org y hace `phone` nullable)

| Columna | Notas |
|---|---|
| `id` | `vc_…` |
| `organization_id` | NOT NULL, `scoped()` en toda consulta |
| `agent_id` | agent ID público de ElevenLabs, nullable |
| `conversation_id` | nullable — llave de idempotencia JUNTO a `organization_id`: UNIQUE compuesto `(organization_id, conversation_id)` (un mismo `conversation_id` en otra org no colisiona) |
| `phone` | nullable: el puente no siempre trae teléfono y la llamada se guarda igual (la UI enseña "—") |
| `caller_name` | nullable |
| `direction` | `inbound` / `outbound`, default `inbound`. El CHECK en BD queda para una migración futura: hoy la validez la impone el enum de Zod en el endpoint. |
| `duration_sec` | int ≥ 0, default 0 |
| `summary`, `transcript`, `recording_url` | nullable; `recording_url` solo acepta URLs http(s) |

### Contrato `POST /api/voz/post-llamada` (público, con llave)

- Header `X-Voz-Key` contra `VOZ_API_KEY` (mínimo 16 caracteres,
  comparación en tiempo constante; sin ella, 401). Rate limit por IP: 20
  envíos cada 10 minutos (429 `rate_limited`).
- Body (Zod, `vozPostLlamadaSchema` en `src/server/voice/calls.ts`): lo que
  el puente envía hoy — `phone` (opcional), `name`, `direction`,
  `duration_sec`, `summary`, `recording_url` — MÁS los opcionales
  `agent_id`, `conversation_id`, `transcript`. El puente manda `""` en los
  campos que no trae: el schema normaliza `""` a ausente (NULL) en los
  opcionales y en `phone`. `duration_sec` acepta número o string numérico;
  `recording_url` solo acepta URLs http(s); `direction` es enum estricto
  (`inbound`/`outbound`, default `inbound` cuando falta).
- `instance` se acepta y se ignora: **no existe ningún mapeo instance→org**.
  La org es la de la instancia: `resolveInstanceOrg` devuelve la primera
  organización de la BD (una instancia = un negocio, principio de
  `AGENTS.md`). Multi-negocio en una misma instancia NO está soportado: el
  campo `instance` del puente ("tep", "main") no decide nada y dos negocios
  en una instancia compartirían el historial. Si algún día hace falta, el
  mapeo instance→org debe diseñarse y guardarse explícitamente; no se
  inventa uno por convención de nombres.
- Respuestas: **201** `{ ok: true, id, duplicate: false }`; **200** igual
  con `duplicate: true` si el `(organization_id, conversation_id)` ya estaba
  guardado (dedup por UNIQUE compuesto; sin `conversation_id` no hay dedup
  y cada POST inserta);
  **422** `{ error: { code: "invalid_body", … } }`; **409**
  `{ error: { code: "no_org", … } }` si la instancia no tiene organización;
  **500** `{ error: { code: "voz_failed", message: "No se pudo registrar la llamada" } }`
  (mensaje genérico; el detalle queda en el log del servidor).
- El endpoint NO inventa datos que el puente no envía: lo que no viene
  queda NULL y la UI lo enseña con "—".

### `GET /api/voice/calls` (con sesión)

- `?limit=50&offset=0` (tope 100), fecha desc. Alcance siempre
  `session.organizationId` (nunca parámetro). Responde
  `{ calls: […], hasMore, limit, offset }`; cada llamada lleva `id`,
  `agentId`, `conversationId`, `phone`, `callerName`, `direction`,
  `durationSec`, `summary`, `transcript`, `recordingUrl`, `createdAt`.

### UI del historial

Tabla fecha / número / duración / resumen / grabación / transcripción, con
estados loading / error (con reintento) / vacío y "Cargar más". Si
`recording_url` o `transcript` están vacíos, "—".

## Pedido por voz → pantalla de cocina (Soda La Esquina)

Cuando el puente registra una llamada, `POST /api/voz/post-llamada`
intenta convertirla en pedido, SOLO si la organización tiene pipeline de
pedidos (existe la etapa «Nuevo pedido», solo la soda) y la llamada trae
texto usable (resumen o transcripción). El diseño vive en
`src/server/voice/voice-order.ts`:

1. **Extracción con el LLM del backend** (`chatJson`, el mismo helper del
   turno del agente): prompt estricto con el menú de la soda y sus precios
   en colones; pide SOLO JSON `{items: [{nombre, cantidad, nota, extras}],
   total_colones, tipo: "local"|"llevar"|"domicilio", mesa, direccion,
   zona: "centro"|"barrios", nombre_cliente, pago, confianza:
   "alta"|"baja"}` y prohíbe inventar platos, precios, ingredientes o
   direcciones. El segundo pase del PR #30 (`resolverFalloAgenda`) es
   específico de agenda y no se reutiliza aquí.
2. **Validación en el servidor** (`validarPedidoVoz`): cada plato existe en
   el menú (normalizando mayúsculas y acentos, con alias de lo que el
   cliente dice por voz: "hamburguesa" → Hamburguesa de la casa), cantidades
   enteras ≥ 1, extras conocidos (queso ₡500, doble carne ₡1.500), el total
   RECALCULADO desde los precios del menú es igual al extraído (en
   colones), domicilio con dirección, zona y mínimo de ₡5.000 (recargo
   Centro ₡1.000, barrios ₡1.500), y confianza "alta".
3. **Si algo falla → NO se crea el pedido**: se loguea el motivo
   (`[voz-pedido]`) y la ruta devuelve el 201 normal. La llamada queda
   registrada y visible en el historial de voz con su resumen y
   transcripción para revisión humana. Este camino nunca lanza excepción:
   el 201 de la llamada no se ve afectado.
4. **Si es válido**: se resuelve o crea el contacto (si hay teléfono válido,
   `getOrCreateContactByIdentity` con el teléfono normalizado; si no,
   identidad `voz:<conversation_id>`, espejando el patrón `menu:<orderId>`
   del menú QR), se crea conversación + mensaje con el texto de
   confirmación y se llama a `registrarPedidoConfirmado` (lead en «Nuevo
   pedido» + monto). El texto lo arma `construirTextoPedidoVoz` con el
   formato exacto del chat (`PEDIDO CONFIRMADO` / `Canal: Voz` /
   `Llamada: <conversation_id>` / `MESA: <n>` o `PARA LLEVAR` o `DELIVERY`
   + `Dirección:` / `Cliente:` / líneas `<n>x <Plato> — <nota> — extras:
   …` / `Pago:` solo si se conoce / `Total: ₡X`), así la pantalla de cocina
   lo enseña por `GET /api/bot/board` sin tocar nada de ella. Solo se
   procesan llamadas NUEVAS (no duplicadas): un reintento del puente no
   crea el pedido dos veces, y si la conversación ya tiene mensajes no se
   inserta otro.
5. **Prompt del agente** (archivo local
   `~/workspace/agentes-call-center/actualizar-soda-menu.json`, NO aplicado
   en ElevenLabs): cuando el pedido queda confirmado por voz, el agente
   dice que quedó registrado y pasa a la cocina; si algo no quedó claro,
   que el personal lo confirma en el local.

### Límites conocidos

- La transcripción solo llega si en ElevenLabs está activado
  "Transcription" en los post-call webhooks; sin ella, la extracción usa
  solo el resumen.
- `call_summary`, `data.metadata` (duración) y `recording_url` del webhook
  real siguen SIN VERIFICAR contra un payload real: el puente los lee con
  tolerancia (si no vienen, quedan vacíos).
- El contacto `voz:<conversation_id>` NO se reconcilia con el de WhatsApp
  del mismo cliente: si la misma persona pide por voz y por WhatsApp,
  quedan dos contactos y dos tarjetas. Reconciliarlos es trabajo aparte.
- El teléfono casi nunca viene en el webhook de voz (el agente de Soda no
  tiene `data_collection` configurado): esos pedidos quedan sin teléfono y
  el seguimiento es en el local, no por WhatsApp.
- Revisión humana cuando no se entiende: un pedido incierto no se crea y
  queda en el historial de voz; nadie lo pasa a cocina automáticamente.

### Puente n8n (fuera de este repo: `~/workspace/n8n/workflows/Puente_Voz_Vocero.json`)

El nodo "Normalizar" ahora lee la forma REAL del webhook de ElevenLabs
(`data.agent_id`, `data.conversation_id`, `data.analysis.call_summary` o
`call_summary_title`, `data.transcript[]` aplanado a
`"Agente: …\nCliente: …"` o string tal cual, duración desde
`data.metadata` si existe, teléfono/nombre desde
`data_collection_results` si vienen) y manda a Vocero `agent_id`,
`conversation_id`, `transcript`, `summary`, `phone`, `name`, `direction`,
`duration_sec`, `recording_url` e `instance`. Sigue `active: false` y la
llave `X-Voz-Key` sigue siendo el placeholder `TU_VOZ_API_KEY` (la real la
pone Shey al importar).

## Lo que NO cubre (a propósito)

- **Grabación / transcripción**: la grabación casi siempre llegará vacía
  porque ElevenLabs no la incluye en el webhook; la transcripción requiere
  ampliar el puente. La UI no promete ninguna de las dos.
- **Catálogo por org**: el catálogo es estático y compartido; filtrarlo por
  organización queda para cuando haya un mecanismo por org.

## Archivos

- `src/lib/voice-agents.ts` — catálogo estático
- `src/lib/db/schema.ts` + migración `0025` — tabla `voice_call`; migración
  `0026_slimy_master_chief` — UNIQUE compuesto `(organization_id,
  conversation_id)` y `phone` nullable
- `src/lib/db/ids.ts` — prefijo `vc_`
- `src/server/voice/flag.ts` — bandera `VOZ`
- `src/server/voice/calls.ts` — schema del puente, registro idempotente, listado
- `src/server/voice/voice-order.ts` — pedido por voz → cocina: menú,
  extracción con el LLM, validación contra el menú, builder del texto de
  confirmación y `procesarPedidoDeVoz`
- `src/app/api/voz/post-llamada/route.ts` — solo el handler POST (tras
  registrar la llamada, intenta el pedido sin afectar el 201)
- `tests/unit/voice-order.test.ts` — builder, validación, recálculo,
  camino incierto y nodo Normalizar del puente
- `src/app/api/voice/calls/route.ts` — solo el handler GET
- `src/app/(app)/voice/page.tsx` + `src/components/voice/voice-client.tsx` — pestaña
- `src/lib/nav.ts`, `src/components/app-nav.tsx`, `src/components/app-shell.tsx`,
  `src/app/(app)/layout.tsx` — entrada en el menú tras `VOZ`
- `src/server/health.ts` — `features.voz`
- `tests/unit/voice-flag.test.ts`, `tests/unit/voice-calls-schema.test.ts`,
  `tests/unit/voice-agents.test.ts`, casos en `tests/unit/nav.test.ts` y
  `tests/unit/health.test.ts` — pruebas
- `tests/e2e/us-agentes-de-voz.md` — guion
