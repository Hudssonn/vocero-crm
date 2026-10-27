# 031 — Tareas

## Fase 1 — Leer y mostrar
- [x] Migración 0021 (email_credentials, columnas en message, email_signature)
- [x] Canal `email` en el catálogo + capacidades
- [x] Credenciales cifradas (`server/email/credentials.ts`)
- [x] Sondeo IMAP + ingesta con guardas anti-bucle
- [ ] Pantalla Ajustes → Correo + APIs (guardar / probar / desconectar)
- [ ] Estado del canal en Ajustes → Canales
- [ ] Prueba con buzón real: conectar, escribir, ver en la bandeja

## Fase 2 — Responder
- [ ] Envío SMTP con hilo y `X-Vocero-Sent`
- [ ] Bloque de correo en el prompt + firma del agente
- [ ] Encender el turno del agente (solo correos ≤ 72 h)
- [ ] Prueba punta a punta: correo entrante → respuesta del agente

## Gates
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build`

## Fase 2 — envío y agente (hecho en código, gates verdes 2026-10-20)

- [x] `src/server/email/send.ts` — SMTP saliente con hilo, marca y Message-ID propio
- [x] Rama de correo en `sendText()`/`prepareSend` (sin ventana; firma del agente solo en envíos de IA)
- [x] Bloque de formato de correo en el prompt cuando la conversación es de correo
- [x] El agente responde correos de ≤72 h (los viejos quedan para una persona)
- [x] Campo de firma en la pantalla del Agente

**Desplegado 2026-10-20** en /opt/vocero-crm y /opt/vocero-tep (CHANNELS=whatsapp,email; respaldos /opt/backups/*-pre-correo-20261020.tar.gz e imágenes vocero-rollback:pre-correo-*). Prueba viva con GreenMail: línea base sin importar historial, ingesta con asunto/hilo, guardas anti-bucle, respuesta de operador entregada con In-Reply-To/References/X-Vocero-Sent. Pendiente vivo: conectar un buzón real por instancia y la respuesta del AGENTE con LLM real (falta la llave de IA en la org).
