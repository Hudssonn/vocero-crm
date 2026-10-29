import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";

/**
 * 042 — Monto del lead, sin tocar su etapa.
 *
 * Solo escribe `amountCents`, `currency` y `updatedAt`: la etapa del lead
 * sigue siendo potestad exclusiva de `stage-history.ts` (el guardarraíl
 * `stage-history-guard.test.ts` lo verifica escaneando `src/`).
 */

/** Colones → centavos enteros, con el redondeo de `Math.round`. */
export function colonesACentavos(colones: number): number {
  return Math.round(colones * 100);
}

/**
 * Fija el monto de un lead buscado por contacto. Cada confirmación con
 * monto sobrescribe el anterior: la última confirmación gana, igual que
 * una corrección de pedido.
 *
 * Blindaje (el monto viene de un modelo, no de un humano): montos no
 * finitos o negativos se ignoran en silencio y nunca borran un monto
 * válido previo; si no hay lead, no pasa nada. Y nunca lanza: un fallo
 * aquí no puede tumbar el turno ni la respuesta al cliente, así que
 * cualquier error de base se registra y se descarta.
 */
export async function fijarMontoLead(
  organizationId: string,
  contactId: string,
  amountCents: number,
  currency: string
): Promise<void> {
  if (!Number.isFinite(amountCents) || amountCents < 0) return;
  try {
    const db = getDb();
    const rows = await db
      .select({ id: schema.lead.id })
      .from(schema.lead)
      .where(
        scoped(
          schema.lead.organizationId,
          organizationId,
          eq(schema.lead.contactId, contactId)
        )
      )
      .limit(1);
    if (!rows[0]) return;
    await db
      .update(schema.lead)
      .set({ amountCents, currency, updatedAt: new Date() })
      .where(
        and(
          scoped(schema.lead.organizationId, organizationId),
          eq(schema.lead.id, rows[0].id)
        )
      );
  } catch (err) {
    console.error(`[042] no se pudo fijar el monto del lead: ${err}`);
  }
}

/**
 * Reintento de un pedido del menú (mismo `orderId`): fija el monto solo
 * si el lead todavía no tiene. La condición va en SQL (`IS NULL`), así
 * que un monto que alguien corrigió a mano nunca se pisa, ni siquiera
 * en carrera. Vive aquí y no en el servicio de pedidos para que el
 * guardarraíl de la etapa no confunda esta escritura con un cambio de
 * etapa: este archivo solo escribe monto, nunca etapa.
 */
export async function completarMontoReintento(
  organizationId: string,
  leadId: string,
  amountCents: number,
  currency: string
): Promise<void> {
  if (!Number.isFinite(amountCents) || amountCents < 0) return;
  try {
    const db = getDb();
    await db
      .update(schema.lead)
      .set({ amountCents, currency, updatedAt: new Date() })
      .where(
        and(
          scoped(schema.lead.organizationId, organizationId),
          eq(schema.lead.id, leadId),
          isNull(schema.lead.amountCents)
        )
      );
  } catch (err) {
    console.error(`[042] no se pudo completar el monto del reintento: ${err}`);
  }
}
