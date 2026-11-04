import { beforeEach, describe, expect, it, vi } from "vitest";
import { expirarHandoffSiCorresponde } from "@/server/ai/pipeline";

/**
 * BUG 2 (2026-11-04): la expiración del handoff limpiaba `handoff_at` pero no
 * restauraba `ai_enabled`. Los traspasos `manual_reply`, `pasarAHumano` y
 * `POST /api/bot/handoff` apagan la IA, así que al vencer los 15 minutos el
 * agente quedaba apagado para siempre en esa conversación y nunca volvía a
 * contestar.
 *
 * El fix: al expirar, `expirarHandoffSiCorresponde` también setea
 * `ai_enabled = true` (el valor previo no se guarda en ningún campo; `true`
 * es lo mismo que usa la reactivación manual de la bandeja).
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

function conversacionVencida() {
  return {
    id: "cv_bug2",
    organizationId: "org_test",
    handoffAt: new Date(Date.now() - 20 * 60 * 1000),
  };
}

describe("expiración del handoff reactiva la IA (BUG 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    filasHumanas.length = 0;
  });

  it("handoff vencido con IA apagada (manual_reply) la reactiva al expirar", async () => {
    // Este es el caso del bug: la conversación tenía ai_enabled = false por
    // el traspaso manual y nadie atendió en 15+ minutos.
    const limpio = await expirarHandoffSiCorresponde(conversacionVencida());
    expect(limpio).toBe(true);
    // Antes del fix el set no incluía aiEnabled y el agente quedaba apagado
    // para siempre.
    expect(updateSet).toHaveBeenCalledWith({
      handoffAt: null,
      handoffReason: null,
      aiEnabled: true,
      updatedAt: expect.any(Date),
    });
    expect(publish).toHaveBeenCalled();
  });

  it("handoff vencido con atención humana NO toca ai_enabled", async () => {
    filasHumanas.push({ id: "msg_humano" });
    const limpio = await expirarHandoffSiCorresponde(conversacionVencida());
    expect(limpio).toBe(false);
    expect(updateSet).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
