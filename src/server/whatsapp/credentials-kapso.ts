import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { newId } from "@/lib/db/ids";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

/**
 * 046 — Credenciales de WhatsApp por Kapso.
 *
 * Espejo del módulo de Zernio (`credentials-zernio.ts`): la llave de proyecto
 * y el secreto del webhook viajan descifrados solo en memoria y nunca salen
 * en una respuesta de la API — hacia fuera se expone la cola de la llave.
 * `phone_number_id` es la llave de enrutado del webhook propio de Kapso.
 */

export type WhatsappKapsoCredentials = {
  id: string;
  organizationId: string;
  source: "kapso";
  /** `phone_number_id` del número en Kapso: por él enruta el webhook. */
  phoneNumberId: string;
  /** WABA a la que pertenece el número, solo para enseñarlo en Ajustes. */
  wabaId: string | null;
  displayName: string | null;
  status: "connected" | "reconnect_required";
  apiKey: string;
  webhookSecret: string;
};

type Row = typeof schema.whatsappKapsoCredentials.$inferSelect;

function toCredentials(row: Row): WhatsappKapsoCredentials {
  return {
    id: row.id,
    organizationId: row.organizationId,
    source: row.source,
    phoneNumberId: row.phoneNumberId,
    wabaId: row.wabaId,
    displayName: row.displayName,
    status: row.status,
    apiKey: decryptSecret({
      cipher: row.apiKeyCipher,
      iv: row.apiKeyIv,
      tag: row.apiKeyTag,
    }),
    webhookSecret: decryptSecret({
      cipher: row.webhookSecretCipher,
      iv: row.webhookSecretIv,
      tag: row.webhookSecretTag,
    }),
  };
}

export async function getWhatsappKapsoCredentialsByOrg(
  organizationId: string
): Promise<WhatsappKapsoCredentials | null> {
  const rows = await getDb()
    .select()
    .from(schema.whatsappKapsoCredentials)
    .where(
      scoped(schema.whatsappKapsoCredentials.organizationId, organizationId)
    )
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

/**
 * Enrutado del webhook de Kapso: el evento trae `phone_number_id` antes de
 * conocer la organización. El índice único sobre `phone_number_id` hace que
 * esta búsqueda global sea segura: un número pertenece a una sola fila.
 */
export async function getWhatsappKapsoCredentialsByPhoneNumberId(
  phoneNumberId: string
): Promise<WhatsappKapsoCredentials | null> {
  const rows = await getDb()
    .select()
    .from(schema.whatsappKapsoCredentials)
    .where(eq(schema.whatsappKapsoCredentials.phoneNumberId, phoneNumberId))
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

export async function saveWhatsappKapsoCredentials(input: {
  organizationId: string;
  phoneNumberId: string;
  wabaId: string | null;
  displayName: string | null;
  apiKey: string;
  webhookSecret: string;
}): Promise<void> {
  const db = getDb();
  const llave = encryptSecret(input.apiKey);
  const secreto = encryptSecret(input.webhookSecret);
  const existing = await getWhatsappKapsoCredentialsByOrg(input.organizationId);

  const values = {
    organizationId: input.organizationId,
    phoneNumberId: input.phoneNumberId,
    wabaId: input.wabaId,
    displayName: input.displayName,
    apiKeyCipher: llave.cipher,
    apiKeyIv: llave.iv,
    apiKeyTag: llave.tag,
    webhookSecretCipher: secreto.cipher,
    webhookSecretIv: secreto.iv,
    webhookSecretTag: secreto.tag,
    status: "connected" as const,
    updatedAt: new Date(),
  };

  if (existing) {
    await db
      .update(schema.whatsappKapsoCredentials)
      .set(values)
      .where(
        scoped(
          schema.whatsappKapsoCredentials.organizationId,
          input.organizationId,
          eq(schema.whatsappKapsoCredentials.id, existing.id)
        )
      );
    return;
  }
  await db
    .insert(schema.whatsappKapsoCredentials)
    .values({ id: newId("credentials"), ...values });
}

/** La llave murió: se pausan los envíos y la UI pide reconectar. */
export async function markWhatsappKapsoReconnectRequired(
  organizationId: string
): Promise<void> {
  await getDb()
    .update(schema.whatsappKapsoCredentials)
    .set({ status: "reconnect_required", updatedAt: new Date() })
    .where(
      scoped(schema.whatsappKapsoCredentials.organizationId, organizationId)
    );
}

export function apiKeyLast4(apiKey: string): string {
  return apiKey.slice(-4);
}
