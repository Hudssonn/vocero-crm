import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HANDOFF_AUTO_EXPIRY_MS,
  expirarHandoffSiCorresponde,
  handoffVencido,
} from "@/server/ai/pipeline";

/**
 * Expiración automática del handoff (pedido de Hudson, 2026-11-01):
 * si el handoff lleva más de 15 minutos activo y ninguna persona escribió
 * desde entonces, el agente retoma solo. Si una persona atendió, no se toca.
 */

const publish = vi.fn();
vi.mock("@/server/events/bus", () => ({
  publish: (...args: unknown[]) => publish(...(args as [])),
}));

// Mock mínimo de la BD: solo las dos consultas que usa la función.
const filasHumanas: { id: string }[] = [];
const updateSet = vi.fn();
const updateWhere = vi.fn(() => Promise.resolve());

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([...filasHumanas]),
        }),
      }),
    }),
    update: () => ({
      set: (valores: unknown) => {
        updateSet(valores);
        return { where: updateWhere };
      },
    }),
  }),
  schema: {
    message: {
      id: "id",
      conversationId: "conversationId",
      direction: "direction",
      aiGenerated: "aiGenerated",
      createdAt: "createdAt",
    },
    conversation: { id: "id" },
  },
}));

function conversacion(handoffAt: Date | null) {
  return { id: "cv_test", organizationId: "org_test", handoffAt };
}

describe("handoffVencido (pura)", () => {
  it("sin handoff no vence", () => {
    expect(handoffVencido(null)).toBe(false);
    expect(handoffVencido(undefined)).toBe(false);
  });

  it("handoff reciente no vence", () => {
    const ahora = new Date();
    const hace5min = new Date(ahora.getTime() - 5 * 60 * 1000);
    expect(handoffVencido(hace5min, ahora)).toBe(false);
  });

  it("handoff de más de 15 minutos vence", () => {
    const ahora = new Date();
    const hace16min = new Date(ahora.getTime() - 16 * 60 * 1000);
    expect(handoffVencido(hace16min, ahora)).toBe(true);
  });

  it("exactamente 15 minutos vence", () => {
    const ahora = new Date();
    const hace15min = new Date(ahora.getTime() - HANDOFF_AUTO_EXPIRY_MS);
    expect(handoffVencido(hace15min, ahora)).toBe(true);
  });
});

describe("expirarHandoffSiCorresponde", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    filasHumanas.length = 0;
  });

  it("sin handoff no hace nada", async () => {
    const limpio = await expirarHandoffSiCorresponde(conversacion(null));
    expect(limpio).toBe(false);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("handoff reciente no se limpia", async () => {
    const hace5min = new Date(Date.now() - 5 * 60 * 1000);
    const limpio = await expirarHandoffSiCorresponde(conversacion(hace5min));
    expect(limpio).toBe(false);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("handoff vencido sin atención humana se limpia", async () => {
    const hace20min = new Date(Date.now() - 20 * 60 * 1000);
    const limpio = await expirarHandoffSiCorresponde(conversacion(hace20min));
    expect(limpio).toBe(true);
    expect(updateSet).toHaveBeenCalledWith({
      handoffAt: null,
      handoffReason: null,
      updatedAt: expect.any(Date),
    });
    expect(publish).toHaveBeenCalled();
  });

  it("handoff vencido CON atención humana NO se limpia", async () => {
    filasHumanas.push({ id: "msg_humano" });
    const hace20min = new Date(Date.now() - 20 * 60 * 1000);
    const limpio = await expirarHandoffSiCorresponde(conversacion(hace20min));
    expect(limpio).toBe(false);
    expect(updateSet).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
