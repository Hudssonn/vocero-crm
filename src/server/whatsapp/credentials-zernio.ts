import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { columnasDelSecreto, secretoDeLaFila } from "@/server/zernio/secreto-guardado";

/**
 * 032 — Credenciales de WhatsApp por Zernio.
 *
 * Una sola fuente: la API unificada de Zernio (su llave, y el enrutado por
 * `accountRef`). Mismo contrato que las de los demás canales: la llave viaja
 * descifrada solo en memoria y nunca sale en una respuesta de la API — hacia
 * fuera se expone su cola. El transporte de Meta directo vive en su propia
 * tabla (`whatsapp/credentials`); esta tabla solo existe cuando el negocio
 * conecta su número por Zernio.
 */

export type WhatsappZernioCredentials = {
  id: string;
  organizationId: string;
  source: "zernio";
  /** `accountId` de la cuenta de WhatsApp en Zernio. */
  accountRef: string;
  displayName: string | null;
  webhookSecret: string | null;
  status: "connected" | "reconnect_required";
  token: string;
};

type Row = typeof schema.whatsappZernioCredentials.$inferSelect;

function toCredentials(row: Row): WhatsappZernioCredentials {
  return {
    id: row.id,
    organizationId: row.organizationId,
    source: row.source,
    accountRef: row.accountRef,
    displayName: row.displayName,
    webhookSecret: secretoDeLaFila(row),
    status: row.status,
    token: decryptSecret({
      cipher: row.tokenCipher,
      iv: row.tokenIv,
      tag: row.tokenTag,
    }),
  };
}

export async function getWhatsappZernioCredentialsByOrg(
  organizationId: string
): Promise<WhatsappZernioCredentials | null> {
  const rows = await getDb()
    .select()
    .from(schema.whatsappZernioCredentials)
    .where(eq(schema.whatsappZernioCredentials.organizationId, organizationId))
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

/** Enrutado del webhook de Zernio: el evento trae `account.id`. */
export async function getWhatsappZernioCredentialsByAccountRef(
  accountRef: string
): Promise<WhatsappZernioCredentials | null> {
  const rows = await getDb()
    .select()
    .from(schema.whatsappZernioCredentials)
    .where(eq(schema.whatsappZernioCredentials.accountRef, accountRef))
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

export async function saveWhatsappZernioCredentials(input: {
  organizationId: string;
  accountRef: string;
  displayName: string | null;
  token: string;
  webhookSecret: string | null;
}): Promise<void> {
  const db = getDb();
  const enc = encryptSecret(input.token);
  const existing = await getWhatsappZernioCredentialsByOrg(input.organizationId);

  const values = {
    organizationId: input.organizationId,
    accountRef: input.accountRef,
    displayName: input.displayName,
    tokenCipher: enc.cipher,
    tokenIv: enc.iv,
    tokenTag: enc.tag,
    ...columnasDelSecreto(input.webhookSecret),
    status: "connected" as const,
    updatedAt: new Date(),
  };

  if (existing) {
    await db
      .update(schema.whatsappZernioCredentials)
      .set(values)
      .where(eq(schema.whatsappZernioCredentials.id, existing.id));
    return;
  }
  await db
    .insert(schema.whatsappZernioCredentials)
    .values({ id: newId("credentials"), ...values });
}

/** La llave murió: se pausan los envíos y la UI pide reconectar. */
export async function markWhatsappZernioReconnectRequired(
  organizationId: string
): Promise<void> {
  await getDb()
    .update(schema.whatsappZernioCredentials)
    .set({ status: "reconnect_required", updatedAt: new Date() })
    .where(eq(schema.whatsappZernioCredentials.organizationId, organizationId));
}

export function tokenLast4(token: string): string {
  return token.slice(-4);
}
