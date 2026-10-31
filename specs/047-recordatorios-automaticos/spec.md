# Spec 047 — Recordatorios automáticos

## Contexto

Paquete SolidGround: ₡50.000/mes por negocio. El negocio configura cuántas
horas antes de la cita el sistema envía un recordatorio por WhatsApp vía
Kapso (canal de spec 046). Sin terceros nuevos: el envío viaja por
`sendKapsoMessage` (`src/server/whatsapp/send-kapso.ts`), como el agente.

## Decisión de diseño

**D1. Modelo en dos tablas (ya creado por el coordinador).** `reminder_config`
(una fila por organización: `enabled`, `hours_before`, `message` con
`{{nombre}}`, `{{fecha}}`, `{{hora}}`) y `reminder` (uno por cita viva:
`booking_id`, `contact_id`, `scheduled_at` en UTC, `message` ya renderizado,
`status` `pendiente|enviado|fallido|cancelado`, `attempts`, `sent_at`,
`last_error`). Migración `drizzle/0024_tiresome_moondragon.sql` generada; el
negocio edita solo la configuración, nunca los recordatorios.

**D2. Generación en el hook de la cita.** `generarRecordatorioParaCita` se
llama tras crear una cita (`createSessionBooking`) y al moverla
(`rescheduleBooking`: cancela el vivo y genera uno nuevo). Se salta si la
config está apagada, la cita no está `agendada` o `isTest`. Nunca tira la
creación: un fallo del recordatorio se queda en log. Cancelar la cita
(`cancelBooking`) marca sus recordatorios `cancelado`.

**D3. El mensaje se renderiza al generar.** `{{nombre}}` (contacto), `{{fecha}}`
y `{{hora}}` se calculan con `calendar_settings.timezone` (default
`America/Costa_Rica`) y quedan guardados en la fila: si el negocio cambia la
plantilla o la zona después, los recordatorios ya programados no cambian.

**D4. Worker en proceso, espejo del de despacho.** `iniciarWorkerRecordatorios`
(setInterval cada 60 s) + `tanda()` que toma hasta 20 `reminder` con
`scheduled_at <= now` y `status = 'pendiente'`, ordenados por hora. Reanuda en
`resumeReminders()` en `src/instrumentation-node.ts`, junto a
`resumeDispatch`. Estado en `globalThis` como en `dispatch/worker.ts` (en dev
los módulos se evalúan más de una vez).

**D5. Envío y reintento.** Por recordatorio: credenciales Kapso de la org
(`getWhatsappKapsoCredentialsByOrg`); teléfono de `contact.phone`; si no hay
número o la cita ya no está `agendada`, el recordatorio se descarta
(`fallido`/`cancelado`). Éxito → `enviado` + `sent_at`. Error transitorio →
`attempts++`, sigue `pendiente` y se reprograma a
`now + 10 min × attempts`; con 3 intentos → `fallido` con `lastError`.
Auth de Kapso (401/403) → `markWhatsappKapsoReconnectRequired`, como el
agente. `is_test` nunca dispara envíos.

**D6. API.** `GET/PUT /api/settings/reminders` (solo owner, zod; el `GET`
devuelve la config con defaults si aún no existe) y
`GET /api/reminders?status=&limit=&offset=` (lista paginada simple para ver
qué se envió y qué falló). Tras la bandera `AGENDA`: sin agenda, 404 como el
resto de la superficie.

**D7. Pureza.** El render (`render.ts`) y el cálculo de `scheduledAt` son
funciones puras testeables sin BD. La lógica vive en `src/server/`; los
`route.ts` solo exportan handlers.

## Criterios de aceptación (verificables)

1. Gates en verde (`tsc`, `eslint`, `vitest`).
2. Crear una cita → fila `reminder` `pendiente` con
   `scheduledAt = cita − hoursBefore` y el mensaje con nombre/fecha/hora en
   la zona del negocio.
3. Cita de prueba (`is_test`) o config apagada → sin fila.
4. Mover la cita → el recordatorio viejo se cancela y nace uno con la hora
   nueva; no hay dos `pendiente` para la misma cita (índice parcial).
5. Cancelar la cita → el recordatorio queda `cancelado`.
6. El worker envía por Kapso al llegar la hora: `enviado`, `sent_at` y
   `attempts` en 1; un fallo transitorio reprograma, tres fallos → `fallido`.
7. `PUT /api/settings/reminders` con `hoursBefore` fuera de 1–72 → 422; el
   `GET` nunca devuelve secretos.
8. Suite existente intacta.

## Qué NO se toca

- `src/lib/db/schema.ts`, `src/lib/db/ids.ts`, `drizzle/` (coordinador).
- El núcleo de WhatsApp (`inbox/send.ts`): el recordatorio usa Kapso
  directo, no el enrutado por conversación.
- Plantillas de Meta, 24h de ventana y `lead.stage_id`.
