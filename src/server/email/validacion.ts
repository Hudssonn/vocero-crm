import { z } from "zod";
import { apiError } from "@/lib/api";
import { getEmailCredentialsByOrg } from "@/server/email/credentials";
import type { DatosBuzon } from "@/server/email/probar";

/**
 * 031 — La forma del formulario del buzón y la contraseña efectiva.
 *
 * Vive en `server/` y no en la ruta: un `route.ts` solo exporta handlers.
 * La contraseña del formulario puede venir vacía («conservar la guardada»);
 * lo que se prueba y se guarda es siempre la efectiva.
 */

export const emailBodySchema = z.object({
  emailAddress: z.string().trim().email("Escribe el correo completo del buzón").max(200),
  displayName: z.string().trim().max(120).nullish(),
  imapHost: z.string().trim().min(1, "Falta el servidor de entrada (IMAP)").max(200),
  imapPort: z.number().int().min(1).max(65535),
  imapSecure: z.boolean(),
  smtpHost: z.string().trim().min(1, "Falta el servidor de salida (SMTP)").max(200),
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecure: z.boolean(),
  username: z.string().trim().min(1, "Falta el usuario del buzón").max(200),
  /** Vacía = conservar la guardada (solo si ya hay conexión). */
  password: z
    .string()
    .trim()
    .max(500)
    .optional(),
});

export type EmailBody = z.infer<typeof emailBodySchema>;

export async function datosEfectivos(
  organizationId: string,
  data: EmailBody
): Promise<
  | { ok: true; datos: DatosBuzon; esNueva: boolean }
  | { ok: false; response: Response }
> {
  const previa = await getEmailCredentialsByOrg(organizationId);
  const escrita = (data.password ?? "").trim();
  const password = escrita !== "" ? escrita : previa?.password;
  if (!password) {
    return {
      ok: false,
      response: apiError(422, "validation_error", "Escribe la contraseña del buzón"),
    };
  }
  return {
    ok: true,
    datos: {
      imapHost: data.imapHost,
      imapPort: data.imapPort,
      imapSecure: data.imapSecure,
      smtpHost: data.smtpHost,
      smtpPort: data.smtpPort,
      smtpSecure: data.smtpSecure,
      username: data.username,
      password,
    },
    esNueva: Boolean(data.password),
  };
}
