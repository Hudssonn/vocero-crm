import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 015 — `cancelForConversation`: el camino del agente para cancelar.
 *
 * Replica el lookup de `rescheduleForConversation` (conversación → contacto →
 * cita activa más próxima) pero sin mover nada: cancela con `cancelBooking`.
 *
 * Como la base es la que ordena por `scheduledAt` asc (la misma query que al
 * reprogramar), el mock devuelve lo que esa query devolvería; lo que se fija
 * aquí es que la función pide la más próxima, actúa sobre ella y construye la
 * etiqueta en la zona del negocio.
 */

const settings = {
  weeklyHours: { wed: [{ start: "09:00", end: "18:00" }] },
  slotMinutes: 30,
  bufferMinutes: 0,
  minNoticeHours: 0,
  maxDaysAhead: 7,
  timezone: "America/Mexico_City",
  connector: "enlace-fijo" as const,
  meetingLink: "https://meet.ejemplo.com/sala",
};

// 15:00Z = 09:00 en Ciudad de México (agosto, UTC-6).
const SLOT_CERCANA = "2026-08-05T15:00:00.000Z";

const deleteMeeting = vi.fn(async () => {});
const publish = vi.fn(() => {});

vi.mock("@/server/agenda/settings", () => ({
  getSettings: async () => settings,
}));

vi.mock("@/server/agenda/connectors", () => ({
  bindConnector: async () => ({
    id: "enlace-fijo",
    createMeeting: async () => ({ externalId: null, joinUrl: settings.meetingLink }),
    updateMeeting: async () => {},
    deleteMeeting,
    testConnection: async () => ({ ok: true }),
  }),
  markConnectorAuthError: async () => {},
}));

vi.mock("@/server/events/bus", () => ({ publish }));

const cancelarRecordatoriosDeCita = vi.fn(async () => {});
vi.mock("@/server/reminders/service", () => ({
  cancelarRecordatoriosDeCita,
  generarRecordatorioParaCita: async () => {},
}));

/** Cola de resultados para cada `select(...).limit(n)` en orden de llamada. */
const selectRows: unknown[][] = [];
/** Valores pasados a cada `update(...).set(...)`. */
const updateSets: Record<string, unknown>[] = [];
/** Argumentos con los que se llamó a `orderBy`. */
const orderByCalls: unknown[][] = [];

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where", "leftJoin"]) c[m] = () => c;
  c.orderBy = (...args: unknown[]) => {
    orderByCalls.push(args);
    return c;
  };
  c.limit = () => Promise.resolve(rows);
  return c;
}

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => chain(selectRows.shift() ?? []),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        updateSets.push(v);
        // cancelBooking no usa .returning(): basta con algo awaitable.
        return { where: () => Promise.resolve([]) };
      },
    }),
  }),
  schema: {
    booking: {},
    conversation: { organizationId: "organizationId", id: "id" },
    contact: { organizationId: "organizationId", id: "id", name: "name" },
    lead: { organizationId: "organizationId", contactId: "contactId" },
    pipelineStage: { organizationId: "organizationId" },
    offeredSlot: {},
  },
}));

function cita(id: string, startUtc: string, status = "agendada") {
  return {
    id,
    organizationId: "org_1",
    kind: "session",
    contactId: "ct_1",
    conversationId: "cv_1",
    scheduledAt: new Date(startUtc),
    durationMinutes: 30,
    status,
    isTest: false,
    connector: "enlace-fijo",
    // Sin reunión en el proveedor: el conector no debe tocarse.
    externalRef: null,
    meetingLink: null,
    linkPending: false,
    notes: null,
  };
}

