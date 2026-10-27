# 031 — Canal de correo (IMAP/SMTP)

## Problema

Vocero atiende WhatsApp, Instagram, Messenger y TikTok, pero el correo del
negocio queda fuera: el cliente no ve en su plataforma las conversaciones
que llegan por email, ni el agente puede responderlas. Hoy ese hueco se
tapa fuera del CRM (agentes en n8n), con el historial partido en dos.

## Decisión

Canal `email` tras la bandera `CHANNELS`, como los demás canales
opcionales (ADR-001), con transporte genérico **IMAP/SMTP**: cada negocio
conecta su propio buzón (Gmail, Microsoft 365 o dominio propio) con su
host, puerto, usuario y contraseña. IMAP/SMTP no tiene webhooks, así que
la entrada es un **sondeo en proceso cada 60 s** (patrón del worker del
despacho, spec 021). Decisión de Hudson (2026-10-17): genérico, no solo
Gmail. Aprobación de construcción: 2026-10-20.

## Modelo de datos (migración 0021)

- `email_credentials`: un buzón por organización. Host/puertos IMAP y SMTP,
  usuario y contraseña cifrada (AES-256-GCM, `src/lib/crypto`), estado del
  sondeo (`uid_validity`, `last_seen_uid`), salud (`status`, `last_error`,
  `last_check_at`).
- `message`: `email_message_id` (UNIQUE — idempotencia del sondeo),
  `email_subject`, `email_in_reply_to`.
- `agent_profile`: `email_signature` (firma al pie de las respuestas).

## Comportamiento

- Identidad del contacto: `email:<dirección en minúsculas>`; una
  conversación por contacto (invariante existente de la bandeja).
- El buzón se abre en solo lectura y nunca se tocan flags: la
  idempotencia vive en `last_seen_uid` + `email_message_id`.
- Primera conexión (o `UIDVALIDITY` nuevo): baseline en el UID más alto;
  no se importa el historial.
- Guardas anti-bucle: remitente = el propio buzón, `mailer-daemon`,
  `postmaster`, header `X-Vocero-Sent`, `Auto-Submitted` ≠ `no`,
  `X-Auto-Response-Suppress`.
- Capacidades: sin ventana, texto plano, sin acuses (nace `sent` al aceptar
  el SMTP), sin adjuntos salientes en esta entrega.
- Contraseña de Gmail: el buzón de Google exige **contraseña de
  aplicación**; la UI lo documenta. OAuth2 queda para una spec futura.

## Fases

1. **Leer y mostrar**: migración, canal, credenciales, sondeo, pantalla
   Ajustes → Correo (conectar/probar/desconectar) y distintivo en bandeja.
   El agente NO responde correos en esta fase (no hay envío todavía).
2. **Responder**: envío SMTP con hilo (`Re:`, `In-Reply-To`, `References`,
   `X-Vocero-Sent`), bloque de correo en el prompt del agente, firma, y
   encendido del turno para el canal. El agente solo responde correos de
   las últimas 72 h; lo más viejo queda para una persona.
3. **Pulir** (fuera de esta spec): adjuntos, OAuth2, carpetas, asunto
   editable.

## Reglas abiertas (decididas en el diseño, 2026-10-18)

- «Probar conexión» no guarda nada.
- No marcar correos como leídos en el servidor.
- Un buzón por organización.
