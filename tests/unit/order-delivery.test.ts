import { describe, expect, it, vi } from "vitest";

/**
 * 039 — Duración de entrega de pedidos + hora del pedido al crearlo.
 *
 * Las dos funciones puras se prueban sin base de datos, como el resto de
 * bot-orders. El camino con BD de `createMenuOrder` se prueba con la base
 * simulada (patrón de agenda-context.test.ts: `vi.mock` + cadena
 * `select/from/where/orderBy/limit`): aquí NO hay BD de pruebas real en
 * la suite — bot-orders.test.ts lo dice explícito ("pruebas puras, sin
 * base de datos: el camino con BD se verifica en vivo en devapp") — así
 * que esta prueba fija el contrato (qué se le pasa a
 * `createLeadForContact`) y la verificación en vivo confirma el valor
 * guardado en devapp.
 */

const { getDb, createLeadForContact } = vi.hoisted(() => ({
  getDb: vi.fn(),
  createLeadForContact: vi.fn(),
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  return { ...original, getDb };
});

vi.mock("@/server/inbox/lead-activity", () => ({ createLeadForContact }));

vi.mock("@/server/inbox/identity", () => ({
  getOrCreateContactByIdentity: async () => ({
    contact: { id: "ct_pedido" },
  }),
}));

vi.mock("@/server/inbox/ingest", () => ({
  getOrCreateConversation: async () => ({ id: "cv_pedido" }),
}));

import { createMenuOrder } from "@/server/orders/service";
import {
  formatDeliveryDuration,
  latestDeliveryByLead,
} from "@/server/orders/order-text";

/** Cadena `select` que resuelve a `rows` venga por `orderBy` o por `limit`. */
function baseSelect(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "limit"]) {
    chain[m] = () => chain;
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    Promise.resolve(rows).then(resolve);
  return { select: () => chain };
}

const pedido = {
  orderId: "pedido-039",
  mesa: 4,
  paraLlevar: false,
  codigo: null,
  items: [{ nombre: "Casado con pollo", cantidad: 1, nota: null, extras: [] }],
  total: 3500,
};

describe("createMenuOrder pasa la hora del pedido", () => {
  it("createLeadForContact recibe at = ahora (no null)", async () => {
    // Sin etapas existentes: ensureOrderStages inserta las 4 y el
    // `returning` les da id; sin mensajes: se inserta el del pedido.
    getDb.mockReturnValue({
      ...baseSelect([]),
      insert: () => ({
        values: () => ({
          returning: async () => [{ id: "stage_nuevo" }],
        }),
      }),
    });
    createLeadForContact.mockResolvedValue({
      id: "lead_1",
      stageId: "stage_nuevo",
    });

    const antes = Date.now();
    const resultado = await createMenuOrder("org_1", pedido);
    const despues = Date.now();

    expect(resultado.duplicate).toBe(false);
    expect(resultado.leadId).toBe("lead_1");
    const llamada = createLeadForContact.mock.calls[0];
    expect(llamada).toBeDefined();
    const input = llamada![0];
    expect(input.contactId).toBe("ct_pedido");
    expect(input.stageId).toBe("stage_nuevo");
    expect(input.at).toBeInstanceOf(Date);
    expect(input.at.getTime()).toBeGreaterThanOrEqual(antes);
    expect(input.at.getTime()).toBeLessThanOrEqual(despues);
  });
});

