# 045 — El agente no se calla: fallback a texto crudo

## Problema

Caso real, devapp 2026-10-29 17:49. Hudson probó «Si hacer
otro pedido» y el agente no respondió. El diagnóstico:

- El modelo SÍ generó una respuesta válida en lenguaje
  natural («¡De una! ¿Qué le gustaría pedir? ¿Sigue en la
  mesa 8 o es para llevar?»), pero como **texto plano**,
  sin el JSON de la acción.
- `chatJson` (`src/lib/ai/index.ts`) reintenta 3 veces
  (`MAX_ATTEMPTS = 3`) y el modelo devolvió texto plano las
  3 veces → error final `invalid_output`.
- `src/server/ai/pipeline.ts` (línea ~318) escaló al primer
  fallo a `applyHandoff(conversationId, organizationId,
  "error")` → **la respuesta se perdió** y el agente quedó
  mudo hasta intervención humana (Shey liberó el handoff a
  mano, `handoff_reason = "error"`).

En un restaurante real eso es inaceptable: un solo glitch de
formato del modelo (1 vez en 24 h de devapp, 0 en TEP) deja
al agente sin contestar hasta que alguien lo note. El diseño
de FR-022 dice «fallo persistente», pero el código escala al
primer fallo: el fallo persistente ya no existe, hay que
recuperar lo recuperable.

La decisión de Hudson (2026-10-29 17:54, «Si claro»):
endurecer el turno para que el texto crudo válido se
entregue como respuesta normal en vez de perderse.

## Contexto

