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
import { getBranding } from "@/server/branding";
import { colonesACentavos, fijarMontoLead } from "@/server/leads/amount";
import type { AgentActionType } from "@/server/ai/actions";

/**
 * Ciclo de imports ESM: los tres módulos nuevos (`branding`, `leads/amount`,
 * `ai/actions`) son hojas — ninguno importa de vuelta a este módulo (solo
 * drizzle/lib y zod) — así que no cambian la nota de arquitectura del
 * encabezado.
 */

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
 * 044 — Línea «Total:» anclada a inicio y fin de línea (bandera `m`),
 * tolerando mayúsculas/minúsculas, espacios y el símbolo ₡ opcional
 * («Total: ₡4.300», «Total: 9500»). El número capturado trae los
 * separadores ticos (miles con punto, decimales con coma).
 */
const LINEA_TOTAL = /^[ \t]*total[ \t]*:[ \t]*₡?[ \t]*([0-9][0-9.,]*)[ \t]*$/gim;

/**
 * Normalización tica del número capturado de la línea «Total:»:
 * - con punto Y coma → el punto es miles y la coma decimal
 *   («4.300,50» → 4300.50);
 * - solo coma → decimal («4,50» → 4.50);
 * - solo punto → miles («4.300» → 4300);
 * - sin separadores → entero («9500» → 9500).
 *
 * Devuelve el valor en colones, o `null` si no parsea.
 */
function normalizarNumeroTico(captura: string): number | null {
  const tienePunto = captura.includes(".");
  const tieneComa = captura.includes(",");
  let normalizado: string;
  if (tienePunto && tieneComa) {
    normalizado = captura.replace(/\./g, "").replace(",", ".");
  } else if (tieneComa) {
    normalizado = captura.replace(",", ".");
  } else if (tienePunto) {
    normalizado = captura.replace(/\./g, "");
  } else {
    normalizado = captura;
  }
  const valor = Number(normalizado);
  return Number.isFinite(valor) ? valor : null;
}

/**
 * 044 — Monto del pedido sacado de la confirmación en forma
 * determinística. Pura.
 *
 * El modelo a veces no manda `amount` en `update_lead`, pero el texto de
 * la confirmación siempre trae «Total: ₡X» como última línea (041): si el
 * texto no trae el marcador, no hay línea «Total:» o el número no parsea
 * (basura), devuelve `null`. Nunca se inventa un monto.
 *
 * Si hubiera varias líneas «Total:» (reintentos en el mismo turno), gana
 * la última, igual que la 041 manda la confirmación más reciente.
 */
export function extraerTotalDeConfirmacion(texto: string): number | null {
  if (!hasOrderConfirmedMarker(texto)) return null;
  const lineas = [...texto.matchAll(LINEA_TOTAL)];
  const ultima = lineas[lineas.length - 1]?.[1];
  if (!ultima) return null;
  return normalizarNumeroTico(ultima);
}

/**
 * 044 — Registra el pedido confirmado: asegura el lead (043) y fija su
 * monto (042) en forma determinística.
 *
 * Prioridad del monto: `amountExplicito` (lo que el modelo pasó en
 * `update_lead`) si es un número finito ≥ 0; si no,
 * `extraerTotalDeConfirmacion(textoConfirmacion)` (la línea «Total: ₡X»
 * del mensaje). Si no hay monto de ninguna de las dos fuentes, no se
 * escribe monto pero el lead ya quedó asegurado.
 *
 * Nunca lanza: cualquier fallo se registra en consola y se sigue (el
 * webhook jamás debe tumbarse por esto). `fijarMontoLead` tampoco lanza
 * y blinda montos inválidos.
 */
export async function registrarPedidoConfirmado(
  organizationId: string,
  contactId: string,
  textoConfirmacion: string,
  amountExplicito?: number,
): Promise<void> {
  try {
    await asegurarLeadDePedido(organizationId, contactId);

    let montoColones: number | null = null;
    if (
      typeof amountExplicito === "number" &&
      Number.isFinite(amountExplicito) &&
      amountExplicito >= 0
    ) {
      montoColones = amountExplicito;
    } else {
      montoColones = extraerTotalDeConfirmacion(textoConfirmacion);
    }
    if (montoColones === null) return;

    const currency = (await getBranding(organizationId)).currency;
    await fijarMontoLead(
      organizationId,
      contactId,
      colonesACentavos(montoColones),
      currency,
    );
  } catch (error) {
    console.error(
      "[order-pipeline] No se pudo registrar el pedido confirmado; " +
        "se sigue sin lead ni monto",
      error,
    );
  }
}

/**
 * 044 — Texto del mensaje que confirma el pedido, según la acción. Pura.
 *
 * El mensaje con el marcador «PEDIDO CONFIRMADO» viaja en un campo u otro
 * según la acción: `reply`→`text`, `update_lead`/`move_stage`→`reply`,
 * `handoff`→`farewell`; el resto de acciones nunca confirma un pedido.
 * Devuelve el texto tal como viene (para extraerle el monto) o `null`.
 */
export function textoPedidoConfirmado(action: AgentActionType): string | null {
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
      return null;
  }
  return hasOrderConfirmedMarker(candidato) ? candidato : null;
}

/**
 * 043 — ¿La acción del agente trae un pedido confirmado? Pura.
 *
 * Se mantiene el export (y su firma suelta) para no romper sus tests:
 * delega en `textoPedidoConfirmado`. El `as` es seguro: de esta firma
 * solo se leen `action`, `text`, `reply` y `farewell`.
 */
export function accionTraePedidoConfirmado(action: {
  action: string;
  text?: string | null;
  reply?: string | null;
  farewell?: string | null;
}): boolean {
  return textoPedidoConfirmado(action as AgentActionType) !== null;
}
