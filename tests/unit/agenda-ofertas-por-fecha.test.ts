import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CALENDAR_SETTINGS,
  type CalendarSettings,
} from "@/server/agenda/settings";
import type { AvailableSlot } from "@/server/agenda/availability";
import { offerSlots } from "@/server/agenda/agent";

/**
 * offer_slots con `date`: el día pedido y el día ofrecido nunca se desfasan.
 *
 * Reportado por Hudson (2026-11-01): pidió reagendar «para el 7 de noviembre»
 * y el agente respondió mencionando el 7 pero ofreció horarios del 2. Causa:
 * `offerSlots` ignoraba el día pedido y repartía desde hoy. Ahora acepta
 * `date` (YYYY-MM-DD) y ofrece SOLO ese día; si no hay nada, dice el motivo
 * (cerrado, lleno, pasado, fuera de horizonte) sin tocar la oferta vigente.
 *
 * Se mockea settings/availability/offers (lo que toca BD o red); `spread.ts`
 * y `lib/time/slots` son puros y van de verdad.
 */

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  computeAvailability: vi.fn(),
  replaceOffers: vi.fn(),
}));

vi.mock("@/server/agenda/settings", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server/agenda/settings")>();
  return { ...actual, getSettings: mocks.getSettings };
});

vi.mock("@/server/agenda/availability", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server/agenda/availability")>();
  return { ...actual, computeAvailability: mocks.computeAvailability };
});

vi.mock("@/server/agenda/offers", () => ({
  replaceOffers: mocks.replaceOffers,
}));

// Domingo 1 nov 2026, 09:00 en Costa Rica (UTC-6, sin horario de verano).
const NOW = new Date("2026-11-01T15:00:00.000Z");
const TZ = "America/Costa_Rica";

const SEMANA: CalendarSettings["weeklyHours"] = {
  mon: [{ start: "08:00", end: "18:00" }],
  tue: [{ start: "08:00", end: "18:00" }],
  wed: [{ start: "08:00", end: "18:00" }],
  thu: [{ start: "08:00", end: "18:00" }],
  fri: [{ start: "08:00", end: "18:00" }],
  sat: [{ start: "08:00", end: "12:00" }],
};

function ajustes(): CalendarSettings {
  return {
    ...DEFAULT_CALENDAR_SETTINGS,
    weeklyHours: SEMANA,
    slotMinutes: 60,
    bufferMinutes: 0,
    minNoticeHours: 0,
    maxDaysAhead: 30,
    timezone: TZ,
  };
}

function hueco(dayIso: string, horaLocal: string): AvailableSlot {
  // horaLocal "08:00" en CR (UTC-6) → UTC.
  const partes = horaLocal.split(":").map(Number);
  const h = partes[0] ?? 0;
  const m = partes[1] ?? 0;
  const start = new Date(`${dayIso}T${String(h + 6).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return {
    startUtc: start.toISOString(),
    endUtc: end.toISOString(),
    label: `${dayIso} ${horaLocal}`,
  };
}

// Viernes 7 de noviembre de 2026, con huecos libres.
const VIE7 = "2026-11-07";
const HUECOS_VIE7 = [hueco(VIE7, "08:00"), hueco(VIE7, "09:00"), hueco(VIE7, "10:00")];
// Lunes 2 de noviembre, para el reparto normal.
const LUN2 = "2026-11-02";
const HUECOS_LUN2 = [hueco(LUN2, "08:00"), hueco(LUN2, "09:00")];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.getSettings.mockResolvedValue(ajustes());
  mocks.replaceOffers.mockResolvedValue(undefined);
  mocks.computeAvailability.mockImplementation(
    async (_org: string, opts?: { fromISO?: string; toISO?: string }) => {
      if (opts?.fromISO === VIE7) return HUECOS_VIE7;
      if (opts?.fromISO === LUN2) return HUECOS_LUN2;
      return [];
    }
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("offerSlots con date", () => {
  it("ofrece SOLO el día pedido y lo registra como oferta", async () => {
    const turn = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      date: VIE7,
    });

    expect(mocks.computeAvailability).toHaveBeenCalledWith(
      "org_1",
      expect.objectContaining({ fromISO: VIE7, toISO: VIE7 })
    );
    expect(mocks.replaceOffers).toHaveBeenCalledWith(
      "org_1",
      "cv_1",
      HUECOS_VIE7.map((s) => ({ startUtc: s.startUtc, label: s.label }))
    );
    expect(turn.ok).toBe(true);
    // El día ofrecido es el pedido: horas del 7, sin mencionar otro día.
    expect(turn.text).toContain("• 08:00");
    expect(turn.text).toContain("• 09:00");
    expect(turn.text).toContain("7 de noviembre");
    expect(turn.text).not.toContain("2 de noviembre");
  });

  it("día abierto pero lleno: dice que no quedan horarios y NO toca la oferta vigente", async () => {
    // El viernes abre (hay candidatos) pero no queda nada libre.
    mocks.computeAvailability.mockResolvedValue([]);
    const turn = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      date: VIE7,
      intro: "Te busco para el viernes 7",
    });

    expect(turn.ok).toBe(false);
    expect(turn.text).toContain("ya no me quedan horarios libres");
    expect(turn.text).toContain("7 de noviembre");
    expect(turn.text).not.toContain("•");
    // La consulta por día que no encontró nada no borra lo ofrecido.
    expect(mocks.replaceOffers).not.toHaveBeenCalled();
  });

  it("día cerrado: dice que no abren y NO toca la oferta vigente", async () => {
    // Domingo 8 de noviembre: fuera de weeklyHours.
    const turn = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      date: "2026-11-08",
    });

    expect(turn.ok).toBe(false);
    expect(turn.text).toContain("no abrimos");
    expect(turn.text).toContain("8 de noviembre");
    expect(mocks.replaceOffers).not.toHaveBeenCalled();
  });

  it("fecha pasada: lo dice sin ofrecer nada", async () => {
    const turn = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      date: "2026-10-25",
    });

    expect(turn.ok).toBe(false);
    expect(turn.text).toContain("ya pasó");
    expect(mocks.replaceOffers).not.toHaveBeenCalled();
  });

  it("fecha fuera de horizonte: dice hasta dónde se puede agendar", async () => {
    const turn = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      date: "2026-12-15",
    });

    expect(turn.ok).toBe(false);
    expect(turn.text).toContain("Solo puedo agendar hasta el");
    expect(turn.text).toContain("1 de diciembre");
    expect(mocks.replaceOffers).not.toHaveBeenCalled();
  });

  it("fecha inválida: no tumba el turno, ofrece el reparto normal", async () => {
    // Sin fromISO (reparto normal), el mock devuelve los huecos del lunes.
    mocks.computeAvailability.mockImplementation(
      async (_org: string, opts?: { fromISO?: string; toISO?: string }) =>
        opts?.fromISO ? [] : HUECOS_LUN2
    );
    const turn = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      date: "2026-13-99",
    });

    // Sin fromISO/toISO: el reparto de siempre.
    expect(mocks.computeAvailability).toHaveBeenCalledWith(
      "org_1",
      expect.not.objectContaining({ fromISO: expect.anything() })
    );
    expect(turn.ok).toBe(true);
    expect(turn.text).toContain("2 de noviembre");
  });

  it("sin date: el reparto de siempre no cambia", async () => {
    mocks.computeAvailability.mockImplementation(async () => HUECOS_LUN2);
    const turn = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
    });

    expect(turn.ok).toBe(true);
    expect(turn.text).toContain("2 de noviembre");
    expect(mocks.replaceOffers).toHaveBeenCalledTimes(1);
  });
});
