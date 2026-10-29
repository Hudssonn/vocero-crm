import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 043 — Pedidos al pipeline solo confirmados.
 *
 * `accionTraePedidoConfirmado` es pura (sin BD). El resto usa el mock de
 * `@/lib/db` con un `select` encadenable y thenable (patrón de
 * ai-credentials.test.ts: los `await` sobre builders se resuelven con
 * `then: (resolve) => Promise.resolve(x).then(resolve)`); el camino con
 * BD se verifica en vivo en devapp (Principio IX).
 *
 * NOTA sobre el caso 4: `onLeadActivity` (real) importa
 * `esPipelineDePedidos` del módulo `@/server/orders/order-pipeline`, y
 * ese módulo importa `createLeadForContact` de `inbox/lead-activity`
 * (ciclo documentado en la nota de arquitectura del propio
 * order-pipeline.ts). Por ese ciclo, el `onLeadActivity` real se enlaza
 * al `esPipelineDePedidos` REAL: mockear el módulo no lo alcanza
 * (verificado: el mock recibía 0 llamadas). Así que el caso 4 ejercita
 * el `esPipelineDePedidos` real y lo gobierna con el mock de BD: la
 * `colaPipelineStage` entrega respuestas distintas al select de
 * detección y al de primera etapa, en orden.
 */

/** Control mutable del mock de `@/lib/db`. Los factories de `vi.mock`
 * se evalúan antes que el cuerpo del archivo, así que el factory solo
 * *cierra* sobre este objeto (como `filaExistente` en
 * ai-credentials.test.ts) y cada test lo muta después. */
const ctlDb = {
  /** Si true, `getDb()` lanza (BD caída). */
  getDbLanza: false,
  /** Filas que devuelve cada SELECT, según la tabla de su `from`. */
  filasPorTabla: {} as Record<string, Record<string, unknown>[]>,
  /** Llamadas a `update().set()` registradas: { tabla, valores }. */
  updates: [] as { tabla: string; valores: Record<string, unknown> }[],
  /** Llamadas a `insert().values()` registradas: { tabla, valores }. */
  inserts: [] as { tabla: string; valores: Record<string, unknown> }[],
  /**
   * Cola de respuestas para los SELECT a `pipelineStage` (se consumen en
   * orden con `shift`). El caso 4 necesita respuestas distintas para el
   * select de detección de `esPipelineDePedidos` y para el de primera
   * etapa de `createLeadForContact`; cuando está vacía, vale
   * `filasPorTabla.pipelineStage`.
   */
  colaPipelineStage: [] as Record<string, unknown>[][],
};

vi.mock("@/lib/db", () => {
  const schema = {
    lead: {
      id: "lead.id",
      organizationId: "lead.organization_id",
      contactId: "lead.contact_id",
      stageId: "lead.stage_id",
    },
    pipelineStage: {
      id: "pipeline_stage.id",
      organizationId: "pipeline_stage.organization_id",
      name: "pipeline_stage.name",
      kind: "pipeline_stage.kind",
    },
    contact: {
      id: "contact.id",
      archivedAt: "contact.archived_at",
    },
  };

  /** Builder encadenable y thenable: el `await` sobre cualquier eslabón
   * (`where`, `limit`, `orderBy`…) resuelve las filas de la tabla que
   * recibió el `from` (resuelta por identidad contra el schema
   * mockeado, no por alias de columnas). */
  function selectBuilder() {
    let tabla = "otra";
    const b = {
      from(t: unknown) {
        tabla =
          t === schema.lead
            ? "lead"
            : t === schema.pipelineStage
              ? "pipelineStage"
              : t === schema.contact
                ? "contact"
                : "otra";
        return b;
      },
      where() {
        return b;
      },
      limit() {
        return b;
      },
      orderBy() {
        return b;
      },
      offset() {
        return b;
      },
      groupBy() {
        return b;
      },
      then(resolve: (x: unknown) => void) {
        const filas =
          tabla === "pipelineStage" && ctlDb.colaPipelineStage.length > 0
            ? (ctlDb.colaPipelineStage.shift() ?? [])
            : (ctlDb.filasPorTabla[tabla] ?? []);
        return Promise.resolve(filas).then(resolve);
      },
    };
    return b;
  }

  return {
    getDb: () => {
      if (ctlDb.getDbLanza) throw new Error("bd caída (test)");
      return {
        select: () => selectBuilder(),
        insert: (t: unknown) => {
          const tabla = t === schema.lead ? "lead" : "otra";
          return {
            values: (v: unknown) => {
              const valores = v as Record<string, unknown>;
              ctlDb.inserts.push({ tabla, valores });
              return {
                onConflictDoNothing: () => ({
                  returning: () =>
                    Promise.resolve([
                      { id: valores.id, stageId: valores.stageId },
                    ]),
                }),
              };
            },
          };
        },
        update: (t: unknown) => {
          const tabla = t === schema.lead ? "lead" : "otra";
          const b = {
            set(v: unknown) {
              ctlDb.updates.push({
                tabla,
                valores: v as Record<string, unknown>,
              });
              return b;
            },
            where() {
              return {
                then(resolve: (x: unknown) => void) {
                  return Promise.resolve([]).then(resolve);
                },
              };
            },
          };
          return b;
        },
      };
    },
    schema,
  };
});

