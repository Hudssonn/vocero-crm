import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { moveLeadToStage as moveLeadThroughHistory } from "@/server/leads/stage-history";
import { getEnv } from "@/lib/env";
import { chatJson, type ChatMessage } from "@/lib/ai";
import { isAiConfiguredFor } from "@/lib/ai/provider";
import { publish } from "@/server/events/bus";
import { isWindowOpen } from "@/server/inbox/window";
import { windowMsFor } from "@/server/channels/capabilities";
import { SendError, sendText } from "@/server/inbox/send";
import {
  agentActionSchema,
  degradeAction,
  resolveStage,
  type AgentActionType,
} from "@/server/ai/actions";
import { HANDOFF_BACKUP_ACK, matchesHandoffIntent } from "@/server/ai/handoff";
import {
  buildAgentSystemPrompt,
  TURN_FORMAT_REMINDER,
} from "@/server/ai/prompts";
import {
  atendidoPorPersona,
  debidosVigentes,
  ordenarParaElTurno,
  quedanDebidos,
} from "@/server/ai/orden-turno";
import { agendaEnabled } from "@/server/agenda/flag";
import { getBranding } from "@/server/branding";
import { colonesACentavos, fijarMontoLead } from "@/server/leads/amount";
import { bookSlot, offerSlots } from "@/server/agenda/agent";
import { getOffers, mapaDeHuecosParaModelo } from "@/server/agenda/offers";
import {
  esPipelineDePedidos,
  registrarPedidoConfirmado,
  textoPedidoConfirmado,
} from "@/server/orders/order-pipeline";

/**
 * Turno del agente (FR-021..FR-025).
 *
 * Coalesce + lock in-process por conversación: ráfagas de mensajes → UNA
 * respuesta; nunca dos turnos simultáneos; lo que llega durante un turno
 * re-encola exactamente un turno más. Suficiente para el monolito de una
 * instancia (sin colas externas — Constitución II).
 *
 * 025 — La entrada lleva además qué entrantes DEBE el siguiente turno. Lo que
 * el cliente escribe mientras el modelo piensa queda, por hora, antes de la
 * respuesta que sale de ese turno; sin esa cuenta el turno siguiente lee una
 * conversación que termina en su propia respuesta. Es la misma memoria que el
 * despacho guarda en `dispatch.message_ids`, aquí en proceso, como `pending`.
 */

type CoalesceEntry = {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  pending: boolean;
  /** Entrantes anotados para el siguiente turno. */
  debidos: Set<string>;
};

const globalForAgent = globalThis as unknown as {
  __agentCoalesce?: Map<string, CoalesceEntry>;
};

function coalesceMap(): Map<string, CoalesceEntry> {
  if (!globalForAgent.__agentCoalesce) {
    globalForAgent.__agentCoalesce = new Map();
  }
  return globalForAgent.__agentCoalesce;
}

/**
 * Punto de entrada con debounce (mensajes entrantes reales). `messageId` es
 * el entrante que lo provoca.
 */
export function scheduleAgentTurn(
  conversationId: string,
  messageId: string
): void {
  const map = coalesceMap();
  const entry = map.get(conversationId) ?? {
    timer: null,
    running: false,
    pending: false,
    debidos: new Set<string>(),
  };
  map.set(conversationId, entry);
  entry.debidos.add(messageId);

  if (entry.running) {
    entry.pending = true; // se re-encola al terminar el turno actual
    return;
  }
  if (entry.timer) clearTimeout(entry.timer);
  const delay = getEnv().AGENT_COALESCE_MS;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void executeTurn(conversationId);
  }, delay);
}

