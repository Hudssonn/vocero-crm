import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 044 — Monto del pedido desde la confirmación.
 *
 * `extraerTotalDeConfirmacion` y `textoPedidoConfirmado` son puras (sin
 * BD). `registrarPedidoConfirmado` se ejercita con el mock de `@/lib/db`
 * (los dos SELECT de `asegurarLeadDePedido` se gobiernan con una cola) y
 * con `fijarMontoLead` espiado; la creación real del lead queda mockeada
 * en `createLeadForContact`. El camino con BD se verifica en vivo en
 * devapp (Principio IX).
 */

type FilaSelect = Record<string, unknown>;

/** Control mutable del mock de `@/lib/db`. Los factories de `vi.mock`
 * se evalúan antes que el cuerpo del archivo, así que el factory solo
 * *cierra* sobre este objeto y cada test lo muta después. */
const ctlDb = {
  /** Si true, `getDb()` lanza (BD caída). */
  getDbLanza: false,
  /** Respuestas de cada SELECT, en el orden en que se ejecutan. */
  selectCola: [] as FilaSelect[][],
};

type BuilderSelect = {
  from(t: unknown): BuilderSelect;
  where(...args: unknown[]): BuilderSelect;
  limit(n: number): BuilderSelect;
  then(resolve: (x: unknown) => void): Promise<unknown>;
};

vi.mock("@/lib/db", () => {
  // Placeholders de columna: el builder mockeado ignora el `where`, pero
  // `scoped()` (real) exige objetos no nulos para armar el `eq`.
  const schema = {
    lead: {
      id: "lead.id",
      organizationId: "lead.organization_id",
      contactId: "lead.contact_id",
    },
    pipelineStage: {
      id: "pipeline_stage.id",
      organizationId: "pipeline_stage.organization_id",
      name: "pipeline_stage.name",
    },
    contact: {
      id: "contact.id",
      organizationId: "contact.organization_id",
      archivedAt: "contact.archived_at",
    },
  };
  function builder(filas: FilaSelect[]): BuilderSelect {
    const b: BuilderSelect = {
      from: () => b,
      where: () => b,
      limit: () => b,
      then: (resolve) => Promise.resolve(filas).then(resolve),
    };
    return b;
  }
  return {
    getDb: () => {
      if (ctlDb.getDbLanza) throw new Error("bd caída (test)");
      return { select: () => builder(ctlDb.selectCola.shift() ?? []) };
    },
    schema,
  };
});

vi.mock("@/server/inbox/lead-activity", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/server/inbox/lead-activity")>();
  return {
    ...real,
    createLeadForContact: vi.fn().mockResolvedValue({
      id: "ld_test",
      stageId: "stg_nuevo",
    }),
  };
});

vi.mock("@/server/branding", () => ({
  getBranding: vi.fn().mockResolvedValue({ currency: "CRC" }),
}));

vi.mock("@/server/leads/amount", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/server/leads/amount")>();
  return { ...real, fijarMontoLead: vi.fn().mockResolvedValue(undefined) };
});

import {
  accionTraePedidoConfirmado,
  extraerTotalDeConfirmacion,
  registrarPedidoConfirmado,
  textoPedidoConfirmado,
} from "@/server/orders/order-pipeline";
import { createLeadForContact } from "@/server/inbox/lead-activity";
import { fijarMontoLead } from "@/server/leads/amount";
import type { AgentActionType } from "@/server/ai/actions";

/** Confirmación típica del agente (formato 041), caso real 2026-10-29. */
const CONFIRMACION_REAL = `PEDIDO CONFIRMADO
MESA 8
Christian
- 1 Casado con pollo
- 1 Jugo de naranja
Total: ₡4.300`;

beforeEach(() => {
  ctlDb.getDbLanza = false;
  ctlDb.selectCola = [];
  vi.mocked(createLeadForContact).mockClear();
  vi.mocked(fijarMontoLead).mockClear();
});

describe("extraerTotalDeConfirmacion", () => {
  it("extrae el total del caso real (₡4.300 → 4300 colones)", () => {
    expect(extraerTotalDeConfirmacion(CONFIRMACION_REAL)).toBe(4300);
  });

  it("tolera sin símbolo ₡ y sin separadores de miles", () => {
    expect(
      extraerTotalDeConfirmacion("PEDIDO CONFIRMADO\nTotal: 9500"),
    ).toBe(9500);
  });

  it("con punto y coma el punto es miles y la coma decimal", () => {
    expect(
      extraerTotalDeConfirmacion("PEDIDO CONFIRMADO\nTotal: ₡4.300,50"),
    ).toBe(4300.5);
  });

  it("con solo coma la coma es decimal", () => {
    expect(
      extraerTotalDeConfirmacion("PEDIDO CONFIRMADO\nTotal: ₡4,50"),
    ).toBe(4.5);
  });

  it("tolera espacios extra y minúsculas", () => {
    expect(
      extraerTotalDeConfirmacion("PEDIDO CONFIRMADO\n  total:   ₡  12.000  "),
    ).toBe(12000);
  });

  it("sin marcador devuelve null aunque haya Total:", () => {
    expect(extraerTotalDeConfirmacion("Hola\nTotal: ₡4.300")).toBeNull();
  });

  it("con marcador pero sin línea Total: devuelve null (nunca inventa)", () => {
    expect(
      extraerTotalDeConfirmacion("PEDIDO CONFIRMADO\n- 1 Casado"),
    ).toBeNull();
  });

  it("con línea Total: que no parsea devuelve null", () => {
    expect(
      extraerTotalDeConfirmacion("PEDIDO CONFIRMADO\nTotal: mucho dinero"),
    ).toBeNull();
  });
});