vi.mock("@/server/inbox/lead-activity", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/server/inbox/lead-activity")>();
  return { ...real, createLeadForContact: vi.fn() };
});

/** `recordLeadCreated` no toca la BD en estos tests: la creación real del
 * lead (caso 4b) se verifica por el INSERT registrado en el mock. */
vi.mock("@/server/leads/stage-history", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/server/leads/stage-history")>();
  return { ...real, recordLeadCreated: vi.fn().mockResolvedValue(undefined) };
});

import {
  accionTraePedidoConfirmado,
  asegurarLeadDePedido,
  esPipelineDePedidos,
} from "@/server/orders/order-pipeline";
import {
  createLeadForContact,
  onLeadActivity,
} from "@/server/inbox/lead-activity";
import { fijarMontoLead } from "@/server/leads/amount";

beforeAll(() => {
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.DATABASE_URL = "postgresql://t:t@localhost:5432/t";
  process.env.BETTER_AUTH_SECRET = "secret-de-test-suficiente";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.META_WEBHOOK_VERIFY_TOKEN = "verify-test";
});

beforeEach(() => {
  ctlDb.getDbLanza = false;
  ctlDb.filasPorTabla = {};
  ctlDb.updates = [];
  ctlDb.inserts = [];
  ctlDb.colaPipelineStage = [];
  vi.mocked(createLeadForContact).mockReset();
  vi.mocked(createLeadForContact).mockResolvedValue({
    id: "ld_x",
    stageId: "stg_nuevo",
  });
});

describe("accionTraePedidoConfirmado", () => {
  it("reply con texto que empieza con PEDIDO CONFIRMADO → true", () => {
    expect(
      accionTraePedidoConfirmado({
        action: "reply",
        text: "PEDIDO CONFIRMADO\n2x casado, 1x fresco de cas",
      }),
    ).toBe(true);
  });

  it("reply sin marcador → false", () => {
    expect(
      accionTraePedidoConfirmado({
        action: "reply",
        text: "Hola, ¿cuál es su pedido?",
      }),
    ).toBe(false);
  });

  it("update_lead con reply marcado → true", () => {
    expect(
      accionTraePedidoConfirmado({
        action: "update_lead",
        reply: "PEDIDO CONFIRMADO\n2x casado",
      }),
    ).toBe(true);
  });

  it("move_stage con reply marcado → true", () => {
    expect(
      accionTraePedidoConfirmado({
        action: "move_stage",
        reply: "PEDIDO CONFIRMADO\n1x perro caliente",
      }),
    ).toBe(true);
  });

  it("handoff con farewell marcado → true", () => {
    expect(
      accionTraePedidoConfirmado({
        action: "handoff",
        farewell: "PEDIDO CONFIRMADO\n3x Imperial",
      }),
    ).toBe(true);
  });

  it("none → false", () => {
    expect(accionTraePedidoConfirmado({ action: "none" })).toBe(false);
  });

  it("textos null/undefined → false", () => {
    expect(
      accionTraePedidoConfirmado({ action: "reply", text: null }),
    ).toBe(false);
    expect(accionTraePedidoConfirmado({ action: "reply" })).toBe(false);
    expect(
      accionTraePedidoConfirmado({ action: "update_lead", reply: null }),
    ).toBe(false);
    expect(
      accionTraePedidoConfirmado({ action: "handoff", farewell: null }),
    ).toBe(false);
    expect(accionTraePedidoConfirmado({ action: "handoff" })).toBe(false);
  });

  it("marcador no al inicio → false", () => {
    expect(
      accionTraePedidoConfirmado({
        action: "reply",
        reply: "hola PEDIDO CONFIRMADO",
      }),
    ).toBe(false);
  });
});