async function executeTurn(conversationId: string): Promise<void> {
  const map = coalesceMap();
  const entry = map.get(conversationId);
  if (!entry || entry.running) return;
  entry.running = true;
  // Lo anotado hasta aquí es de ESTE turno. Lo que entre desde ahora cae en
  // un conjunto nuevo: es lo que, al terminar, puede seguir debiéndose.
  const deEsteTurno = [...entry.debidos];
  entry.debidos = new Set();
  let leido: TurnoLeido | undefined;
  try {
    leido = await runAgentTurn(conversationId, { debidos: deEsteTurno });
  } catch (err) {
    console.error("[agente] turno falló:", err);
  } finally {
    entry.running = false;
    // Si el turno no llegó a leer (falló, o se calló antes de abrir el
    // historial), lo que traía se sigue debiendo.
    if (!leido) for (const id of deEsteTurno) entry.debidos.add(id);
    // Y si leyó, lo que entró mientras tanto y alcanzó a ver ya está
    // atendido: repetir el turno sería contestarle dos veces.
    const quedan = quedanDebidos(entry.debidos, leido?.vistos);
    entry.debidos = new Set(quedan);
    const repetir = entry.pending && quedan.length > 0;
    entry.pending = false;
    if (repetir) {
      void executeTurn(conversationId);
    } else {
      map.delete(conversationId);
    }
  }
}

/** Lo que el turno alcanzó a leer. Ausente si no llegó a abrir el historial. */
export type TurnoLeido = { vistos: string[] };

/**
 * Ejecuta UN turno del agente ahora (el Laboratorio lo llama directo, con
 * debounce 0 y sin pasar por el coalesce).
 *
 * 025 — `debidos` son los entrantes que este turno tiene que atender; solo los
 * pasa el coalesce. Devuelve qué entrantes leyó: quien lo llamó lo compara con
 * lo que entró mientras el modelo pensaba, que el turno no pudo ver.
 */
