/**
 * 043 — Pedidos al pipeline SOLO cuando se confirman.
 *
 * NOTA DE ARQUITECTURA (ciclo de imports ESM): este módulo importa
 * `createLeadForContact` de `inbox/lead-activity.ts`, y ese módulo importa
 * `esPipelineDePedidos` de aquí. El ciclo es seguro porque en ambos
 * módulos los símbolos importados se usan SOLO dentro de cuerpos de
 * función, nunca durante la evaluación del módulo: para cuando alguna
 * función corre, los dos módulos ya terminaron de cargarse. Tampoco hay
 * regla `import/no-cycle` en el eslint que lo prohíba.
 */
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { hasOrderConfirmedMarker } from "@/server/orders/order-text";
import { createLeadForContact } from "@/server/inbox/lead-activity";

/** Nombre de la etapa que distingue un pipeline de pedidos. */
const ETAPA_NUEVO_PEDIDO = "Nuevo pedido";

/**
 * ¿Esta organización usa un pipeline de pedidos? Se detecta por la
 * existencia de la etapa «Nuevo pedido». Un pipeline de ventas (la Tienda
 * no tiene esa etapa) queda intacto.
 *
 * Nunca lanza: ante cualquier error se registra en consola y se devuelve
 * `false` (fail-open al comportamiento anterior: el lead se crea con
 * cualquier actividad, como siempre).
 */
export async function esPipelineDePedidos(
  organizationId: string,
): Promise<boolean> {
  try {
    const db = getDb();
    const filas = await db
      .select({ id: schema.pipelineStage.id })
      .from(schema.pipelineStage)
      .where(
        scoped(
          schema.pipelineStage.organizationId,
          organizationId,
          eq(schema.pipelineStage.name, ETAPA_NUEVO_PEDIDO),
        ),
      )
      .limit(1);
    return filas.length > 0;
  } catch (error) {
    console.error(
      "[order-pipeline] No se pudo detectar si el pipeline es de pedidos; " +
        "se mantiene el comportamiento anterior (lead con cualquier actividad)",
      error,
    );
    return false;
  }
}

/**
 * Crea el lead de un pedido CONFIRMADO en la etapa «Nuevo pedido».
 *
 * Se llama cuando el agente cierra el pedido (su mensaje trae el marcador
 * «PEDIDO CONFIRMADO»), no con cualquier actividad: en la soda hasta el
 * que solo decía «Hola» caía al pipeline.
 *
 * Nunca lanza: cualquier fallo se registra en consola y se sigue (el
 * webhook jamás debe tumbarse por esto). Idempotente gracias al
 * `onConflictDoNothing` sobre `lead_contact_uq` de `createLeadForContact`:
 * llamarla dos veces deja un solo lead.
 */
export async function asegurarLeadDePedido(
  organizationId: string,
  contactId: string,
): Promise<void> {
  try {
    const db = getDb();

    // (a) Guarda: el Laboratorio usa contactos archivados y esos nunca
    // entran al pipeline real.
    const contactos = await db
      .select({ archivedAt: schema.contact.archivedAt })
      .from(schema.contact)
      .where(
        scoped(
          schema.contact.organizationId,
          organizationId,
          eq(schema.contact.id, contactId),
        ),
      )
      .limit(1);
    const contacto = contactos[0];
    if (!contacto || contacto.archivedAt !== null) return;

    // (b) Etapa «Nuevo pedido» de esta organización.
    const etapas = await db
      .select({ id: schema.pipelineStage.id })
      .from(schema.pipelineStage)
      .where(
        scoped(
          schema.pipelineStage.organizationId,
          organizationId,
          eq(schema.pipelineStage.name, ETAPA_NUEVO_PEDIDO),
        ),
      )
      .limit(1);

    // (c) La única puerta de creación: jamás se escribe `lead.stage_id`
    // directo (lo exige el guardarraíl que escanea `src/`). Sin etapa
    // «Nuevo pedido» se omite `stageId` y cae a la primera etapa abierta,
    // igual que el webhook.
    await createLeadForContact(
      etapas[0]
        ? { organizationId, contactId, stageId: etapas[0].id }
        : { organizationId, contactId },
    );
  } catch (error) {
    console.error(
      "[order-pipeline] No se pudo asegurar el lead del pedido confirmado; " +
        "se sigue sin lead",
      error,
    );
  }
}

/**
 * 043 — ¿La acción del agente trae un pedido confirmado? Pura.
 *
 * El pedido se confirma con un mensaje que empieza por el marcador
 * «PEDIDO CONFIRMADO» (`hasOrderConfirmedMarker`); según la acción, ese
 * mensaje viaja en un campo u otro. Las acciones que no llevan texto del
 * agente nunca confirman un pedido.
 */
export function accionTraePedidoConfirmado(action: {
  action: string;
  text?: string | null;
  reply?: string | null;
  farewell?: string | null;
}): boolean {
  let candidato: string | null;
  switch (action.action) {
    case "reply":
      candidato = action.text ?? null;
      break;
    case "update_lead":
    case "move_stage":
      candidato = action.reply ?? null;
      break;
    case "handoff":
      candidato = action.farewell ?? null;
      break;
    default:
      return false;
  }
  return hasOrderConfirmedMarker(candidato);
}