describe("esPipelineDePedidos", () => {
  it("etapa «Nuevo pedido» presente → true", async () => {
    ctlDb.filasPorTabla = {
      pipelineStage: [{ id: "stg_nuevo", name: "Nuevo pedido", kind: "open" }],
    };
    await expect(esPipelineDePedidos("org_1")).resolves.toBe(true);
  });

  it("sin etapas → false", async () => {
    ctlDb.filasPorTabla = { pipelineStage: [] };
    await expect(esPipelineDePedidos("org_1")).resolves.toBe(false);
  });

  it("si getDb lanza, resuelve false sin lanzar", async () => {
    ctlDb.getDbLanza = true;
    await expect(esPipelineDePedidos("org_1")).resolves.toBe(false);
  });
});

describe("asegurarLeadDePedido", () => {
  const ORG = "org_1";
  const CONTACTO = "ct_1";

  function dbConEtapa(nombreEtapa: string | null, archivado: boolean) {
    ctlDb.filasPorTabla = {
      contact: [{ archivedAt: archivado ? new Date() : null }],
      pipelineStage: nombreEtapa
        ? [{ id: "stg_nuevo", name: nombreEtapa, kind: "open" }]
        : [],
    };
  }

  it("(a) con etapa «Nuevo pedido» crea el lead en esa etapa, una sola vez", async () => {
    dbConEtapa("Nuevo pedido", false);
    await asegurarLeadDePedido(ORG, CONTACTO);
    expect(createLeadForContact).toHaveBeenCalledTimes(1);
    expect(createLeadForContact).toHaveBeenCalledWith({
      organizationId: ORG,
      contactId: CONTACTO,
      stageId: "stg_nuevo",
    });
  });

  it("(b) sin etapa «Nuevo pedido» crea el lead sin stageId", async () => {
    dbConEtapa(null, false);
    await asegurarLeadDePedido(ORG, CONTACTO);
    expect(createLeadForContact).toHaveBeenCalledTimes(1);
    expect(createLeadForContact).toHaveBeenCalledWith({
      organizationId: ORG,
      contactId: CONTACTO,
    });
  });

  it("(c) contacto archivado: no crea lead", async () => {
    dbConEtapa("Nuevo pedido", true);
    await asegurarLeadDePedido(ORG, CONTACTO);
    expect(createLeadForContact).not.toHaveBeenCalled();
  });

  it("(d) si crear el lead falla, resuelve sin lanzar", async () => {
    dbConEtapa("Nuevo pedido", false);
    vi.mocked(createLeadForContact).mockRejectedValueOnce(
      new Error("bd caída"),
    );
    await expect(asegurarLeadDePedido(ORG, CONTACTO)).resolves.toBeUndefined();
  });
});

describe("onLeadActivity en pipeline de pedidos", () => {
  const ORG = "org_1";
  const CONTACTO = "ct_1";
  const AHORA = new Date("2026-10-29T12:00:00.000Z");

  beforeEach(() => {
    // Sin lead existente para el contacto.
    ctlDb.filasPorTabla = { lead: [] };
    ctlDb.colaPipelineStage = [];
  });

  it("(a) pipeline de pedidos: no crea lead (nace solo al confirmar)", async () => {
    // El `esPipelineDePedidos` real ve la etapa «Nuevo pedido» → true.
    ctlDb.colaPipelineStage = [[{ id: "stg_nuevo", name: "Nuevo pedido" }]];
    await onLeadActivity(ORG, CONTACTO, AHORA);
    expect(ctlDb.inserts).toHaveLength(0);
  });

  it("(b) pipeline normal: crea el lead como siempre", async () => {
    // 1º select (detección de `esPipelineDePedidos`): sin «Nuevo pedido»
    // → false; 2º select (primera etapa abierta): existe → el lead nace ahí.
    ctlDb.colaPipelineStage = [[], [{ id: "stg_1" }]];
    await onLeadActivity(ORG, CONTACTO, AHORA);
    expect(ctlDb.inserts).toHaveLength(1);
    expect(ctlDb.inserts[0]?.tabla).toBe("lead");
    expect(ctlDb.inserts[0]?.valores).toMatchObject({
      organizationId: ORG,
      contactId: CONTACTO,
      stageId: "stg_1",
    });
  });
});

describe("fijarMontoLead", () => {
  it("sin lead: resuelve sin lanzar y sin UPDATE", async () => {
    ctlDb.filasPorTabla = { lead: [] };
    await expect(
      fijarMontoLead("org_1", "ct_1", 740000, "CRC"),
    ).resolves.toBeUndefined();
    expect(ctlDb.updates).toHaveLength(0);
  });
});
