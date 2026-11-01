import { beforeEach, describe, expect, it, vi } from "vitest";

import { BookingError } from "@/server/agenda/service";
import { cancelSlot, rescheduleSlot } from "@/server/agenda/agent";

/**
 * 015 — `cancelSlot` y `rescheduleSlot` de `agent.ts`: el envoltorio que el
 * pipeline le enseña al cliente.
 *
 * Se mockea solo `@/server/agenda/service`: los mensajes se construyen aquí,
 * en el envoltorio, y lo que el servicio devolvió o lanzó se fija en sus
 * propias pruebas.
 */

const mocks = vi.hoisted(() => ({
  cancelForConversation: vi.fn(),
  rescheduleForConversation: vi.fn(),
}));

const { cancelForConversation, rescheduleForConversation } = mocks;

vi.mock("@/server/agenda/service", async (importOriginal) => {
  // Se conserva la clase real de BookingError para que el `instanceof` de
  // agent.ts funcione; solo se sustituyen las dos funciones de red/BD.
  const actual =
    await importOriginal<typeof import("@/server/agenda/service")>();
  return {
    ...actual,
    cancelForConversation: mocks.cancelForConversation,
    rescheduleForConversation: mocks.rescheduleForConversation,
  };
});

const ORG = "org_1";
const CONV = "cv_1";
const NUEVO = "2026-11-03T16:00:00.000Z";

const ETIQUETAS = [
  { startUtc: "2026-11-03T17:00:00.000Z", label: "martes a las 11:00" },
  { startUtc: "2026-11-03T18:00:00.000Z", label: "martes a las 12:00" },
];

describe("cancelSlot", () => {
  beforeEach(() => {
    cancelForConversation.mockReset();
  });

  it("confirma la cancelación con la etiqueta que devolvió el servicio", async () => {
    cancelForConversation.mockResolvedValue({
      bookingId: "bk_1",
      label: "martes a las 10:00",
    });

    const turn = await cancelSlot({
      organizationId: ORG,
      conversationId: CONV,
    });

    expect(cancelForConversation).toHaveBeenCalledWith({
      organizationId: ORG,
      conversationId: CONV,
    });
    expect(turn).toEqual({
      ok: true,
      text: "¡Listo! Cancelé tu cita del martes a las 10:00.",
    });
  });

  it("usa la confirmación redactada por el modelo cuando viene", async () => {
    cancelForConversation.mockResolvedValue({
      bookingId: "bk_1",
      label: "martes a las 10:00",
    });

    const turn = await cancelSlot({
      organizationId: ORG,
      conversationId: CONV,
      confirmation: "Ya quedó cancelada, perdón por el enredo.",
    });

    expect(turn.ok).toBe(true);
    expect(turn.text).toBe("Ya quedó cancelada, perdón por el enredo.");
  });

  it("sin cita activa responde ok:false con el mensaje de que no hay nada que cancelar", async () => {
    cancelForConversation.mockRejectedValue(
      new BookingError("not_found", "No tenés ninguna cita activa para cancelar.", [])
    );

    const turn = await cancelSlot({
      organizationId: ORG,
      conversationId: CONV,
    });

    expect(turn).toEqual({
      ok: false,
      text: "No tenés ninguna cita activa para cancelar.",
    });
  });

  it("si el error trae slots, se re-ofrecen en vez de discutir", async () => {
    cancelForConversation.mockRejectedValue(
      new BookingError("slot_taken", "ocupado", ETIQUETAS)
    );

    const turn = await cancelSlot({
      organizationId: ORG,
      conversationId: CONV,
    });

    expect(turn.ok).toBe(false);
    expect(turn.text).toContain("Se me acaba de ocupar ese horario, ¡perdón!");
    expect(turn.text).toContain("• martes a las 11:00");
    expect(turn.text).toContain("• martes a las 12:00");
  });

  it("los errores que no son BookingError se relanzan", async () => {
    const boom = new Error("la base se cayó");
    cancelForConversation.mockRejectedValue(boom);

    await expect(
      cancelSlot({ organizationId: ORG, conversationId: CONV })
    ).rejects.toBe(boom);
  });
});

