# 031 — Plan

1. `schema.ts` → `pnpm db:generate` (migración 0021) → revisar el SQL.
2. `lib/channels.ts`: `email` en el catálogo (etiqueta «Correo») +
   `CHANNEL_CAPABILITIES.email` (sin ventana, `plain`, sin acuses).
3. `server/email/credentials.ts`: CRUD con la contraseña cifrada; guardar
   sin contraseña conserva la anterior.
4. `server/email/poller.ts` + `server/email/ingest.ts`: sondeo IMAP
   (imapflow) en solo lectura, baseline, guardas anti-bucle, parseo
   (mailparser) e ingesta por el camino común (contacto, conversación,
   lead, eventos SSE). Arranque en `instrumentation-node.ts`.
5. UI: `settings/email` + APIs `settings/email` (GET/PUT/DELETE) y
   `settings/email/test` (sin guardar), distintivo en la bandeja, entrada
   en Ajustes → Canales y en el estado de canales.
6. Fase 2: `server/email/send.ts` (nodemailer) + rama en `sendText()` +
   bloque de correo en `buildAgentSystemPrompt()` + firma editable +
   encendido del turno para el canal.

Dependencias nuevas: `imapflow`, `mailparser`, `nodemailer` (bibliotecas,
no servicios: el correo vive en el servidor del cliente — constitución II).
