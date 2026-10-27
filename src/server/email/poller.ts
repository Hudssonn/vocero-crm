import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { isChannelEnabled } from "@/server/channels/enabled";
import {
  listEmailCredentials,
  updateEmailPollState,
  type EmailCredentials,
} from "@/server/email/credentials";
import { ingestEmailMessage } from "@/server/email/ingest";

/**
 * 031 — El sondeo del canal de correo.
 *
 * IMAP no tiene webhooks: el correo se va a buscar. Un worker dentro del
 * proceso (constitución II: sin colas externas), mismo patrón que el del
 * despacho: barrido periódico, una sola corrida a la vez, estado en
 * `globalThis` para que las copias del módulo en dev compartan temporizador.
 *
 * Reglas del barrido:
 * - El buzón se abre SOLO LECTURA y jamás se toca un flag: la idempotencia
 *   vive en `email_credentials.last_seen_uid` + `email_message_id`, no en el
 *   servidor del cliente.
 * - Primera vez (o `UIDVALIDITY` nuevo): se anota el UID más alto y no se
 *   importa el historial. El buzón de un negocio trae años de correo; la
 *   bandeja empieza en la conexión, como en los demás canales.
 * - Lo propio y lo automático no entra (guardas anti-bucle abajo): un
 *   «fuera de oficina» contestándose con el agente es el fallo clásico.
 */

const INTERVALO_MS = 60_000;
/** Correos por buzón y barrido: el resto espera al siguiente minuto. */
const LOTE_MAX = 50;
/** Un cuerpo gigante no debe inflar la fila: el hilo útil cabe de sobra. */
const TEXTO_MAX = 50_000;

type Estado = { timer: NodeJS.Timeout | null; corriendo: boolean };

const globalForPoller = globalThis as unknown as {
  __voceroEmailPoller?: Estado;
};

function estado(): Estado {
  if (!globalForPoller.__voceroEmailPoller) {
    globalForPoller.__voceroEmailPoller = { timer: null, corriendo: false };
  }
  return globalForPoller.__voceroEmailPoller;
}

export function iniciarPollerCorreo(): void {
  const e = estado();
  if (e.timer) return;
  e.timer = setInterval(() => void barridoCorreo(), INTERVALO_MS);
  e.timer.unref?.();
  void barridoCorreo();
}

export function detenerPollerCorreo(): void {
  const e = estado();
  if (e.timer) clearInterval(e.timer);
  e.timer = null;
}

/** Una pasada por todos los buzones conectados. */
export async function barridoCorreo(): Promise<void> {
  if (!isChannelEnabled("email")) return;
  const e = estado();
  if (e.corriendo) return;
  e.corriendo = true;
  try {
    for (const cred of await listEmailCredentials()) {
      try {
        await sondearBuzon(cred);
      } catch (err) {
        const auth = (err as { authenticationFailed?: boolean })
          ?.authenticationFailed;
        await updateEmailPollState(cred.organizationId, {
          status: auth ? "auth_failed" : "error",
          lastError:
            err instanceof Error ? err.message.slice(0, 500) : "error de IMAP",
        }).catch(() => {});
        console.error(
          `[correo] sondeo de ${cred.emailAddress} falló:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  } catch (err) {
    console.error("[correo] el barrido falló:", err);
  } finally {
    e.corriendo = false;
  }
}

async function sondearBuzon(cred: EmailCredentials): Promise<void> {
  const client = new ImapFlow({
    host: cred.imapHost,
    port: cred.imapPort,
    secure: cred.imapSecure,
    auth: { user: cred.username, pass: cred.password },
    logger: false,
    socketTimeout: 60_000,
    greetingTimeout: 15_000,
  });
  // Sin esto, un error de socket fuera de una operación revienta el proceso.
  client.on("error", () => {});

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const mailbox = client.mailbox;
      if (!mailbox) return;
      const uidValidity = String(mailbox.uidValidity);

      let lastSeenUid = cred.lastSeenUid;
      if (cred.uidValidity !== uidValidity) lastSeenUid = null;

      if (lastSeenUid === null) {
        await updateEmailPollState(cred.organizationId, {
          uidValidity,
          lastSeenUid: Math.max(0, (mailbox.uidNext ?? 1) - 1),
          status: "connected",
          lastError: null,
        });
        return;
      }

      let maxUid = lastSeenUid;
      let procesados = 0;
      const nuevos = client.fetch(
        { uid: `${lastSeenUid + 1}:*` },
        { uid: true, source: true }
      );
      for await (const msg of nuevos) {
        if (msg.uid <= lastSeenUid) continue; // el `:*` puede devolver el último
        if (procesados >= LOTE_MAX) break;
        procesados++;
        if (msg.uid > maxUid) maxUid = msg.uid;
        if (!msg.source) continue;
        try {
          const parsed = await simpleParser(msg.source);
          if (esIgnorable(parsed, cred.emailAddress)) continue;
          const correo = aEmailEntrante(parsed, msg.uid, uidValidity);
          if (correo) {
            await ingestEmailMessage(cred.organizationId, correo);
          }
        } catch (err) {
          // Un correo roto no frena el buzón: se anota y se sigue.
          console.error(
            `[correo] mensaje uid=${msg.uid} de ${cred.emailAddress} no se pudo procesar:`,
            err instanceof Error ? err.message : err
          );
        }
      }

      await updateEmailPollState(cred.organizationId, {
        uidValidity,
        lastSeenUid: maxUid,
        status: "connected",
        lastError: null,
      });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Las guardas anti-bucle. Un correo ignorado igual avanza el UID: se leyó,
 * simplemente no merece conversación.
 */
export function esIgnorable(
  parsed: ParsedMail,
  buzon: string
): boolean {
  const from = parsed.from?.value?.[0]?.address?.toLowerCase() ?? "";
  // Lo que sale de este buzón (copias en el INBOX, autoenvíos) no es un cliente.
  if (from && from === buzon.toLowerCase()) return true;
  // Rebotes y avisos del servidor de correo, no personas.
  const local = from.split("@")[0] ?? "";
  if (local === "mailer-daemon" || local === "postmaster") return true;

  const headers = new Map(
    parsed.headerLines.map((h) => [h.key.toLowerCase(), h.line])
  );
  // Lo que Vocero mismo mandó lleva su marca (fase 2).
  if (headers.has("x-vocero-sent")) return true;
  // Respuestas automáticas ajenas: fuera de oficina, vacaciones, etc.
  const autoSubmitted = headers.get("auto-submitted") ?? "";
  if (autoSubmitted && !/:\s*no\b/i.test(autoSubmitted)) return true;
  if (headers.has("x-auto-response-suppress")) return true;
  return false;
}

function aEmailEntrante(
  parsed: ParsedMail,
  uid: number,
  uidValidity: string
) {
  const from = parsed.from?.value?.[0];
  const fromAddress = from?.address?.toLowerCase().trim() ?? "";
  if (!fromAddress) return null;
  const texto = (parsed.text?.trim() || htmlATexto(parsed.html) || "").slice(
    0,
    TEXTO_MAX
  );
  return {
    fromAddress,
    fromName: from?.name?.trim() || null,
    subject: parsed.subject?.trim() || null,
    text: texto || null,
    date: parsed.date ?? new Date(),
    // Sin Message-ID (raro pero existe): el UID del buzón hace de llave.
    messageId: parsed.messageId ?? `imap:${uidValidity}:${uid}`,
    inReplyTo: parsed.inReplyTo ?? null,
  };
}

/** Des-etiquetado simple del HTML cuando el correo no trae parte de texto. */
export function htmlATexto(html: string | false | undefined): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