describe("cancelForConversation", () => {
  beforeEach(() => {
    selectRows.length = 0;
    updateSets.length = 0;
    orderByCalls.length = 0;
    deleteMeeting.mockClear();
    publish.mockClear();
    cancelarRecordatoriosDeCita.mockClear();
  });

  it("cancela la más próxima cuando el contacto tiene varias activas", async () => {
    const { cancelForConversation } = await import("@/server/agenda/service");
    selectRows.push([{ contactId: "ct_1" }]); // la conversación
    // La base ordena por scheduledAt asc y corta en 1: solo llega la cercana.
    selectRows.push([cita("bk_cercana", SLOT_CERCANA)]);
    selectRows.push([cita("bk_cercana", SLOT_CERCANA)]); // getOwnBooking en cancelBooking

    const result = await cancelForConversation({
      organizationId: "org_1",
      conversationId: "cv_1",
    });

    // Pide la cita activa más próxima: ordenada por hora ascendente.
    expect(orderByCalls).toHaveLength(1);
    expect(result).toEqual({
      bookingId: "bk_cercana",
      label: "mié 5 ago, 09:00",
    });
    // La cancelación quedó escrita en la fila correcta.
    expect(updateSets).toHaveLength(1);
    expect(updateSets[0]?.status).toBe("cancelada");
    expect(publish).toHaveBeenCalledWith(
      "org_1",
      expect.objectContaining({
        type: "booking.updated",
        data: { bookingId: "bk_cercana" },
      })
    );
    // Sin reunión en el proveedor, no hay nada que borrar.
    expect(deleteMeeting).not.toHaveBeenCalled();
    // Y el recordatorio de la cita muere con ella.
    expect(cancelarRecordatoriosDeCita).toHaveBeenCalledWith({
      organizationId: "org_1",
      bookingId: "bk_cercana",
    });
  });

  it("sin cita activa: not_found con el mensaje del agente y slots vacíos", async () => {
    const { cancelForConversation, BookingError } = await import(
      "@/server/agenda/service"
    );
    selectRows.push([{ contactId: "ct_1" }]);
    selectRows.push([]); // sin citas agendadas

    const promise = cancelForConversation({
      organizationId: "org_1",
      conversationId: "cv_1",
    });

    await expect(promise).rejects.toBeInstanceOf(BookingError);
    await promise.catch((err) => {
      expect(err.code).toBe("not_found");
      expect(err.message).toBe("No tenés ninguna cita activa para cancelar.");
      // Sin slots que re-ofrecer: no se inventa nada.
      expect(err.slots).toEqual([]);
    });
    expect(updateSets).toHaveLength(0);
  });

  it("es idempotente si la cita ya estaba cancelada al llegar a cancelBooking", async () => {
    const { cancelForConversation } = await import("@/server/agenda/service");
    selectRows.push([{ contactId: "ct_1" }]);
    selectRows.push([cita("bk_1", SLOT_CERCANA)]);
    // Entre el lookup y la cancelación, alguien más ya la canceló.
    selectRows.push([cita("bk_1", SLOT_CERCANA, "cancelada")]);

    const result = await cancelForConversation({
      organizationId: "org_1",
      conversationId: "cv_1",
    });

    // cancelBooking es idempotente: retorna sin escribir ni publicar.
    expect(result.bookingId).toBe("bk_1");
    expect(updateSets).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("conversación inexistente: not_found con el mensaje copiado", async () => {
    const { cancelForConversation } = await import("@/server/agenda/service");
    selectRows.push([]); // no hay conversación

    await expect(
      cancelForConversation({ organizationId: "org_1", conversationId: "cv_x" })
    ).rejects.toMatchObject({
      code: "not_found",
      message: "Conversación no encontrada",
    });
  });

  it("conversación sin contacto: invalid con el mensaje copiado", async () => {
    const { cancelForConversation } = await import("@/server/agenda/service");
    selectRows.push([{ contactId: null }]);

    await expect(
      cancelForConversation({ organizationId: "org_1", conversationId: "cv_1" })
    ).rejects.toMatchObject({
      code: "invalid",
      message: "La cita necesita un contacto",
    });
  });
});
