# 032 — WhatsApp por Zernio

> NOTA DE HONESTIDAD (Principio VI): este spec se escribió DESPUÉS del
> primer incremento de implementación (reparto, ingesta, envío, credenciales,
> migración 0022, pruebas unitarias). Es documentación de lo ya construido y
> diseño de lo que falta (pantalla de conexión, prueba en vivo, corte), no
> diseño previo de todo. El diseño previo al código vive en el documento de
> trabajo del operador (diseño WhatsApp nativo vía Zernio, 2026-10-26).

## Problema

Un negocio con su número de WhatsApp conectado a través de Zernio (socio
oficial de Meta, API unificada) no puede ver ni responder esos mensajes en
Vocero: el reparto de Zernio solo reconocía Instagram, Messenger y TikTok y
descartaba los eventos de WhatsApp en silencio. El operador tenía que
responder por fuera (puente en n8n) y la bandeja quedaba vacía.

## Comportamiento observable

1. Un mensaje de WhatsApp que llega por Zernio aparece en la bandeja de
   Vocero, en la conversación del contacto por teléfono, con su texto y su
   hora real de envío.
2. El agente incluido responde ese hilo por Zernio (no por Meta directo) y
   la respuesta sale como mensaje saliente en el mismo hilo.
3. El operador responde desde la bandeja y el mensaje sale por Zernio.
4. Sin conexión Zernio guardada, el evento se descarta con un aviso en el
   log (no se ingiere nada de una cuenta desconocida) y el camino de Meta
   directo sigue exactamente igual que antes.
5. Fuera de la ventana de 24 h, el envío libre se rechaza con el mismo
   `window_closed` de WhatsApp; no hay etiqueta de agente humano para
   WhatsApp por Zernio.
6. Un mensaje reentregado por Zernio no se duplica (idempotencia por id de
   mensaje con prefijo `zwa_`).
7. Los salientes por Zernio quedan en estado `sent` al aceptarlos la API
   (Zernio no manda acuses que avancen el estado, como los demás canales
   de Zernio); por Meta siguen en `pending` hasta el acuse.

### Criterios de aceptación (verificables)

- [x] `normalizeZernioWhatsappEvent`: 11 pruebas unitarias
      (`tests/unit/zernio-whatsapp-ingest.test.ts`).
- [x] `zernioTargetChannel` reconoce `whatsapp` y sigue devolviendo null
      para plataformas no atendidas (prueba vieja de Messenger actualizada).
- [x] `tsc --noEmit`, `eslint` en los archivos tocados y suite unitaria
      completa en verde.
- [ ] Guion E2E (`tests/e2e/us-whatsapp-zernio.md`) corrido en vivo: cuenta
      sandbox de Zernio + instancia no productiva (camino feliz e infeliz).
- [x] Pantalla de conexión en Ajustes → WhatsApp (ruta
      `/api/settings/whatsapp/zernio` + tarjeta reutilizando el formulario
      Zernio compartido). Pendiente su verificación en vivo.
- [ ] Corte en la Tienda: puente n8n desactivado primero, webhook reapuntado
      a Vocero TEP, hilo real verificado en la bandeja.

## Decisiones

- **D1. Un canal, dos transportes.** Como Instagram y Messenger: el canal
  `whatsapp` gana un adaptador Zernio junto al de Meta. El núcleo (ingesta,
  ventana, agente) no conoce a Zernio: ve canal `whatsapp` y un hilo.
- **D2. El transporte lo decide el hilo.** El envío sale por Zernio cuando
  la conversación trae `channel_thread_ref` (que el transporte de Meta
  nunca escribe) y la organización tiene conexión Zernio. Un número, un
  proveedor a la vez. SUPUESTO VISIBLE: si un número volviera de Zernio a
  Meta, el hilo viejo seguiría apuntando a Zernio (Meta no limpia el
  campo); habría que limpiarlo a mano o con una columna de transporte
  (pendiente, no bloquea el primer cliente: un número no cambia de
  proveedor cada semana).