export async function runAgentTurn(
  conversationId: string,
  opciones: { debidos?: readonly string[] } = {}
): Promise<TurnoLeido | undefined> {
  const db = getDb();
  const convRows = await db
    .select()
    .from(schema.conversation)
    .where(eq(schema.conversation.id, conversationId))
    .limit(1);
  const conversation = convRows[0];
  if (!conversation) return;
  const organizationId = conversation.organizationId;

  // ¿Esta organización tiene IA? Lo guardado en Ajustes → IA, o si no, el
  // entorno. Sin proveedor, o con la llave pausada por el proveedor, el
  // mensaje se queda en la bandeja para que lo atienda una persona — y el
  // dueño ve el motivo en el banner y en Ajustes → IA. Va ANTES de cualquier
  // efecto (traspasos por ventana o por frase): sin IA no hay turno.
  if (!(await isAiConfiguredFor(organizationId))) return;

  // Condiciones de silencio: handoff activo o IA apagada en la conversación.
  if (conversation.handoffAt || !conversation.aiEnabled) return;

  const profileRows = await db
    .select()
    .from(schema.agentProfile)
    .where(eq(schema.agentProfile.organizationId, organizationId))
    .limit(1);
  const profile = profileRows[0];
  if (!profile) return;
  // El toggle global aplica a conversaciones reales; el Laboratorio evalúa el
  // comportamiento configurado aunque el agente aún no esté encendido.
  if (!conversation.isTest && !profile.enabled) return;

  const recientes = await db
    .select()
    .from(schema.message)
    .where(eq(schema.message.conversationId, conversationId))
    .orderBy(desc(schema.message.createdAt))
    .limit(20);
  recientes.reverse();
  // Por id y no solo «los últimos 20»: un mensaje debido que ya no quepa en
  // esa ventana seguiría debiéndose después de cada turno.
  const debidos = opciones.debidos?.length
    ? await db
        .select()
        .from(schema.message)
        .where(
          scoped(
            schema.message.organizationId,
            organizationId,
            and(
              eq(schema.message.conversationId, conversationId),
              eq(schema.message.direction, "in"),
              inArray(schema.message.id, [...opciones.debidos])
            )
          )
        )
    : [];
  const vigentes = debidosVigentes(recientes, debidos);
  const history = ordenarParaElTurno(recientes, vigentes);
  const lastInbound = [...history].reverse().find((m) => m.direction === "in");
  if (!lastInbound) return;
  const leido: TurnoLeido = {
    vistos: history.filter((m) => m.direction === "in").map((m) => m.id),
  };

  // Una persona contestó desde la bandeja antes de que este turno arrancara:
  // lo que lo provocó ya está atendido. Solo en el camino del coalesce (el
  // que trae debidos); el Laboratorio no tiene quien conteste a mano.
  if (opciones.debidos && !vigentes.length && atendidoPorPersona(recientes)) {
    return leido;
  }

  // Ventana cerrada: el agente JAMÁS envía texto libre → handoff 'ventana'.
  if (
    !conversation.isTest &&
    !isWindowOpen(
      conversation.lastInboundAt,
      new Date(),
      windowMsFor(conversation.channel)
    )
  ) {
    await applyHandoff(conversationId, organizationId, "ventana");
    return leido;
  }

  // Patrón de respaldo ANTES del LLM (FR-022). Avisa y traspasa, en el mismo
  // orden que el camino del modelo (`farewell` y luego handoff): callar ante
  // quien pide una persona se lee como que el bot dejó de contestar.
  if (lastInbound.text && matchesHandoffIntent(lastInbound.text)) {
    await acknowledgeHandoff(conversation);
    await applyHandoff(conversationId, organizationId, "cliente");
    return leido;
  }

  const kb = await db
    .select()
    .from(schema.kbEntry)
    .where(eq(schema.kbEntry.organizationId, organizationId))
    .orderBy(asc(schema.kbEntry.createdAt));
  const stages = await db
    .select({ id: schema.pipelineStage.id, name: schema.pipelineStage.name })
    .from(schema.pipelineStage)
    .where(eq(schema.pipelineStage.organizationId, organizationId))
    .orderBy(asc(schema.pipelineStage.position));

  const agenda = agendaEnabled();

  /**
   * 015 — Los huecos vigentes, con su instante exacto.
   *
   * `book_slot` exige el `startUtc` y `findOffered` compara por epoch, sin
   * tolerancia. Pero al modelo solo le llegaban el prompt y el historial de
   * TEXTO, donde están las etiquetas que leyó el cliente —«lun 7 sep, 11:00»—
   * sin año, sin zona y sin la fecha de hoy. Con eso, acertar el instante era
   * cuestión de suerte: el rechazo caía siempre en `slot_not_offered`, cuyo
   * texto es fijo, y la conversación se quedaba en bucle repitiendo la lista.
   *
   * Es un agujero de INTEGRACIÓN: las pruebas de contrato pasan porque
   * inyectan el ISO correcto, que es justo lo que el modelo no tenía.
   *
   * Sin oferta vigente no se añade nada, así que el modelo sigue obligado a
   * ofrecer antes de reservar. Se entrega el catálogo COMPLETO, no solo los
   * tres que se enseñaron: si el cliente pide otro día, ese hueco ya estaba
   * registrado como ofrecido y ahora el modelo también lo conoce.
   *
   * Reportado por @Diony7004 en #50, con el diagnóstico ya hecho.
   */
  const ofertas = agenda ? await getOffers(organizationId, conversationId) : [];
  const mapaDeHuecos = mapaDeHuecosParaModelo(ofertas);

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildAgentSystemPrompt({
        profile,
        kb,
        stages,
        agenda,
        // 031: el formato del prompt depende del canal de la conversación.
        channel: conversation.channel,
      }),
    },
    ...history
      .filter((m) => m.text)
      .map((m) => ({
        role: m.direction === "in" ? ("user" as const) : ("assistant" as const),
        content: m.text!,
      })),
    /**
     * Va AL FINAL, después del historial: es el estado de AHORA, y ponerlo
     * antes lo dejaría enterrado bajo la conversación en cuanto esta crezca.
     */
    ...(mapaDeHuecos
      ? [{ role: "system" as const, content: mapaDeHuecos }]
      : []),
    // 029 — Lo último que lee el modelo: contestar con el JSON de la acción.
    { role: "system", content: TURN_FORMAT_REMINDER },
  ];

  const result = await chatJson(agentActionSchema(agenda), messages, {
    organizationId,
  });
  if (!result.ok) {
    if (result.error === "not_configured") return leido;
    // Fallo persistente del proveedor o salida imposible → escalar (FR-022).
    console.error(`[agente] fallo del proveedor (raw): ${result.detail}`);
    await applyHandoff(conversationId, organizationId, "error");
    return leido;
  }

  let action: AgentActionType = result.data;

  // 015 — Agenda. Un fallo del motor degrada el turno (el agente responde sin
  // agendar), nunca lo tumba: quedarse callado es peor que no agendar.
  if (action.action === "offer_slots" || action.action === "book_slot") {
    if (!agenda) {
      action = degradeAction(action);
    } else {
      try {
        const turn =
          action.action === "offer_slots"
            ? await offerSlots({
                organizationId,
                conversationId,
                intro: action.reply,
              })
            : await bookSlot({
                organizationId,
                conversationId,
                startUtc: action.startUtc,
                confirmation: action.reply,
              });
        await deliverReply(conversation, turn.text);
        if (turn.ok) {
          publish(organizationId, {
            type: "conversation.updated",
            data: { conversation: { id: conversationId } },
          });
        }
        return leido;
      } catch (err) {
        console.error(`[agente] el motor de agenda falló: ${err}`);
        action = degradeAction(action);
      }
    }
  }

  // 044 — El pedido por chat entra al pipeline solo cuando se confirma,
  // y el monto se fija en forma determinística: primero el `amount`
  // explícito de la acción (`update_lead`) y, si no viene, la línea
  // «Total: ₡X» del mensaje (041, `extraerTotalDeConfirmacion`).
  // Va ANTES del bloque move_stage previo al switch porque ese bloque
  // retorna temprano: si el turno confirma con move_stage, el lead tiene
  // que existir ya cuando ese bloque lo busque. El update_lead con monto
  // y el move_stage del perfil a «Nuevo pedido» lo encuentran creado.
  // Nunca tumba el turno: ante cualquier error se loguea y se sigue.
  try {
    const textoConfirmacion = textoPedidoConfirmado(action);
    if (textoConfirmacion && (await esPipelineDePedidos(organizationId))) {
      const montoExplicito =
        action.action === "update_lead" ? action.amount : undefined;
      await registrarPedidoConfirmado(
        organizationId,
        conversation.contactId,
        textoConfirmacion,
        montoExplicito,
      );
    }
  } catch (err) {
    console.error(`[agente] no se pudo asegurar el lead del pedido: ${err}`);
  }

  if (action.action === "move_stage") {
    const stage = resolveStage(action.stage, stages);
    if (!stage) {
      action = degradeAction(action);
    } else {
      await moveLeadToStage(organizationId, conversation.contactId, stage.id);
      publish(organizationId, {
        type: "conversation.updated",
        data: { conversation: { id: conversationId } },
      });
      if (action.reply) {
        await deliverReply(conversation, action.reply);
      }
      return leido;
    }
  }

  switch (action.action) {
    case "none":
      return leido;
    case "reply":
      await deliverReply(conversation, action.text);
      return leido;
    case "update_lead": {
      await appendLeadNote(organizationId, conversation.contactId, action.note);
      // 042 — Si la acción trae monto, aterriza en el mismo lead (por
      // contacto) sin importar en qué orden ocurran esta acción y el
      // `move_stage` a «Nuevo pedido». Sin `amount`, nada cambia: la
      // nota se guarda y el monto no se toca. `fijarMontoLead` nunca
      // lanza, así que la nota y la respuesta se preservan aunque el
      // monto se descarte.
      if (action.amount !== undefined) {
        const currency = (await getBranding(organizationId)).currency;
        await fijarMontoLead(
          organizationId,
          conversation.contactId,
          colonesACentavos(action.amount),
          currency
        );
      }
      if (action.reply) await deliverReply(conversation, action.reply);
      return leido;
    }
    case "handoff": {
      if (action.farewell) {
        await deliverReply(conversation, action.farewell);
      }
      await applyHandoff(conversationId, organizationId, "modelo");
      return leido;
    }
  }
  return leido;
}

