import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { mediaDirStatus } from "@/server/media-dir";
import { leerConfigDespacho } from "@/server/brains/config";
import { iniciarWorker, tanda } from "@/server/dispatch/worker";
import { isChannelEnabled } from "@/server/channels/enabled";
import { iniciarPollerCorreo } from "@/server/email/poller";
import { iniciarWorkerCampanas, tandaCampanas } from "@/server/campaigns/worker";
import { cifrarSecretosEnClaro } from "@/server/zernio/secreto-guardado";
import { agendaEnabled } from "@/server/agenda/flag";
import {
  iniciarWorkerRecordatorios,
  tanda as tandaRecordatorios,
} from "@/server/reminders/worker";

/**
 * 008 — Aviso al arranque si MEDIA_DIR no es escribible. Sin esto, el primer
 * síntoma era un 500 al subir el logo o el icono, o adjuntos entrantes "no
 * disponibles" (se reintentan al abrirlos, pero solo mientras Meta los
 * conserve), con el EACCES enterrado en el log de un request. Se prueba
 * escribiendo de verdad (lo mismo que hará saveMediaFile) y nunca tumba el
 * arranque: el resto del CRM funciona sin adjuntos.
 *
 * El sondeo vive en `server/media-dir.ts` y es el mismo que `/api/health`
 * expone como `mediaWritable` (#82): este resultado queda cacheado y el
 * healthcheck lo reutiliza en vez de volver a escribir.
 */
export async function checkMediaDir(): Promise<void> {
  const media = await mediaDirStatus();
  // Sin entorno válido no hay nada que sondear: lo reporta, con detalle, el
  // primer getEnv() de la app.
  if (!media || media.writable) return;
  console.error(
    `[boot] MEDIA_DIR=${media.dir} no es escribible (${media.code}): los adjuntos entrantes, el logo y el icono NO se van a poder guardar. ` +
      "En Docker: monta un volumen persistente en /data (la imagen ya usa /data/media) y arranca el contenedor como root —el default—, " +
      "que el entrypoint le da el volumen al usuario de la app. Fuera de Docker: apunta MEDIA_DIR a un directorio escribible."
  );
}

/**
 * Limpieza al arranque (FR-034): corridas del Laboratorio que quedaron
 * "running" tras un reinicio → fallidas. Solo corre en el runtime Node.
 */
export async function cleanupOrphanRuns(): Promise<void> {
  try {
    const db = getDb();
    const updated = await db
      .update(schema.agentTestRun)
      .set({
        status: "failed",
        error: "Interrumpida por un reinicio del servidor",
        finishedAt: new Date(),
      })
      .where(eq(schema.agentTestRun.status, "running"))
      .returning({ id: schema.agentTestRun.id });
    if (updated.length > 0) {
      console.log(
        `[boot] ${updated.length} corrida(s) del Laboratorio huérfana(s) marcada(s) como fallida(s)`
      );
    }
  } catch (err) {
    // La BD puede no estar lista aún (migraciones corren antes del server).
    console.error("[boot] limpieza de corridas huérfanas falló:", err);
  }
}

/**
 * 030 — Cifra los secretos de firma de Zernio que una versión anterior guardó
 * en claro. Va aquí y no en `migrate.mjs` porque cifrar necesita la
 * `ENCRYPTION_KEY` validada y el mismo `encryptSecret` que el token, y porque
 * así corre también con `next dev` (spec 030, D3). Nunca tumba el arranque:
 * mientras una fila no esté cifrada, su secreto se sigue leyendo (D5).
 */
export async function encryptLegacySecrets(): Promise<void> {
  try {
    const cifrados = await cifrarSecretosEnClaro();
    if (cifrados > 0) {
      console.log(`[boot] ${cifrados} secreto(s) de firma de Zernio cifrado(s) en reposo`);
    }
  } catch (err) {
    console.error(
      "[boot] no se pudieron cifrar los secretos de firma de Zernio guardados en claro; se reintenta en el próximo arranque:",
      err instanceof Error ? err.message : "error desconocido"
    );
  }
}

/**
 * 021 — Reanuda el despacho al arrancar. Sin esto, un turno que quedó
 * pendiente o a medio reintentar cuando el contenedor se reinició esperaría a
 * que llegara OTRO mensaje para que alguien encendiera el worker.
 *
 * Solo con el despacho activo: una instancia sin cerebro no barre nada. Y lo
 * mal configurado se dice aquí una vez, además de en la tarjeta «Quién
 * responde»: es el log que alguien mira cuando el agente no contesta.
 */
export function resumeDispatch(): void {
  const config = leerConfigDespacho();
  if (config.active) {
    iniciarWorker();
    void tanda();
    console.log(`[boot] despacho al cerebro activo → ${config.host}`);
    return;
  }
  if (config.problem === "url") {
    console.error(
      "[boot] BRAIN_DISPATCH_URL no es una URL http:// o https:// válida (sin usuario:clave): el despacho al cerebro queda INACTIVO."
    );
  } else if (config.problem === "sin_llave") {
    console.error(
      "[boot] BRAIN_DISPATCH_URL está definida pero falta BOT_API_KEY (mínimo 16 caracteres): el despacho al cerebro queda INACTIVO."
    );
  }
}

/**
 * 031 — Arranca el sondeo del canal de correo si la instancia lo tiene
 * encendido. Sin buzones conectados el barrido no encuentra filas y no
 * cuesta nada; con el canal apagado ni siquiera se crea el temporizador.
 */
export function resumeEmailPoller(): void {
  if (!isChannelEnabled("email")) return;
  iniciarPollerCorreo();
  console.log("[boot] canal de correo activo: sondeo IMAP cada 60 s");
}

/**
 * 048 — Reanuda las campañas de WhatsApp al arrancar. Sin esto, una campaña
 * que quedó en `enviando` cuando el contenedor se reinició esperaría a que
 * alguien la tocara para seguir enviando; y una `programada` con la fecha
 * vencida no se promovería sola.
 *
 * Arranca siempre: el barrido es una consulta barata cada 10 s y solo hace
 * algo cuando hay campañas en `enviando` o programadas vencidas. Nunca tumba
 * el arranque (el worker aísla sus fallos por campaña y por tanda).
 */
export function resumeCampaigns(): void {
  iniciarWorkerCampanas();
  void tandaCampanas().catch((err) =>
    console.error("[boot] primera tanda de campañas falló:", err)
  );
  console.log("[boot] worker de campañas de WhatsApp activo (barrido cada 10 s)");
}

/**
 * 047 — Reanuda los recordatorios automáticos al arrancar. Sin esto, un
 * recordatorio programado antes de un reinicio esperaría a la próxima tanda
 * sin que nadie la encendiera.
 *
 * Solo con la agenda encendida: sin citas no hay recordatorios.
 */
export function resumeReminders(): void {
  if (!agendaEnabled()) return;
  iniciarWorkerRecordatorios();
  void tandaRecordatorios();
  console.log("[boot] recordatorios automáticos activos: tanda cada 60 s");
}
