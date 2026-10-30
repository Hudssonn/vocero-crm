import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";

/**
 * 047 — Configuración de recordatorios automáticos (una fila por organización).
 *
 * El negocio decide si los envía, cuántas horas antes de la cita y con qué
 * mensaje. Los recordatorios ya generados no cambian si la config cambia.
 */

/** Zona horaria de fallback si la org no tiene la agenda configurada. */
export const REMINDER_DEFAULT_TIMEZONE = "America/Costa_Rica";

export const MENSAJE_DEFAULT =
  "Hola {{nombre}}, te recordamos tu cita del {{fecha}} a las {{hora}}. Responde CONFIRMAR para confirmar.";

export type ReminderConfig = {
  id: string;
  organizationId: string;
  enabled: boolean;
  hoursBefore: number;
  message: string;
};

/** Valores que se enseñan cuando la org aún no guardó nada. */
export const DEFAULT_REMINDER_CONFIG: Omit<ReminderConfig, "id" | "organizationId"> = {
  enabled: true,
  hoursBefore: 24,
  message: MENSAJE_DEFAULT,
};

type Fila = typeof schema.reminderConfig.$inferSelect;

function aTipo(fila: Fila): ReminderConfig {
  return {
    id: fila.id,
    organizationId: fila.organizationId,
    enabled: fila.enabled,
    hoursBefore: fila.hoursBefore,
    message: fila.message,
  };
}

/** Esquema Zod de lo que el dueño puede guardar (input externo). */
export const reminderConfigSchema = z.object({
  enabled: z.boolean(),
  hoursBefore: z.number().int().min(1).max(72),
  message: z.string().trim().min(1).max(500),
});

export type ReminderConfigInput = z.infer<typeof reminderConfigSchema>;

/** Lee la config; si no existe, devuelve los defaults sin crear la fila. */
export async function getReminderConfig(
  organizationId: string
): Promise<ReminderConfig & { persisted: boolean }> {
  const rows = await getDb()
    .select()
    .from(schema.reminderConfig)
    .where(scoped(schema.reminderConfig.organizationId, organizationId))
    .limit(1);
  const fila = rows[0];
  if (!fila) {
    return {
      id: "",
      organizationId,
      ...DEFAULT_REMINDER_CONFIG,
      persisted: false,
    };
  }
  return { ...aTipo(fila), persisted: true };
}

/** Guarda (upsert) la config de la organización. Solo la llama el dueño. */
export async function putReminderConfig(
  organizationId: string,
  input: ReminderConfigInput
): Promise<ReminderConfig> {
  const db = getDb();
  const existing = await db
    .select({ id: schema.reminderConfig.id })
    .from(schema.reminderConfig)
    .where(scoped(schema.reminderConfig.organizationId, organizationId))
    .limit(1);

  const values = {
    organizationId,
    enabled: input.enabled,
    hoursBefore: input.hoursBefore,
    message: input.message,
    updatedAt: new Date(),
  };

  if (existing[0]) {
    // `organization_id` es único: el scoped ya identifica la fila.
    const updated = await db
      .update(schema.reminderConfig)
      .set(values)
      .where(scoped(schema.reminderConfig.organizationId, organizationId))
      .returning();
    return aTipo(updated[0]!);
  }
  const inserted = await db
    .insert(schema.reminderConfig)
    .values({ id: newId("reminderConfig"), ...values })
    .returning();
  return aTipo(inserted[0]!);
}