describe("rescheduleSlot", () => {
  beforeEach(() => {
    rescheduleForConversation.mockReset();
  });

  it("confirma el movimiento y pega el enlace de la reunión", async () => {
    rescheduleForConversation.mockResolvedValue({
      booking: { id: "bk_1" },
      meetingLink: "https://meet.ejemplo.com/sala",
      linkPending: false,
      label: "miércoles a las 14:00",
    });

    const turn = await rescheduleSlot({
      organizationId: ORG,
      conversationId: CONV,
      startUtc: NUEVO,
    });

    expect(rescheduleForConversation).toHaveBeenCalledWith({
      organizationId: ORG,
      conversationId: CONV,
      startUtc: NUEVO,
    });
    expect(turn).toEqual({
      ok: true,
      text: "¡Listo! Moví tu cita a miércoles a las 14:00.\nEnlace: https://meet.ejemplo.com/sala",
    });
  });

  it("con enlace pendiente avisa que lo comparte en un momento, sin prometerlo ya", async () => {
    rescheduleForConversation.mockResolvedValue({
      booking: { id: "bk_1" },
      meetingLink: null,
      linkPending: true,
      label: "miércoles a las 14:00",
    });

    const turn = await rescheduleSlot({
      organizationId: ORG,
      conversationId: CONV,
      startUtc: NUEVO,
      confirmation: "Movida, quedó para el miércoles.",
    });

    expect(turn).toEqual({
      ok: true,
      text: "Movida, quedó para el miércoles.\nEn un momento te comparto el enlace por aquí.",
    });
  });

  it("sin enlace y sin pendiente confirma solo con la etiqueta", async () => {
    rescheduleForConversation.mockResolvedValue({
      booking: { id: "bk_1" },
      meetingLink: null,
      linkPending: false,
      label: "miércoles a las 14:00",
    });

    const turn = await rescheduleSlot({
      organizationId: ORG,
      conversationId: CONV,
      startUtc: NUEVO,
    });

    expect(turn).toEqual({
      ok: true,
      text: "¡Listo! Moví tu cita a miércoles a las 14:00.",
    });
  });

  it("slot_taken re-ofrece con disculpa y alternativas frescas", async () => {
    rescheduleForConversation.mockRejectedValue(
      new BookingError("slot_taken", "ocupado", ETIQUETAS)
    );

    const turn = await rescheduleSlot({
      organizationId: ORG,
      conversationId: CONV,
      startUtc: NUEVO,
    });

    expect(turn.ok).toBe(false);
    expect(turn.text).toContain("Se me acaba de ocupar ese horario, ¡perdón!");
    expect(turn.text).toContain("• martes a las 11:00");
  });

  it("slot_not_offered re-ofrece con lo que sí se había ofrecido", async () => {
    rescheduleForConversation.mockRejectedValue(
      new BookingError("slot_not_offered", "no ofrecido", ETIQUETAS)
    );

    const turn = await rescheduleSlot({
      organizationId: ORG,
      conversationId: CONV,
      startUtc: NUEVO,
    });

    expect(turn.ok).toBe(false);
    expect(turn.text).toContain("Déjame confirmarte los horarios que tengo:");
    expect(turn.text).toContain("• martes a las 12:00");
  });

  it("sin slots el fallo promete revisión del equipo", async () => {
    rescheduleForConversation.mockRejectedValue(
      new BookingError("not_found", "Conversación no encontrada", [])
    );

    const turn = await rescheduleSlot({
      organizationId: ORG,
      conversationId: CONV,
      startUtc: NUEVO,
    });

    expect(turn).toEqual({
      ok: false,
      text: "No pude mover tu cita en este momento. Lo reviso con el equipo y te confirmo.",
    });
  });

  it("los errores que no son BookingError se relanzan", async () => {
    const boom = new Error("la base se cayó");
    rescheduleForConversation.mockRejectedValue(boom);

    await expect(
      rescheduleSlot({ organizationId: ORG, conversationId: CONV, startUtc: NUEVO })
    ).rejects.toBe(boom);
  });
});
