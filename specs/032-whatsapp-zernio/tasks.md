# 032 — Tareas

- [x] Reparto: `zernioTargetChannel` reconoce `whatsapp`
      (`src/server/zernio/dispatch.ts`, `cuentas.ts`).
- [x] Ingesta: `src/server/whatsapp/ingest-zernio.ts` (normalizador puro +
      `processZernioWhatsappEvent`, identidad por teléfono, prefijo `zwa_`).
- [x] Credenciales: tabla `whatsapp_zernio_credentials` + migración
      aditiva `drizzle/0022_whatsapp_zernio.sql` + helper
      (`src/server/whatsapp/credentials-zernio.ts`).
- [x] Conexiones: ramas de WhatsApp en `byOrg` / `byAccountRef` /
      `update` y suma en `zernioConnectionsOfOrg`
      (`src/server/zernio/conexiones.ts`); `WEBHOOK_PATH.whatsapp`.
- [x] Envío: rama Zernio en `prepareSend`, `callWhatsappZernioSend` y
      estado `sent` al aceptar (`src/server/inbox/send.ts`).
- [x] Pruebas unitarias: `tests/unit/zernio-whatsapp-ingest.test.ts`
      (11 pruebas) + actualización de la prueba vieja de Messenger.
- [x] Gates: `tsc --noEmit`, `eslint` en los archivos tocados, suite
      unitaria completa en verde.
- [x] Pantalla de conexión en Ajustes → WhatsApp (ruta
      `/api/settings/whatsapp/zernio` + componente
      `whatsapp-zernio-client.tsx` reutilizando `zernio-connect.tsx`;
      GET/PUT/DELETE, solo el propietario; desconectar borra solo la fila).
- [ ] Guion E2E en vivo (`tests/e2e/us-whatsapp-zernio.md`): sandbox de
      Zernio + instancia no productiva, camino feliz e infeliz.
- [x] `pnpm build` en verde (ruta nueva `/api/settings/whatsapp/zernio`
      compilada en la salida).
- [ ] Publicación: commit en el fork, subida de versión + CHANGELOG +
      etiqueta de imagen (reglas del repo), despliegue en la instancia
      de pruebas y luego corte en TEP (puente n8n primero, webhook
      después, hilo real verificado).
