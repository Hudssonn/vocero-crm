import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import type { EmailCredentials } from "@/server/email/credentials";

/**
 * 031 — Frontera de salida del canal de correo (constitución II: todo
 * request a una plataforma pasa por un único módulo).
 *
 * El correo sale por el SMTP DEL CLIENTE, con su reputación y su dominio:
 * Vocero compone y entrega, no remite. Cada respuesta hila con el correo
 * que contesta (`In-Reply-To`/`References`), lleva la marca `X-Vocero-Sent`
 * para que el sondeo la reconozca como propia si vuelve al INBOX, y su
 * `Message-ID` se genera aquí y se guarda: es la idempotencia del mensaje.
 */

export type EmailSendResult = {
  /** El `Message-ID` generado, sin los ángulos. */
  emailMessageId: string;
  subject: string;
};

export async function sendEmailText(input: {
  credentials: EmailCredentials;
  to: string;
  subject: string;
  inReplyTo: string | null;
  references: string | null;
  text: string;
}): Promise<EmailSendResult> {
  const { credentials } = input;
  const transport = nodemailer.createTransport({
    host: credentials.smtpHost,
    port: credentials.smtpPort,
    secure: credentials.smtpSecure,
    auth: { user: credentials.username, pass: credentials.password },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  try {
    const dominio = credentials.emailAddress.split("@")[1] ?? "vocero";
    const messageId = `${randomUUID()}@${dominio}`;
    const info = await transport.sendMail({
      from: credentials.displayName
        ? { name: credentials.displayName, address: credentials.emailAddress }
        : credentials.emailAddress,
      to: input.to,
      subject: input.subject,
      text: input.text,
      messageId: `<${messageId}>`,
      inReplyTo: input.inReplyTo ?? undefined,
      references: input.references ?? undefined,
      headers: {
        // La marca del sondeo: si este correo vuelve al INBOX (copia en
        // enviados, reglas del servidor), no es un cliente escribiendo.
        "X-Vocero-Sent": "1",
        "Auto-Submitted": "no",
      },
    });
    return {
      emailMessageId: info.messageId
        ? info.messageId.replace(/^<|>$/g, "")
        : messageId,
      subject: input.subject,
    };
  } finally {
    transport.close();
  }
}

/** ¿El fallo del SMTP fue de credenciales? (para decir «reconectar»). */
export function esFalloDeAutenticacionSmtp(err: unknown): boolean {
  const e = err as { code?: string; responseCode?: number };
  if (e?.code === "EAUTH") return true;
  if (e?.responseCode === 535 || e?.responseCode === 534) return true;
  const msg = err instanceof Error ? err.message.toLowerCase() : "";
  return msg.includes("invalid login") || msg.includes("authentication failed");
}
