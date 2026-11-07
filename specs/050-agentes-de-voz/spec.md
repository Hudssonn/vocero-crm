# 050 — Agentes de voz

Los agentes de voz de ElevenLabs (Alex, Sofía y Luciano) ya atienden por
teléfono, pero el CRM no los enseña por ningún lado: ni para probarlos ni
para ver qué llamadas atendieron. Esta spec les da su pestaña en el CRM,
detrás de la bandera `VOZ` (patrón ADR-001, igual que `AGENDA`).

## Pestaña "Agentes de voz" (`/voice`)

- Entrada en el menú, grupo "Agente", tras "Laboratorio" (`src/lib/nav.ts`).
- Selector con los 3 agentes + widget web de ElevenLabs para probarlos:
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
  (vendedor de SolidGround, `agent_8801m4gb7nnze8kaqsh1gc5ddpxx`).
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

## Lo que NO cubre (a propósito)

- **Mapeo del puente sin verificar**: el nodo "Normalizar" del puente lee
  campos adivinados en la raíz del body (`caller_phone`, `duration_secs`,
  `summary`…), pero el webhook real de ElevenLabs trae
  `data.conversation_id`, `data.transcript[]`,
  `data.analysis.call_summary` y `data.metadata`. El puente NO se tocó (no
  pertenece a este repo); el endpoint acepta sus campos actuales + los
  opcionales. Verificar el mapeo contra un webhook real es trabajo aparte.
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
- `src/app/api/voz/post-llamada/route.ts` — solo el handler POST
- `src/app/api/voice/calls/route.ts` — solo el handler GET
- `src/app/(app)/voice/page.tsx` + `src/components/voice/voice-client.tsx` — pestaña
- `src/lib/nav.ts`, `src/components/app-nav.tsx`, `src/components/app-shell.tsx`,
  `src/app/(app)/layout.tsx` — entrada en el menú tras `VOZ`
- `src/server/health.ts` — `features.voz`
- `tests/unit/voice-flag.test.ts`, `tests/unit/voice-calls-schema.test.ts`,
  `tests/unit/voice-agents.test.ts`, casos en `tests/unit/nav.test.ts` y
  `tests/unit/health.test.ts` — pruebas
- `tests/e2e/us-agentes-de-voz.md` — guion