type Conversation = typeof schema.conversation.$inferSelect;

/** Entrega la respuesta: envío real o persistencia sandbox (is_test). */
async function deliverReply(
  conversation: Conversation,
  text: string
): Promise<void> {
  if (conversation.isTest) {
    await persistTestOutbound(conversation, text);
    return;
  }
  try {
    await sendText({
      conversationId: conversation.id,
      organizationId: conversation.organizationId,
      text,
      aiGenerated: true,
    });
  } catch (err) {
    if (err instanceof SendError && err.code === "window_closed") {
      await applyHandoff(conversation.id, conversation.organizationId, "ventana");
      return;
    }
    // 022 — El canal ya no admite más mensajes hasta que el cliente escriba
    // (el tope de TikTok). No se traspasa: dejaría la IA en pausa para siempre
    // por algo que se arregla solo con el siguiente mensaje del cliente.
    if (err instanceof SendError && err.code === "message_limit") {
      console.warn(
        `[agente] ${conversation.id}: ${err.message}. No se envía y la IA sigue activa.`
      );
      return;
    }
    throw err;
  }
}

/**
 * FR-022 — El acuse del patrón de respaldo, antes de traspasar.
 *
 * Sale por `deliverReply`, el mismo camino que el `farewell` del modelo, así
 * que hereda sus garantías: una conversación del Laboratorio lo persiste sin
 * tocar la API, y con la ventana de 24 h cerrada no sale texto libre (el turno
 * ya traspasó por `ventana` antes de llegar aquí, y el emisor lo rechazaría
 * igual). Tampoco se repite si el turno vuelve a correr: el traspaso deja
 * `handoffAt` puesto y el turno siguiente se calla en la primera comprobación,
 * igual que tras el `farewell`.
 *
 * Lo único que cambia respecto a ese camino: si el envío falla, el traspaso
 * se aplica IGUAL. Quien pidió una persona tiene que llegar a una aunque el
 * aviso no haya salido; dejarlo con la IA encendida sería peor que el silencio.
 */
