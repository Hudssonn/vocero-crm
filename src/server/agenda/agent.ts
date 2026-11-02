import {
  addDaysISO,
  todayInTz,
  zonedWallClockToUtc,
} from "@/lib/time/slots";
import {
  buildCandidateSlots,
  computeAvailability,
} from "@/server/agenda/availability";
import { getSettings } from "@/server/agenda/settings";
import { armarHuecos, spreadByDay } from "@/server/agenda/spread";
import { replaceOffers } from "@/server/agenda/offers";
import { BookingError, cancelForConversation, createSessionBooking, rescheduleForConversation } from "@/server/agenda/service";

/**
 * 015 — Lo que el agente incluido puede hacer con la agenda.
 *
 * Vive aquí y no en el pipeline para que el pipeline no aprenda de agendas: el
 * turno pide "ofrece" o "reserva" y recibe el texto que hay que mandar.
 *
 * Regla que atraviesa todas las operaciones: el modelo NO redacta horarios. Pide
 * ofrecer, y el motor pega las etiquetas reales. Si el modelo inventa un
 * instante al reservar, el motor lo rechaza y se re-ofrece — nunca se agenda
 * algo que el cliente no eligió.
 */

/** Cuántos huecos se le enseñan al cliente en un mensaje. */
const SHOWN = 3;
/** Cuántos se guardan como reservables: el catálogo es más ancho que el menú. */
const OFFERED = 12;

export type AgendaTurn = {
  /** Lo que hay que enviarle al cliente. */
  text: string;
  /** false ⇒ el motor no pudo; el turno sigue, sin agendar. */
  ok: boolean;
};

export async function offerSlots(input: {
  organizationId: string;
  conversationId: string;
  intro?: string;
  /**
   * Día concreto (YYYY-MM-DD) que pidió el cliente. Con esto se ofrecen
   * horarios SOLO de ese día; si no hay nada, se dice por qué en vez de
   * enseñar días que no pidió. Sin esto, el reparto de siempre.
   */
  date?: string;
}): Promise<AgendaTurn> {
  const settings = await getSettings(input.organizationId);
  const now = new Date();

  const pedido = input.date?.trim() || null;
  const fecha = pedido && fechaValida(pedido) ? pedido : null;
  if (pedido && !fecha) {
    // El modelo escribió mal la fecha: no se tumba el turno, se ofrece el
    // reparto normal con horarios reales.
    console.warn(`[agenda] offer_slots con fecha inválida: ${pedido}`);
  }
  if (fecha) {
    return offerSlotsDelDia({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      settings,
      now,
      fecha,
      intro: input.intro,
    });
  }

  const all = await computeAvailability(input.organizationId, {
    settings,
    now,
  });
  const spread = spreadByDay(all, {
    timezone: settings.timezone,
    limit: OFFERED,
    perDay: 3,
    now,
  });

  if (spread.length === 0) {
    // Agenda llena no es un error: es una respuesta que el cliente entiende.
    return {
      ok: false,
      text:
        input.intro?.trim() ||
        "Por ahora no me quedan horarios libres. Déjame confirmarlo con el equipo y te aviso.",
    };
  }

  // Se REGISTRA todo el catálogo, no solo lo que se enseña: si el cliente pide
  // otro día, el agente tiene alternativas legítimas que aceptar.
  await replaceOffers(
    input.organizationId,
    input.conversationId,
    spread.map((s) => ({ startUtc: s.startUtc, label: s.label }))
  );

  const shown = spread.slice(0, SHOWN);
  const lista = shown.map((s) => `• ${s.dayLabel} a las ${s.time}`).join("\n");
  const intro = input.intro?.trim() || "Tengo estos horarios disponibles:";
  return { ok: true, text: `${intro}\n${lista}` };
}

/**
 * Ofrece horarios de UN día concreto. El día pedido y el día ofrecido nunca
 * se desfasan: si no hay nada ese día, el texto lo dice (cerrado, lleno,
 * pasado o fuera de horizonte) y la oferta vigente NO se toca —igual que
 * `GET /api/bot/availability`: el cliente todavía puede quedarse con un día
 * que se le ofreció antes.
 */
async function offerSlotsDelDia(input: {
  organizationId: string;
  conversationId: string;
  settings: Awaited<ReturnType<typeof getSettings>>;
  now: Date;
  fecha: string;
  intro?: string;
}): Promise<AgendaTurn> {
  const { organizationId, conversationId, settings, now, fecha } = input;
  const timezone = settings.timezone;
  const hoy = todayInTz(now, timezone);
  const dentro =
    fecha >= hoy && fecha <= addDaysISO(hoy, settings.maxDaysAhead);
  const todos = dentro
    ? await computeAvailability(organizationId, {
        settings,
        now,
        fromISO: fecha,
        toISO: fecha,
      })
    : [];
  const { slots, query } = armarHuecos({
    todos,
    timezone,
    now,
    maxDaysAhead: settings.maxDaysAhead,
    limit: OFFERED,
    perDay: 3,
    date: fecha,
    candidatosDelDia: dentro
      ? buildCandidateSlots(settings, fecha, fecha).length
      : 0,
  });

  if (slots.length === 0) {
    // Sin horarios para ese día: la intro del modelo asumía que sí había,
    // así que se ignora y se responde solo con el motivo real.
    const etiqueta = etiquetaDia(fecha, timezone);
    const texto =
      query.status === "closed"
        ? `El ${etiqueta} no abrimos. ¿Te sirve otro día?`
        : query.status === "full"
          ? `El ${etiqueta} ya no me quedan horarios libres. ¿Buscamos otro día?`
          : query.status === "past"
            ? "Esa fecha ya pasó. ¿Qué día te sirve?"
            : `Solo puedo agendar hasta el ${etiquetaDia(query.horizonEnd, timezone)}. ¿Qué día te sirve?`;
    return { ok: false, text: texto };
  }

  await replaceOffers(
    organizationId,
    conversationId,
    slots.map((s) => ({ startUtc: s.startUtc, label: s.label }))
  );

  const shown = slots.slice(0, SHOWN);
  // Todos son del mismo día: la etiqueta del día va en la entrada, no en
  // cada línea —así el día ofrecido y el día pedido no se pueden desfasar.
  const lista = shown.map((s) => `• ${s.time}`).join("\n");
  const intro =
    input.intro?.trim() ||
    `Estos son los horarios que tengo para el ${etiquetaDia(fecha, timezone)}:`;
  return { ok: true, text: `${intro}\n${lista}` };
}

