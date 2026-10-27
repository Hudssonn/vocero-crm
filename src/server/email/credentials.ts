import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

/**
 * 031 — Credenciales del canal de correo.
 *
 * Mismo contrato que las de los demás canales: la contraseña viaja
 * descifrada solo en memoria y nunca sale en una respuesta de la API.
 * Guardar sin contraseña conserva la guardada (patrón de Ajustes → IA):
 * así la pantalla puede reeditar hosts y puertos sin reescribir el secreto.
 */

export type EmailCredentials = {
  id: string;
  organizationId: string;
  emailAddress: string;
  displayName: string | null;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  status: "connected" | "auth_failed" | "error";
  lastError: string | null;
  lastCheckAt: Date | null;
  uidValidity: string | null;
  lastSeenUid: number | null;
  /** Descifrada al leer; solo vive en memoria del servidor. */
  password: string;
};

type Row = typeof schema.emailCredentials.$inferSelect;

function toCredentials(row: Row): EmailCredentials {
  return {
    id: row.id,
    organizationId: row.organizationId,
    emailAddress: row.emailAddress,
    displayName: row.displayName,
    imapHost: row.imapHost,
    imapPort: row.imapPort,
    imapSecure: row.imapSecure,
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
    smtpSecure: row.smtpSecure,
    username: row.username,
    status: row.status,
    lastError: row.lastError,
    lastCheckAt: row.lastCheckAt,
    uidValidity: row.uidValidity,
    lastSeenUid: row.lastSeenUid,
    password: decryptSecret({
      cipher: row.passwordCipher,
      iv: row.passwordIv,
      tag: row.passwordTag,
    }),
  };
}

export async function getEmailCredentialsByOrg(
  organizationId: string
): Promise<EmailCredentials | null> {
  const rows = await getDb()
    .select()
    .from(schema.emailCredentials)
    .where(eq(schema.emailCredentials.organizationId, organizationId))
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

/** Lo que recorre el sondeo: todas las organizaciones con buzón guardado. */
export async function listEmailCredentials(): Promise<EmailCredentials[]> {
  const rows = await getDb().select().from(schema.emailCredentials);
  return rows.map(toCredentials);
}

export type SaveEmailCredentialsInput = {
  organizationId: string;
  emailAddress: string;
  displayName: string | null;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  /** Vacía o ausente = conservar la guardada (solo válido si ya existe). */
  password?: string;
};

export async function saveEmailCredentials(
  input: SaveEmailCredentialsInput
): Promise<void> {
  const db = getDb();
  const existing = await getEmailCredentialsByOrg(input.organizationId);

  const base = {
    organizationId: input.organizationId,
    emailAddress: input.emailAddress,
    displayName: input.displayName,
    imapHost: input.imapHost,
    imapPort: input.imapPort,
    imapSecure: input.imapSecure,
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpSecure: input.smtpSecure,
    username: input.username,
    status: "connected" as const,
    lastError: null,
    updatedAt: new Date(),
  };

  if (input.password) {
    const enc = encryptSecret(input.password);
    const secret = {
      passwordCipher: enc.cipher,
      passwordIv: enc.iv,
      passwordTag: enc.tag,
    };
    if (existing) {
      // Buzón nuevo o clave nueva: el estado del sondeo ya no describe
      // este buzón; se reinicia para releer desde el INBOX actual.
      await db
        .update(schema.emailCredentials)
        .set({ ...base, ...secret, uidValidity: null, lastSeenUid: null })
        .where(eq(schema.emailCredentials.id, existing.id));
      return;
    }
    await db
      .insert(schema.emailCredentials)
      .values({ id: newId("credentials"), ...base, ...secret });
    return;
  }

  if (!existing) {
    throw new Error("Falta la contraseña del buzón");
  }
  await db
    .update(schema.emailCredentials)
    .set(base)
    .where(eq(schema.emailCredentials.id, existing.id));
}

export async function deleteEmailCredentials(
  organizationId: string
): Promise<void> {
  await getDb()
    .delete(schema.emailCredentials)
    .where(eq(schema.emailCredentials.organizationId, organizationId));
}

/** El sondeo anota su avance y su salud tras cada barrido del buzón. */
export async function updateEmailPollState(
  organizationId: string,
  state: {
    uidValidity?: string | null;
    lastSeenUid?: number | null;
    status: "connected" | "auth_failed" | "error";
    lastError: string | null;
  }
): Promise<void> {
  await getDb()
    .update(schema.emailCredentials)
    .set({ ...state, lastCheckAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.emailCredentials.organizationId, organizationId));
}