- `chatJson<T>` (línea 43 de `src/lib/ai/index.ts`) es la
  ÚNICA frontera con el proveedor de IA (Constitución II):
  ya rastrea el loop de reintentos, `extractJson` intenta 3
  candidatos (bloque ```json, texto completo, del primer
  `{` al último `}`) y devuelve `ChatJsonResult<T>`.
- El turno del agente (`pipeline.ts`, línea 311) llama a
  `chatJson(agentActionSchema(agenda), messages, {
  organizationId })`; si `!result.ok` → handoff `"error"`.
- El juez del Laboratorio (`src/server/lab/judge.ts`, línea
  44) llama a `chatJson(Verdict, …, { judge: true,
  organizationId })` sin tocar el turno del agente: no le
  aplica el fallback.
- Spec 044: el hook en `pipeline.ts` captura
  `PEDIDO CONFIRMADO … Total: ₡X` del texto del turno y fija
  el monto. El fallback debe devolver la respuesta al flujo
  normal para que ese hook siga funcionando.

## Decisiones

**D1 — `chatJson` rastrea `lastRaw` y acepta
`fallbackToRawReply`.** En `src/lib/ai/index.ts`: la
variable `lastRaw` guarda la salida cruda del último intento
del loop de reintentos (sin truncar). Se agrega la opción
`fallbackToRawReply?: boolean`, default `false`. Solo el
turno del agente la pasa (`pipeline.ts`); la frontera con el
proveedor queda sin cambios para todo lo demás.

**D2 — Tras el loop, el crudo calificado se valida como
`reply`.** Si el error final del loop es `invalid_output`,
la opción está activa y el crudo califica (D3), se intenta
`schema.safeParse({ action: "reply", text: crudoTrimmed })`.
Si valida → retornar `{ ok: true, data, raw: lastRaw,
recoveredFromRaw: true }`. Si no valida, o no califica, se
devuelve el fallo actual sin cambios.

**D3 — Calificación pura `textoCrudoSirveComoRespuesta`.**
Función pura, con tests: el crudo se hace `trim` y califica
si y solo si (a) largo ≥ 1, y (b) NO parece un intento roto
de JSON: contiene la cadena `"action"` seguida de `:`, O
empieza con `{`. El resto (largos máximos, forma del
esquema) lo impone el propio `safeParse` del esquema: nada
de reglas de negocio aquí.

**D4 — El contrato de retorno solo crece.** El tipo
`ChatJsonResult` gana `recoveredFromRaw?: boolean` en la
variante `ok: true` (opcional, no rompe a ningún
consumidor). La variante `ok: false` queda intacta: `not_configured`,
`provider_error`, `invalid_output`, `detail`.

**D5 — El turno del agente activa el fallback y lo loguea.**
En `pipeline.ts`, la llamada de la línea 311 pasa
`fallbackToRawReply: true`. Después, si `result.ok &&
result.recoveredFromRaw` → `console.log("[agente] turno
recuperado de texto crudo")` para medir la frecuencia del
glitch en producción (el caso real fue 1/24 h; el log dice
si crece).

**D6 — La respuesta recuperada sigue el flujo NORMAL.** El
`data` recuperado es una acción `reply` válida: corre todo
el pipeline como si el modelo la hubiera devuelto (incluido
el hook 043/044: un «PEDIDO CONFIRMADO … Total: ₡X» que
llegó como crudo también captura el monto). No hay rama
especial post-recuperación.

**D7 — La rama `!result.ok` queda intacta.** Si no hay nada
entregable (crudo vacío, con pinta de JSON roto, o
`safeParse` falla), `pipeline.ts` escala a
`applyHandoff(..., "error")` exactamente como hoy.

**D8 — SIN cambios para:** `not_configured` (sale antes
del loop), `provider_error` (falla del proveedor: nada que
entregar), llamadas del juez del Laboratorio (no pasan la
opción → comportamiento idéntico), crudo vacío, o crudo con
pinta de JSON roto.

## Límites honestos (no maquillados)

- **El fallback no reintenta el modelo.** Usa el crudo del
  ÚLTIMO intento del loop existente. Si el modelo está
  devolviendo basura tres veces seguidas, se entrega lo que
  devolvió la tercera; no se le pregunta una cuarta.
- **Si el crudo supera los largos máximos del esquema, no
  se recupera.** `agentActionSchema` impone topes de texto;
  el `safeParse` los hace cumplir y el fallo escala a
  handoff como hoy. Un crudo larguísimo no se entrega por
  pedazos ni se recorta: se escala.
- **El glitch puede repetirse.** El fallback entrega la
  respuesta de este turno; no repara que el modelo esté en
  racha de texto plano. La frecuencia se mide con el log de
  D5; si el log arde, el problema es del prompt o del
  modelo, no de esta puerta.
- **El texto crudo no trae acción.** Lo recuperado siempre
  es `reply`, nunca `update_lead`, `move_stage` ni
  `handoff`. Un turno que iba a confirmar un pedido como
  texto plano NO captura el monto por acción (pero sí por
  el hook 044 si trae el marcador y la línea Total —
  criterio 9).
- **`raw` de la respuesta exitosa.** En la recuperación,
  `raw` es el crudo completo sin truncar (el log de
  recuperación no lo imprime; `detail` del fallo solo
  existe en la rama de error).

## Lo que NO entra

- Cambio del contrato `/api/bot/*`: ni forma ni códigos.
- Migraciones: no hay cambio de modelo de datos.
- Dependencias nuevas: ninguna.
- `src/server/leads/stage-history.ts`: no se toca.
- Los archivos untracked `src/server/manual-chat/` y
  `src/app/api/bot/manual-chat/`: siguen APARCADOS, no se
  reactivan ni se usan.
- Cambios al prompt del agente (`prompts.ts`) ni al
  recordatorio de formato (029): esta spec es la red,
  no el reemplazo del formato.
- Push, PR, merge ni despliegue: esta entrega es solo la
  spec. El código lo hace otro subagente y los gates los
  corre el coordinador.

## Criterios de aceptación

1. Crudo plano («¡De una! ¿Qué le gustaría pedir?», sin
   pinta de JSON) con la opción activa → `ok: true`,
   `recoveredFromRaw: true`, `data = { action: "reply",
   text }` con el texto intacto (trimmeado).
2. Crudo que contiene `"action":` con la opción activa →
   `ok: false`, `error: "invalid_output"`, sin intento de
   recuperación.
3. Crudo que empieza con `{` con la opción activa →
   `ok: false`, `error: "invalid_output"`, sin intento de
   recuperación.
4. Crudo vacío (o solo espacios) → `ok: false`, sin
   recuperación.
5. `provider_error` (proveedor caído o 401/402 tras el
   loop) con la opción activa → `ok: false`, sin intento de
   recuperación.
6. Opción apagada (default) con crudo plano → el retorno
   es el de hoy: `ok: false`, `error: "invalid_output"`,
   `detail` intacto. Comportamiento idéntico al actual.
7. El juez del Laboratorio llama sin la opción → su
   comportamiento y sus tests no cambian.
8. Turno del agente recuperado → el log `[agente] turno
   recuperado de texto crudo` aparece una vez por turno
   recuperado.
9. Respuesta recuperada con marcador `PEDIDO CONFIRMADO`
   y línea `Total: ₡4.300` → el hook 044 captura el monto
   (el lead queda con el monto parseado): la recuperación
   no salta el flujo normal.
10. Gates en verde: `pnpm typecheck`, `pnpm lint`,
    `pnpm test` (incluidas las pruebas nuevas) y
    `pnpm build` OK.

## Pruebas unitarias (vitest, sin BD)

1. `textoCrudoSirveComoRespuesta` (pura): los casos de los
   criterios 1–4 más bordes: texto con `"` sueltas que no
   son `"action":` → sí sirve; `{` en medio del texto (no
   al inicio) → sí sirve; `{"action":` incompleto → no
   sirve.
2. `chatJson` con mock del proveedor que devuelve texto
   plano 3 veces y opción activa → `ok: true` con
   `recoveredFromRaw: true` y `raw` igual al crudo del
   tercer intento (verifica que es el último, no el
   primero).
3. Mismo mock sin la opción → `ok: false`,
   `error: "invalid_output"` (guardián del default).
4. Mock con `provider_error` (lanza) y opción activa →
   `ok: false`, sin recuperación.
5. Crudo plano que excede el largo máximo del esquema de
   prueba → `ok: false` (el `safeParse` manda).
6. Compatibilidad: ningún test exige `recoveredFromRaw`
   en consumidores viejos (la llave es opcional) y el
   contrato `/api/bot/*` no cambia.

## Verificación en vivo en devapp (la hace Shey, no el autor de esta spec)

1. Provocar el glitch (o esperar uno): el turno entrega la
   respuesta en texto plano como mensaje normal, sin
   handoff y sin que el agente se calle.
2. Buscar `[agente] turno recuperado de texto crudo` en los
   logs tras 24 h de uso: frecuencia del glitch medible.
3. Caso del 2026-10-29 17:49 («Si hacer otro pedido»): la
   respuesta «¡De una! ¿Qué le gustaría pedir?…» llega al
   cliente aunque el modelo la mande sin JSON.
4. Tienda: conversación normal — nada cambia salvo que el
   glitch ocurra (entonces también se recupera).

## Dependencias

- Ninguna en código nuevo salvo lo que ya existe: usa
  `chatJson` (`src/lib/ai/index.ts`), el turno del agente
  en `pipeline.ts` (línea 311) y el hook 043/044. El juez
  del Lab (`judge.ts`) no se toca porque no pasa la opción.
- Orden de merge: independiente de 044; puede mergearse en
  cualquier orden.

## Reconciliación con lo construido

Al redactar esta spec (2026-10-29 ~17:58) se buscó
`fallbackToRawReply` en todo `src/`: **no existe** — el
implementador aún no empezó. La spec se escribió sobre el
código vigente (`chatJson` con loop de 3 intentos,
`pipeline.ts:311` y rama `!result.ok` → handoff `"error"`).
Desvíos: ninguno; si la implementación introduce alguno
(ej. nombre distinto para la opción o la función de
calificación), anotarlo aquí antes del PR.