- **D3. La identidad es el teléfono.** Sin prefijo nuevo: la identidad del
  contacto es el teléfono normalizado (misma regla que Meta, `normalizeMx`).
  El remitente real viene en `sender.phoneNumber`; el tipo de evento se
  amplió para contemplarlo.
- **D4. Ruta del webhook reutilizada.** WhatsApp no tiene ruta propia de
  Zernio; el reparto es por plataforma y vale cualquiera de las rutas de
  Zernio, así que se usa la de Messenger (`WEBHOOK_PATH.whatsapp`). En una
  instancia sin Messenger encendido esa ruta no existe: la pantalla de
  conexión deberá exigir un canal social o una ruta propia (pendiente de
  la pieza de UI).
- **D5. Sin llave de idempotencia en el saliente.** Igual que Messenger:
  en el momento del envío aún no existe el id del mensaje. La idempotencia
  fuerte está en la entrada (Principio IV).
- **D6. `ZERNIO_CHANNELS` no cambia.** Esa lista decide la superficie de
  Ajustes → Estado (ADR-001) y WhatsApp está siempre encendido; meterlo
  ahí encendería esa superficie en instancias solo-WhatsApp. La conexión
  de WhatsApp se suma aparte en `zernioConnectionsOfOrg` (firmas, webhook,
  estado).

## Chequeo constitucional

- **I (secretos):** llave y secreto de firma en columnas `*_cipher`,
  `*_iv`, `*_tag` con AES-256-GCM; nunca a logs ni al cliente.
- **II (soberanía):** Zernio es socio oficial de Meta y el tráfico sigue
  siendo Cloud API oficial, por la API unificada del BSP (mismo precedente
  que 014/017/022). El transporte es inerte por defecto: sin conexión
  guardada no corre ningún camino nuevo y la instancia funciona completa
  por Meta. Las credenciales son las del propio negocio. La condición de
  «bandera de despliegue» se cumple por la vía del precedente existente
  (el transporte se elige por organización en Ajustes, como el modo
  Zernio de Messenger), no por una bandera nueva: documentado aquí, no
  enterrado.
- **III (multi-tenancy):** `organization_id` NOT NULL en la tabla nueva y
  consultas filtradas por organización, como los demás canales.
- **IV (idempotencia):** dedup por `wa_message_id` UNIQUE con prefijo
  `zwa_` (nunca colisiona con un `wamid.*` de Meta).
- **VIII (foco):** atender conversaciones de WhatsApp de un negocio. En
  el centro del foco.
- **Pendiente (V, IX):** build completo y prueba en vivo con sandbox
  (guion E2E) antes de declarar la feature hecha. Este incremento NO es
  la feature completa.

## Modelo de datos (migración aditiva 0022)

`whatsapp_zernio_credentials`: `id`, `organization_id` (FK cascade),
`source` (`zernio`), `account_ref` NOT NULL (por él enruta el webhook),
`display_name`, `token_cipher`/`_iv`/`_tag` NOT NULL,
`webhook_secret` (obsoleta, 030), `webhook_secret_cipher`/`_iv`/`_tag`,
`status` (`connected` / `reconnect_required`), timestamps. Índices
únicos por organización y por `account_ref`. Sin cambios en tablas
existentes; `ZernioEvent.sender` gana `phoneNumber` (solo tipo).

## Qué NO hace (y por qué)

- **Prueba en vivo:** pendiente (guion E2E con sandbox + devapp).
- **Adjuntos descargados:** v1 registra el tipo (imagen, video, audio,
  documento) sin descargar, igual que los demás canales de Zernio.
- **Ruta propia de webhook para WhatsApp:** pendiente (ver D4).
- **Columna de transporte en la conversación:** pendiente (ver D2).
- **Subida de versión / CHANGELOG / etiqueta de imagen:** pendiente del
  paso de publicación (la copia de trabajo no es un checkout git).