async function acknowledgeHandoff(conversation: Conversation): Promise<void> {
  try {
    await deliverReply(conversation, HANDOFF_BACKUP_ACK);
  } catch (err) {
    console.error(
      `[agente] el acuse del traspaso no salió en ${conversation.id}; se traspasa igual:`,
      err
    );
  }
}

/** Mensaje saliente del sandbox: se persiste, JAMÁS toca la API (FR-031). */
async function persistTestOutbound(
  conversation: Conversation,
  text: string
): Promise<void> {
  const db = getDb();
  await db.insert(schema.message).values({
    id: newId("message"),
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    direction: "out",
    type: "text",
    text,
    status: "sent",
    aiGenerated: true,
    origin: "ai",
  });
  await db
    .update(schema.conversation)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.conversation.id, conversation.id));
}

export async function applyHandoff(
  conversationId: string,
  organizationId: string,
  reason: "cliente" | "modelo" | "error" | "ventana"
): Promise<void> {
  const db = getDb();
  const updated = await db
    .update(schema.conversation)
    .set({ handoffAt: new Date(), handoffReason: reason, updatedAt: new Date() })
    .where(eq(schema.conversation.id, conversationId))
    .returning();
  if (!updated[0]) return;
  publish(organizationId, {
    type: "conversation.updated",
    data: {
      conversation: { id: conversationId, handoffReason: reason },
    },
  });
}

async function moveLeadToStage(
  organizationId: string,
  contactId: string,
  stageId: string
): Promise<void> {
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
  const leadId = rows[0]?.id;
  if (!leadId) return;

  // Por la puerta única: el agente mueve tarjetas igual que el dueño, y su
  // movimiento tiene que quedar en la bitácora o el embudo mentirá sobre
  // quién hizo avanzar cada lead.
  await moveLeadThroughHistory({
    organizationId,
    leadId,
    toStageId: stageId,
    source: "bot",
    extra: { lastActivityAt: new Date() },
    // El agente no clasifica pérdidas: si su etapa destino resultara ser la
    // perdida, la puerta lo rechaza y el lead se queda donde está — mejor eso
    // que un motivo inventado.
  });
}

async function appendLeadNote(
  organizationId: string,
  contactId: string,
  note: string
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.contact.id, notes: schema.contact.notes })
    .from(schema.contact)
    .where(eq(schema.contact.id, contactId))
    .limit(1);
  const contact = rows[0];
  if (!contact) return;
  const stamped = `[IA] ${note}`;
  await db
    .update(schema.contact)
    .set({
      notes: contact.notes ? `${contact.notes}\n${stamped}` : stamped,
      updatedAt: new Date(),
    })
    .where(eq(schema.contact.id, contact.id));
}
