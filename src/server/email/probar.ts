import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

/**
 * 031 — Probar un buzón sin guardar nada.
 *
 * La regla de los demás canales aplicada al correo: una credencial que no
 * sirve no llega a la base. Se entra por IMAP (login + abrir el INBOX en
 * solo lectura) y se verifica el SMTP; el primer fallo manda, dicho en
 * palabras del operador y no en códigos del servidor.
 */

export type DatosBuzon = {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  password: string;
};

function detalle(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "error desconocido";
}

function esDeAutenticacion(err: unknown): boolean {
  const e = err as { authenticationFailed?: boolean; code?: string };
  if (e?.authenticationFailed) return true;
  const msg = detalle(err).toLowerCase();
  return (
    msg.includes("invalid credentials") ||
    msg.includes("authentication failed") ||
    msg.includes("auth failed") ||
    e?.code === "EAUTH"
  );
}

export async function probarBuzon(
  datos: DatosBuzon
): Promise<{ mensajesEnBuzon: number }> {
  const client = new ImapFlow({
    host: datos.imapHost,
    port: datos.imapPort,
    secure: datos.imapSecure,
    auth: { user: datos.username, pass: datos.password },
    logger: false,
    socketTimeout: 30_000,
    greetingTimeout: 10_000,
  });
  client.on("error", () => {});

  let mensajes = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const mailbox = client.mailbox;
      mensajes = mailbox ? mailbox.exists : 0;
    } finally {
      lock.release();
    }
    await client.logout().catch(() => {});
  } catch (err) {
    await client.logout().catch(() => {});
    if (esDeAutenticacion(err)) {
      throw new Error(
        "El servidor de entrada (IMAP) rechazó el usuario o la contraseña. " +
          "Si el buzón es de Gmail, la contraseña normal no sirve: hay que crear una contraseña de aplicación."
      );
    }
    throw new Error(`No se pudo entrar por IMAP: ${detalle(err)}`);
  }

  const transport = nodemailer.createTransport({
    host: datos.smtpHost,
    port: datos.smtpPort,
    secure: datos.smtpSecure,
    auth: { user: datos.username, pass: datos.password },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  try {
    await transport.verify();
  } catch (err) {
    if (esDeAutenticacion(err)) {
      throw new Error(
        "El servidor de salida (SMTP) rechazó el usuario o la contraseña. " +
          "Si el buzón es de Gmail, hay que usar una contraseña de aplicación."
      );
    }
    throw new Error(`No se pudo verificar el SMTP: ${detalle(err)}`);
  } finally {
    transport.close();
  }

  return { mensajesEnBuzon: mensajes };
}
