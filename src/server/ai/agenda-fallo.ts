import type { ChatJsonResult, ChatMessage } from "@/lib/ai";
import type { AgendaTurn } from "@/server/agenda/agent";
import type { AgentActionType } from "@/server/ai/actions";

/**
 * BUG 4 — El turno de agenda no dejaba que el modelo se corrigiera: el texto
 * del motor se entregaba directo al usuario con `deliverReply` y el turno
 * terminaba sin que el modelo viera el resultado.
 *
 * Cuando el motor no puede completar la acción (devuelve `ok: false` o lanza),
 * el modelo lo ve en un segundo pase y reacciona: responde con sus palabras,
 * pide otra acción de agenda con datos distintos, o deriva a un humano.
 *
 * Cotas duras por turno: como máximo 2 pases al modelo y 2 llamadas al motor.
 * Si el segundo pase tampoco puede, se entrega el texto del motor: el
 * comportamiento anterior al fix, nunca peor.
 *
 * Todo lo testeable vive aquí, sin BD ni red: el pipeline inyecta
 * `preguntarModelo` (el `chatJson` real) y `ejecutarMotor` (el despacho real
 * al motor). Los imports de arriba son solo tipos.
 */

/** Las 4 acciones que van al motor de agenda. */
export type AccionAgenda = Extract<
  AgentActionType,
  {
    action: "offer_slots" | "book_slot" | "cancel_slot" | "reschedule_slot";
  }
>;

/** Guarda de tipo para las acciones de agenda. */
export function esAccionAgenda(
  action: AgentActionType
): action is AccionAgenda {
  return (
    action.action === "offer_slots" ||
    action.action === "book_slot" ||
    action.action === "cancel_slot" ||
    action.action === "reschedule_slot"
  );
}

/**
 * Texto honesto cuando el motor LANZÓ una excepción y no hay texto suyo que
 * entregar: degradar a ciegas entregaría el `reply` del modelo —una
 * confirmación («¡Listo! Te agendé…») que nunca ocurrió.
 */
export const TEXTO_FALLO_AGENDA =
  "No pude completar eso de la agenda en este momento. Lo reviso con el equipo y te confirmo.";

/**
 * Pura: la nota que ve el modelo en el segundo pase. Lleva qué intentó, qué
 * respondió el motor y qué puede hacer —sin repetir lo que ya falló.
 */
export function notaFalloAgenda(
  accion: AccionAgenda,
  turno: AgendaTurn
): ChatMessage {
  return {
    role: "system",
    content: [
      `Intentaste una acción de agenda ("${accion.action}") y el motor no pudo completarla.`,
      `Tu intento fue: ${JSON.stringify(accion)}`,
      `Esto fue lo que pasó: ${turno.text}`,
      "Reaccioná teniendo esto en cuenta: podés responderle al cliente con tus palabras (reply), intentar otra acción de agenda con datos distintos (por ejemplo ofrecer otros horarios de los que ya conocés), o derivar a un humano (handoff) si no hay salida.",
      "No repitas la misma acción con los mismos datos: ya falló.",
      "Respondé únicamente con el JSON de la acción.",
    ].join("\n"),
  };
}

export type PreguntarModelo = (
  messages: ChatMessage[]
) => Promise<ChatJsonResult<AgentActionType>>;

export type EjecutarMotorAgenda = (
  accion: AccionAgenda
) => Promise<AgendaTurn>;

export type FalloAgendaResuelto =
  /** No es de agenda: el pipeline la sigue por el camino normal del turno. */
  | { decision: "accion-nueva"; action: AgentActionType }
  /** Último recurso: entregar el texto del motor (hoy). */
  | { decision: "texto-motor"; turno: AgendaTurn };

/**
 * Resuelve UN fallo del motor de agenda con un segundo pase al modelo.
 *
 * - El modelo responde `reply`/`update_lead`/`move_stage`/`handoff`/`none` →
 *   `accion-nueva`: el pipeline la ejecuta por el camino normal.
 * - El modelo pide otra acción de agenda → se ejecuta UNA vez más con el
 *   motor y se entrega lo que salga (`texto-motor`), sin más pases.
 * - El segundo pase falla, o el reintento del motor lanza → `texto-motor`
 *   con el turno original: el comportamiento anterior al fix.
 */
export async function resolverFalloAgenda(input: {
  accion: AccionAgenda;
  turno: AgendaTurn;
  messages: ChatMessage[];
  preguntarModelo: PreguntarModelo;
  ejecutarMotor: EjecutarMotorAgenda;
}): Promise<FalloAgendaResuelto> {
  const segundo = await input.preguntarModelo([
    ...input.messages,
    notaFalloAgenda(input.accion, input.turno),
  ]);
  if (!segundo.ok) {
    console.error(
      `[agente] segundo pase tras fallo de agenda falló: ${segundo.detail}`
    );
    return { decision: "texto-motor", turno: input.turno };
  }
  const nueva = segundo.data;
  if (!esAccionAgenda(nueva)) {
    return { decision: "accion-nueva", action: nueva };
  }
  try {
    const reintento = await input.ejecutarMotor(nueva);
    return { decision: "texto-motor", turno: reintento };
  } catch (err) {
    console.error(`[agente] reintento del motor de agenda falló: ${err}`);
    return { decision: "texto-motor", turno: input.turno };
  }
}
