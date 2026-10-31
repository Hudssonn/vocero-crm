import { MetaApiError } from "@/lib/meta/client";
import { sendKapsoTemplate } from "@/server/whatsapp/send-kapso";
import {
  getWhatsappKapsoCredentialsByOrg,
  markWhatsappKapsoReconnectRequired,
} from "@/server/whatsapp/credentials-kapso";
import {
  completarCampanaSiNoQuedanPendientes,
  fusionarVariables,
  marcarDestinatarioEnviado,
  marcarDestinatarioFallido,
  pausarCampana,
  promoverProgramadasVencidas,
  tomarCampanasEnviando,
  tomarDestinatariosPendientes,
  type FilaCampana,
  type FilaDestinatario,
} from "@/server/campaigns/service";

/**
 * 048 — Worker de campañas de WhatsApp, en proceso.
 *
 * Mismo patrón que `src/server/dispatch/worker.ts`: sin colas externas, el
 * outbox es la propia tabla (los estados `enviando`/`pendiente` sobreviven al
 * reinicio y `resumeCampaigns()` los retoma al arrancar).
 *
 * Cada pasada: promueve las programadas vencidas, toma hasta
 * `CAMPANAS_POR_TANDA` campañas en `enviando` y envía hasta
 * `DESTINATARIOS_POR_TANDA` destinatarios pendientes por campaña, con
 * `PAUSA_ENTRE_ENVIOS_MS` entre envíos (~5/seg, 048/D5).
 */

// Los límites de ritmo se declaran aquí, no incrustados en el envío (022).
const INTERVALO_MS = 10_000;
const CAMPANAS_POR_TANDA = 5;
const DESTINATARIOS_POR_TANDA = 25;
const PAUSA_ENTRE_ENVIOS_MS = 200;

type Estado = {
  timer: NodeJS.Timeout | null;
  corriendo: boolean;
  cita: NodeJS.Timeout | null;
};

// En globalThis porque en dev los módulos se evalúan más de una vez y todas
// las copias deben compartir el mismo worker (igual que el despachador).
const globalForCampaigns = globalThis as unknown as {
  __voceroCampaignWorker?: Estado;
};

function estado(): Estado {
  if (!globalForCampaigns.__voceroCampaignWorker) {
    globalForCampaigns.__voceroCampaignWorker = {
      timer: null,
      corriendo: false,
      cita: null,
    };
  }
  return globalForCampaigns.__voceroCampaignWorker;
}

export function iniciarWorkerCampanas(): void {
  const e = estado();
  if (e.timer) return;
  e.timer = setInterval(() => void tandaCampanas(), INTERVALO_MS);
  e.timer.unref?.();
}

export function detenerWorkerCampanas(): void {
  const e = estado();
  if (e.timer) clearInterval(e.timer);
  e.timer = null;
  if (e.cita) clearTimeout(e.cita);
  e.cita = null;
}

/**
 * Despierta al worker pronto (tras un `start`), además del barrido.
 * Una sola cita pendiente: si ya hay una, no se apila otra.
 */
export function programarTandaCampanas(): void {
  const e = estado();
  if (e.cita) return;
  e.cita = setTimeout(() => {
    e.cita = null;
    void tandaCampanas();
  }, 1000);
  e.cita.unref?.();
}

function dormir(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Una pasada. Devuelve cuántos destinatarios intentó enviar. */
export async function tandaCampanas(ahora: Date = new Date()): Promise<number> {
  const e = estado();
  if (e.corriendo) return 0;
  e.corriendo = true;
  try {
    // 048/D2 — las programadas con fecha vencida pasan a `enviando`.
    const promovidas = await promoverProgramadasVencidas(ahora);
    if (promovidas > 0) {
      console.log(`[campañas] ${promovidas} programada(s) vencida(s) → enviando`);
    }

    let enviados = 0;
    const campanas = await tomarCampanasEnviando(CAMPANAS_POR_TANDA);
    for (const campana of campanas) {
      try {
        enviados += await procesarCampana(campana);
      } catch (err) {
        // Una campaña rota no tumba la tanda: las demás siguen.
        console.error(`[campañas] ${campana.id} falló en la tanda:`, err);
      }
    }
    return enviados;
  } catch (err) {
    console.error("[campañas] la tanda falló:", err);
    return 0;
  } finally {
    e.corriendo = false;
  }
}

type CredencialesEnvio = {
  phoneNumberId: string;
  apiKey: string;
};

/**
 * Envía una tanda de destinatarios de una campaña. Devuelve cuántos intentó.
 * 048/D8: sin credenciales Kapso (o con la llave muerta) la campaña se pausa,
 * no se queman los destinatarios.
 */
async function procesarCampana(campana: FilaCampana): Promise<number> {
  const creds = await getWhatsappKapsoCredentialsByOrg(campana.organizationId);
  const envio: CredencialesEnvio | null =
    creds && creds.status === "connected"
      ? { phoneNumberId: creds.phoneNumberId, apiKey: creds.apiKey }
      : null;
  if (!envio) {
    await pausarCampana(campana.organizationId, campana.id).catch(() => {});
    console.error(
      `[campañas] ${campana.id} pausada: la organización no tiene Kapso conectado`
    );
    return 0;
  }

  const pendientes = await tomarDestinatariosPendientes(
    campana.id,
    DESTINATARIOS_POR_TANDA
  );
  let i = 0;
  for (const dest of pendientes) {
    const seguir = await enviarDestinatario(campana, envio, dest);
    i++;
    // La llave murió: no tiene sentido seguir quemando esta tanda.
    if (!seguir) break;
    if (i < pendientes.length) await dormir(PAUSA_ENTRE_ENVIOS_MS);
  }

  // Sin pendientes: la campaña queda completada (048/D2).
  const completada = await completarCampanaSiNoQuedanPendientes(campana.id);
  if (completada) {
    console.log(`[campañas] ${campana.id} completada`);
  }
  return i;
}

/**
 * Envía la plantilla a un destinatario. Devuelve `false` cuando hay que
 * dejar de procesar la campaña en esta tanda (llave de Kapso muerta).
 */
async function enviarDestinatario(
  campana: FilaCampana,
  envio: CredencialesEnvio,
  dest: FilaDestinatario
): Promise<boolean> {
  const variables = fusionarVariables(campana.variables, dest.variables);
  try {
    const { platformMessageId } = await sendKapsoTemplate({
      phoneNumberId: envio.phoneNumberId,
      apiKey: envio.apiKey,
      to: dest.phone,
      templateName: campana.templateName,
      languageCode: campana.templateLanguage,
      variables,
    });
    await marcarDestinatarioEnviado(campana.id, dest.id, platformMessageId);
    return true;
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : "error desconocido";
    if (err instanceof MetaApiError && err.isAuthError) {
      // Llave muerta: se marca para reconectar y la campaña se pausa, para
      // que el usuario la reanude cuando reconecte (048/D8).
      await markWhatsappKapsoReconnectRequired(campana.organizationId);
      await pausarCampana(campana.organizationId, campana.id).catch(() => {});
      await marcarDestinatarioFallido(
        campana.id,
        dest.id,
        "La llave de Kapso dejó de servir; reconecte en Ajustes → WhatsApp y reanude la campaña"
      );
      console.error(
        `[campañas] ${campana.id} pausada: la llave de Kapso murió (${mensaje})`
      );
      return false;
    }
    await marcarDestinatarioFallido(campana.id, dest.id, mensaje);
    return true;
  }
}

/** Una pasada. Devuelve cuántos destinatarios intentó enviar. */