describe("textoPedidoConfirmado", () => {
  it("reply → text", () => {
    const action: AgentActionType = {
      action: "reply",
      text: CONFIRMACION_REAL,
    };
    expect(textoPedidoConfirmado(action)).toBe(CONFIRMACION_REAL);
  });

  it("update_lead → reply", () => {
    const action: AgentActionType = {
      action: "update_lead",
      note: "pedido confirmado",
      reply: CONFIRMACION_REAL,
    };
    expect(textoPedidoConfirmado(action)).toBe(CONFIRMACION_REAL);
  });

  it("move_stage → reply", () => {
    const action: AgentActionType = {
      action: "move_stage",
      stage: "Nuevo pedido",
      reply: CONFIRMACION_REAL,
    };
    expect(textoPedidoConfirmado(action)).toBe(CONFIRMACION_REAL);
  });

  it("handoff → farewell", () => {
    const action: AgentActionType = {
      action: "handoff",
      farewell: CONFIRMACION_REAL,
    };
    expect(textoPedidoConfirmado(action)).toBe(CONFIRMACION_REAL);
  });

  it("resto de acciones → null", () => {
    expect(textoPedidoConfirmado({ action: "none" })).toBeNull();
    expect(
      textoPedidoConfirmado({ action: "offer_slots", reply: "x" }),
    ).toBeNull();
  });

  it("texto sin marcador → null", () => {
    const action: AgentActionType = { action: "reply", text: "Hola" };
    expect(textoPedidoConfirmado(action)).toBeNull();
  });
});

describe("accionTraePedidoConfirmado (compatibilidad 043)", () => {
  it("sigue respondiendo boolean con la firma suelta", () => {
    expect(
      accionTraePedidoConfirmado({ action: "reply", text: CONFIRMACION_REAL }),
    ).toBe(true);
    expect(accionTraePedidoConfirmado({ action: "none" })).toBe(false);
    expect(
      accionTraePedidoConfirmado({ action: "handoff", farewell: null }),
    ).toBe(false);
  });
});

describe("registrarPedidoConfirmado", () => {
  /** Dos SELECT de `asegurarLeadDePedido`: contacto no archivado y la
   * etapa «Nuevo pedido». */
  function colaLeadOk() {
    ctlDb.selectCola = [[{ archivedAt: null }], [{ id: "stg_nuevo" }]];
  }

  it("caso real: sin amount explícito, fija el monto del texto (₡4.300 → 430000 centavos)", async () => {
    colaLeadOk();
    await registrarPedidoConfirmado("org_1", "ct_1", CONFIRMACION_REAL);
    expect(createLeadForContact).toHaveBeenCalledTimes(1);
    expect(fijarMontoLead).toHaveBeenCalledTimes(1);
    expect(fijarMontoLead).toHaveBeenCalledWith(
      "org_1",
      "ct_1",
      430000,
      "CRC",
    );
  });

  it("el amount explícito gana sobre el texto", async () => {
    colaLeadOk();
    await registrarPedidoConfirmado(
      "org_1",
      "ct_1",
      CONFIRMACION_REAL,
      9500,
    );
    expect(fijarMontoLead).toHaveBeenCalledWith(
      "org_1",
      "ct_1",
      950000,
      "CRC",
    );
  });

  it("sin monto en ninguna fuente: asegura el lead pero no escribe monto", async () => {
    colaLeadOk();
    await registrarPedidoConfirmado(
      "org_1",
      "ct_1",
      "PEDIDO CONFIRMADO\n- 1 Casado",
    );
    expect(createLeadForContact).toHaveBeenCalledTimes(1);
    expect(fijarMontoLead).not.toHaveBeenCalled();
  });

  it("un amount explícito inválido (negativo) cae al texto", async () => {
    colaLeadOk();
    await registrarPedidoConfirmado("org_1", "ct_1", CONFIRMACION_REAL, -5);
    expect(fijarMontoLead).toHaveBeenCalledWith(
      "org_1",
      "ct_1",
      430000,
      "CRC",
    );
  });

  it("contacto inexistente: no crea lead; el monto se intenta pero el real haría no-op", async () => {
    ctlDb.selectCola = [];
    // Sin filas: el contacto no existe → asegurarLeadDePedido retorna
    // sin crear; nada debe lanzar. `fijarMontoLead` (real) no escribe sin
    // lead; aquí solo se verifica que se le delega el monto del texto.
    await expect(
      registrarPedidoConfirmado("org_1", "ct_1", CONFIRMACION_REAL),
    ).resolves.toBeUndefined();
    expect(createLeadForContact).not.toHaveBeenCalled();
    expect(fijarMontoLead).toHaveBeenCalledWith(
      "org_1",
      "ct_1",
      430000,
      "CRC",
    );
  });

  it("nunca lanza aunque la BD falle al asegurar el lead", async () => {
    ctlDb.getDbLanza = true;
    // `asegurarLeadDePedido` traga el fallo de BD en su propio try/catch
    // y `registrarPedidoConfirmado` sigue: el monto explícito se delega
    // igual (`fijarMontoLead` real tampoco lanza).
    await expect(
      registrarPedidoConfirmado("org_1", "ct_1", CONFIRMACION_REAL, 100),
    ).resolves.toBeUndefined();
    expect(createLeadForContact).not.toHaveBeenCalled();
    expect(fijarMontoLead).toHaveBeenCalledWith("org_1", "ct_1", 10000, "CRC");
  });
});