/** YYYY-MM-DD que además existe en el calendario (nada de 2026-02-31). */
function fechaValida(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * "viernes 7 de noviembre" para un día YYYY-MM-DD en la zona del negocio.
 * Se ancla al mediodía de ese día en la zona para no cruzar de día en
 * ninguna zona horaria.
 */
function etiquetaDia(dayIso: string, timezone: string): string {
  const mediodia =
    zonedWallClockToUtc(dayIso, "12:00", timezone) ??
    new Date(`${dayIso}T12:00:00Z`);
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(mediodia);
}

export async function bookSlot(input: {
  organizationId: string;
  conversationId: string;
  startUtc: string;
  confirmation?: string;
}): Promise<AgendaTurn> {
  try {
    const result = await createSessionBooking({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      startUtc: input.startUtc,
      source: "ai",
      requireOffer: true,
    });

    const base =
      input.confirmation?.trim() || `¡Listo! Te agendé para ${result.label}.`;
    if (result.meetingLink) {
      return { ok: true, text: `${base}\nEnlace: ${result.meetingLink}` };
    }
    if (result.linkPending) {
      // La cita existe; el enlace no. No se promete lo que no se tiene.
      return {
        ok: true,
        text: `${base}\nEn un momento te comparto el enlace por aquí.`,
      };
    }
    return { ok: true, text: base };
  } catch (err) {
    if (!(err instanceof BookingError)) throw err;

    // Se ocupó o el modelo inventó la hora: en ambos casos se re-ofrece con
    // datos reales en vez de discutir con el cliente.
    const reoferta = textoReoferta(err);
    if (reoferta) return { ok: false, text: reoferta };
    return {
      ok: false,
      text: "No pude agendarlo en este momento. Lo reviso con el equipo y te confirmo.",
    };
  }
}

/**
 * Cuando el motor no pudo concretar pero trae horarios alternativos, se
 * re-ofrecen con datos reales en vez de discutir con el cliente. Devuelve
 * null si el error no trae slots para enseñar.
 */
function textoReoferta(err: BookingError): string | null {
  if (err.slots.length === 0) return null;
  const lista = err.slots
    .slice(0, SHOWN)
    .map((s) => `• ${s.label}`)
    .join("\n");
  const disculpa =
    err.code === "slot_taken"
      ? "Se me acaba de ocupar ese horario, ¡perdón!"
      : "Déjame confirmarte los horarios que tengo:";
  return `${disculpa}\n${lista}`;
}

export async function cancelSlot(input: {
  organizationId: string;
  conversationId: string;
  confirmation?: string;
}): Promise<AgendaTurn> {
  try {
    const result = await cancelForConversation({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
    });
    return {
      ok: true,
      text:
        input.confirmation?.trim() ||
        `¡Listo! Cancelé tu cita del ${result.label}.`,
    };
  } catch (err) {
    if (!(err instanceof BookingError)) throw err;

    // "not_found" nunca debería traer slots; si los trae, se re-ofrecen
    // igual que en bookSlot en vez de discutir con el cliente.
    const reoferta = textoReoferta(err);
    if (reoferta) return { ok: false, text: reoferta };
    return { ok: false, text: "No tenés ninguna cita activa para cancelar." };
  }
}

export async function rescheduleSlot(input: {
  organizationId: string;
  conversationId: string;
  startUtc: string;
  confirmation?: string;
}): Promise<AgendaTurn> {
  try {
    const result = await rescheduleForConversation({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      startUtc: input.startUtc,
    });

    const base =
      input.confirmation?.trim() || `¡Listo! Moví tu cita a ${result.label}.`;
    if (result.meetingLink) {
      return { ok: true, text: `${base}\nEnlace: ${result.meetingLink}` };
    }
    if (result.linkPending) {
      // La cita existe; el enlace no. No se promete lo que no se tiene.
      return {
        ok: true,
        text: `${base}\nEn un momento te comparto el enlace por aquí.`,
      };
    }
    return { ok: true, text: base };
  } catch (err) {
    if (!(err instanceof BookingError)) throw err;

    // Mismo trato que bookSlot: el horario nuevo se ocupó o el modelo lo
    // inventó — se re-ofrece con datos reales.
    const reoferta = textoReoferta(err);
    if (reoferta) return { ok: false, text: reoferta };
    return {
      ok: false,
      text: "No pude mover tu cita en este momento. Lo reviso con el equipo y te confirmo.",
    };
  }
}