describe("formatDeliveryDuration", () => {
  const pedidoA = new Date("2026-10-28T12:00:00.000Z");
  it("menos de 60 min: solo minutos", () => {
    expect(
      formatDeliveryDuration(pedidoA, new Date("2026-10-28T12:23:00.000Z")),
    ).toBe("23 min");
  });
  it("60 o más: horas y minutos a dos dígitos", () => {
    expect(
      formatDeliveryDuration(pedidoA, new Date("2026-10-28T13:05:00.000Z")),
    ).toBe("1 h 05 min");
    expect(
      formatDeliveryDuration(pedidoA, new Date("2026-10-28T13:00:00.000Z")),
    ).toBe("1 h 00 min");
    expect(
      formatDeliveryDuration(pedidoA, new Date("2026-10-28T14:05:00.000Z")),
    ).toBe("2 h 05 min");
  });
  it("59 min no salta a horas", () => {
    expect(
      formatDeliveryDuration(pedidoA, new Date("2026-10-28T12:59:00.000Z")),
    ).toBe("59 min");
  });
  it("segundos de más se truncan, no se redondean", () => {
    expect(
      formatDeliveryDuration(pedidoA, new Date("2026-10-28T12:23:59.000Z")),
    ).toBe("23 min");
  });
  it("duración 0 → 0 min", () => {
    expect(formatDeliveryDuration(pedidoA, pedidoA)).toBe("0 min");
  });
  it("duración negativa (reloj) se limita a 0", () => {
    expect(
      formatDeliveryDuration(pedidoA, new Date("2026-10-28T11:50:00.000Z")),
    ).toBe("0 min");
  });
});

describe("latestDeliveryByLead", () => {
  const leads = [
    { id: "lead_1", stageId: "stage_entregado" },
    { id: "lead_2", stageId: "stage_entregado" },
  ];
  it("gana el evento más reciente hacia la etapa actual", () => {
    const mapa = latestDeliveryByLead(
      [
        {
          leadId: "lead_1",
          toStageId: "stage_entregado",
          occurredAt: new Date("2026-10-28T12:20:00.000Z"),
        },
        {
          leadId: "lead_1",
          toStageId: "stage_entregado",
          occurredAt: new Date("2026-10-28T12:45:00.000Z"),
        },
      ],
      leads,
    );
    expect(mapa.get("lead_1")?.toISOString()).toBe(
      "2026-10-28T12:45:00.000Z",
    );
  });
  it("el evento de creación (hacia Nuevo pedido) no interfiere", () => {
    const mapa = latestDeliveryByLead(
      [
        {
          leadId: "lead_1",
          toStageId: "stage_nuevo",
          occurredAt: new Date("2026-10-28T12:00:00.000Z"),
        },
        {
          leadId: "lead_1",
          toStageId: "stage_entregado",
          occurredAt: new Date("2026-10-28T12:30:00.000Z"),
        },
      ],
      leads,
    );
    expect(mapa.get("lead_1")?.toISOString()).toBe(
      "2026-10-28T12:30:00.000Z",
    );
  });
  it("sin evento hacia la etapa actual no hay entrega", () => {
    const mapa = latestDeliveryByLead(
      [
        {
          leadId: "lead_1",
          toStageId: "stage_nuevo",
          occurredAt: new Date("2026-10-28T12:00:00.000Z"),
        },
      ],
      leads,
    );
    expect(mapa.has("lead_1")).toBe(false);
  });
  it("los eventos de otros leads no se mezclan", () => {
    const mapa = latestDeliveryByLead(
      [
        {
          leadId: "lead_2",
          toStageId: "stage_entregado",
          occurredAt: new Date("2026-10-28T12:40:00.000Z"),
        },
      ],
      leads,
    );
    expect(mapa.has("lead_1")).toBe(false);
    expect(mapa.get("lead_2")?.toISOString()).toBe(
      "2026-10-28T12:40:00.000Z",
    );
  });
  it("evento sin etapa destino se ignora", () => {
    const mapa = latestDeliveryByLead(
      [
        {
          leadId: "lead_1",
          toStageId: null,
          occurredAt: new Date("2026-10-28T12:40:00.000Z"),
        },
      ],
      leads,
    );
    expect(mapa.has("lead_1")).toBe(false);
  });
  it("en empate de hora gana el primero que llegó", () => {
    const hora = new Date("2026-10-28T12:40:00.000Z");
    const mapa = latestDeliveryByLead(
      [
        { leadId: "lead_1", toStageId: "stage_entregado", occurredAt: hora },
        { leadId: "lead_1", toStageId: "stage_entregado", occurredAt: hora },
      ],
      leads,
    );
    expect(mapa.get("lead_1")).toBe(hora);
  });
});
