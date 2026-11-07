# US — Agentes de voz

Pestaña "Agentes de voz" (`/voice`) detrás de la bandera `VOZ`: probar los
agentes de ElevenLabs (Alex, Sofía, Luciano y Soda La Esquina) con el widget web y ver el
historial de llamadas que deja el puente de voz.

## Precondición

- App viva con `VOZ=on` y `VOZ_API_KEY` con al menos 16 caracteres
  (p. ej. `VOZ_API_KEY=llave-de-prueba-de-16+`).
- Sesión iniciada como dueño. El widget de ElevenLabs necesita internet:
  sin ella, la prueba del widget es solo visual (el elemento y el script
  cargan, la llamada no conecta).

## Camino feliz

1. Abrir la app: en el menú, grupo "Agente", tras "Laboratorio", aparece
   **"Agentes de voz"**.
2. Entrar a "Agentes de voz": se ven los 4 agentes (Alex — Expresiones
   Artísticas, vendedor; Sofía — asesora laboral; Luciano — vendedor de
   SolidGround; Soda La Esquina — pedidos y reservas), cada uno con estado "Activo" y "Sin número asignado".
3. Con Alex seleccionado, el widget de ElevenLabs se pinta (botón de llamada
   visible, contenedor con altura mínima). La UI avisa que cambiar de agente
   corta la llamada activa y que probar gasta minutos del plan de ElevenLabs.
4. Cambiar a Sofía: el widget se re-monta con el agente de Sofía (el
   `agent-id` del elemento es `agent_1401m4fnaet4fda9q53rwx6ceh5h`).
5. Hablar con el agente (opcional, con internet): la llamada conecta y el
   agente responde como Sofía.
6. Simular el puente: `POST /api/voz/post-llamada` con header
   `X-Voz-Key` y body
   `{"instance":"tep","phone":"50688888888","name":"María","direction":"inbound","duration_sec":95,"summary":"Preguntó por precios.","recording_url":""}` →
   **201** `{ ok: true, id, duplicate: false }`.
7. Repetir el mismo POST añadiendo `"conversation_id":"conv_prueba_1"` →
   **201** la primera vez; repetirlo → **200** `{ duplicate: true }` con el
   mismo `id`, sin duplicar la fila.
8. Volver a la pestaña: el historial muestra la llamada (fecha, 50688888888
   / María, duración 1:35, resumen "Preguntó por precios.", grabación "—",
   transcripción "—").
9. `GET /api/health` responde `features.voz: true`.

## Pedido por voz → pantalla de cocina (Soda La Esquina)

Precondición: la instancia es la de la soda (pipeline con etapa «Nuevo
pedido») y el puente n8n ya importa `Puente_Voz_Vocero.json` con la llave
real en `X-Voz-Key` y el flujo activo. En ElevenLabs, "Transcription"
activado en los post-call webhooks (si no, solo llega el resumen).

1. Llamar al agente de Soda La Esquina y pedir: dos casados con pollo sin
   cebolla y un fresco de cas, para la mesa 4, a nombre de Andrea, pago en
   el local. Confirmar el pedido completo y el total (ocho mil doscientos
   colones) antes de cerrar.
2. El agente dice que el pedido quedó registrado y pasa a la cocina.
3. El webhook post-llamada llega al puente, que normaliza
   (`data.conversation_id`, resumen y transcripción) y hace POST a
   `/api/voz/post-llamada` → **201** con la llamada registrada.
4. En el pipeline, aparece una tarjeta nueva en «Nuevo pedido» con el
   monto ₡8.200.
5. En la pantalla de cocina (`GET /api/bot/board`) la tarjeta enseña:
   `PEDIDO CONFIRMADO`, `Canal: Voz`, `Llamada: <conversation_id>`,
   `MESA: 4`, `Cliente: Andrea`, `2x Casado con pollo — sin cebolla`,
   `1x Fresco de cas`, `Pago: En el local`, `Total: ₡8200`.
6. En la pestaña «Agentes de voz» el historial muestra la llamada con su
   resumen y transcripción.

Camino infeliz (pedido incierto):

1. Llamar y pedir algo que no se entiende (plato que no existe, o total
   que no se confirma).
2. El POST a `/api/voz/post-llamada` responde **201** igual (la llamada
   queda registrada), pero NO aparece tarjeta nueva en «Nuevo pedido»: el
   pedido no se creó y queda en el historial de voz para revisión humana.
3. Repetir el mismo POST con el mismo `conversation_id` → **200**
   `duplicate: true`, sin duplicar ni la llamada ni el pedido.

## Camino infeliz

1. **Sin `VOZ`**: con la bandera apagada, `/voice` responde **404**, la
   entrada no aparece en el menú, `POST /api/voz/post-llamada` y
   `GET /api/voice/calls` responden **404**, y `features.voz` es `false`.
2. **Sin llave o con llave mala**: `POST /api/voz/post-llamada` sin header
   `X-Voz-Key` o con otro valor → **401** `unauthorized`.
3. **Body inválido**: POST sin `phone` → **422** `invalid_body` con el
   detalle; con `direction: "perdida"` → **422**.
4. **Sin llamadas**: con el historial vacío, la pestaña muestra "Todavía no
   hay llamadas registradas" (no una tabla vacía ni un error).
5. **Sin sesión**: `GET /api/voice/calls` sin sesión → **401**.

## Criterios de aceptación

- La pestaña solo existe con `VOZ=on`; apagada, todo es 404 (no 403).
- El widget usa solo el agent ID público; ninguna llave viaja al cliente.
- El historial muestra exactamente lo que guardó el puente: lo que no vino
  se ve como "—", nunca inventado.
- Un `conversation_id` repetido no duplica la llamada.
- Un pedido por voz válido aparece en «Nuevo pedido» y en la pantalla de
  cocina con el formato `PEDIDO CONFIRMADO` / `Canal: Voz`; uno incierto
  no crea tarjeta y queda en el historial de voz para revisión humana.
- `GET /api/voice/calls` nunca devuelve llamadas de otra organización (el
  alcance es la sesión, nunca un parámetro).
