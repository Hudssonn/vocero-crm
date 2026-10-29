import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 044 — Monto del pedido desde la confirmación (monto determinístico).
 *
 * Contrato bajo prueba (implementación en paralelo por el coordinador):
 * - `extraerTotalDeConfirmacion(texto)`: pura. `null` si el texto no trae
 *   el marcador `PEDIDO CONFIRMADO`; si lo trae, parsea la línea `Total:`
 *   (tolerando con/sin `₡` y espacios) con normalización tica: `.` y `,`
 *   → el punto es miles (`4.300,50` → 4300.50); solo `,` → decimal; solo
 *   `.` → miles. Sin línea Total o con basura → `null`.
 * - `registrarPedidoConfirmado(org, contacto, texto, amountExplicito?)`:
 *   asegura el lead (vía `asegurarLeadDePedido`, idempotente), determina el
 *   monto en colones (prioridad: `amountExplicito` si es número finito ≥ 0,
 *   si no lo parseado del texto) y, si hay monto, lo fija con
 *   `fijarMontoLead(org, contacto, colonesACentavos(monto), currency de
 *   getBranding)`. Nunca lanza.
 *
 * Patrones de mock (los de pedidos-solo-confirmados.test.ts):
 * - `@/lib/db` mockeado con un `select` encadenable y thenable; el factory
 *   solo cierra sobre `ctlDb`, que cada test muta después.
 * - `@/server/inbox/lead-activity` parcial: solo `createLeadForContact`
 *   es `vi.fn()`.
 *
 * NOTA sobre `asegurarLeadDePedido`: vive en el MISMO módulo que
 * `registrarPedidoConfirmado` (`order-pipeline.ts`), así que un mock del
 * módulo no intercepta la llamada interna (los enlaces ESM internos usan
 * el símbolo local, no el exportado). Por eso NO se mockea: corre la real
 * contra el mock de BD y se la observa por su único efecto, el
 * `createLeadForContact` mockeado — igual que el test de la 043 la
 * ejercita. `fijarMontoLead` y `getBranding` sí están en otros módulos y
 * se mockean con parciales (`{...real, fn: vi.fn()}`).
 *
 * NOTA del ciclo ESM (de la 043): `order-pipeline` ↔ `lead-activity` se
 * importan mutuamente, pero los símbolos solo se usan dentro de cuerpos
 * de función, así que el ciclo es seguro.
 */

/** Control mutable del mock de `@/lib/db` (ver nota arriba). */
const ctlDb = {
  /** Si true, `getDb()` lanza (BD caída). */
  getDbLanza: false,
  /** Filas que devuelve cada SELECT, según la tabla de su `from`. */
  filasPorTabla: {} as Record<string, Record<string, unknown>[]>,
};

vi.mock("@/lib/db", () => {
  const schema = {
    contact: {
      id: "contact.id",
      organizationId: "contact.organization_id",
      archivedAt: "contact.archived_at",
    },
    pipelineStage: {
      id: "pipeline_stage.id",
      organizationId: "pipeline_stage.organization_id",
      name: "pipeline_stage.name",
      kind: "pipeline_stage.kind",
    },
  };

  /** Builder encadenable y thenable: el `await` sobre cualquier eslabón
   * resuelve las filas de la tabla que recibió el `from`. */
  function selectBuilder() {
    let tabla = "otra";
    const b = {
      from(t: unknown) {
        tabla =
          t === schema.contact
            ? "contact"
            : t === schema.pipelineStage
              ? "pipelineStage"
              : "otra";
        return b;
      },
      where() {
        return b;
      },
      limit() {
        return b;
      },
      then(resolve: (x: unknown) => void) {
        return Promise.resolve(ctlDb.filasPorTabla[tabla] ?? []).then(
          resolve,
        );
      },
    };
    return b;
  }

  return {
    getDb: () => {
      if (ctlDb.getDbLanza) throw new Error("bd caída (test)");
      return { select: () => selectBuilder() };
    },
    schema,
  };
});

vi.mock("@/server/inbox/lead-activity", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/server/inbox/lead-activity")>();
  return { ...real, createLeadForContact: vi.fn() };
});

vi.mock("@/server/leads/amount", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/leads/amount")>();
  return { ...real, fijarMontoLead: vi.fn() };
});

vi.mock("@/server/branding", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/branding")>();
  return { ...real, getBranding: vi.fn() };
});

import {
  accionTraePedidoConfirmado,
  extraerTotalDeConfirmacion,
  registrarPedidoConfirmado,
} from "@/server/orders/order-pipeline";
import { createLeadForContact } from "@/server/inbox/lead-activity";
import { fijarMontoLead } from "@/server/leads/amount";
import { getBranding } from "@/server/branding";

const BRANDING_CRC = {
  name: "Soda La Esquina",
  accent: "#0d5bff",
  currency: "CRC",
  favicon: null,
} as const;

beforeAll(() => {
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.DATABASE_URL = "postgresql://t:t@localhost:5432/t";
  process.env.BETTER_AUTH_SECRET = "secret-de-test-suficiente";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.META_WEBHOOK_VERIFY_TOKEN = "verify-test";
});

beforeEach(() => {
  ctlDb.getDbLanza = false;
  // Contacto no archivado + etapa «Nuevo pedido»: `asegurarLeadDePedido`
  // corre completo y llama al `createLeadForContact` mockeado.
  ctlDb.filasPorTabla = {
    contact: [{ archivedAt: null }],
    pipelineStage: [{ id: "stg_nuevo", name: "Nuevo pedido", kind: "open" }],
  };
  vi.mocked(createLeadForContact).mockReset();
  vi.mocked(createLeadForContact).mockResolvedValue({
    id: "ld_x",
    stageId: "stg_nuevo",
  });
  vi.mocked(fijarMontoLead).mockReset();
  vi.mocked(getBranding).mockReset();
  vi.mocked(getBranding).mockResolvedValue(BRANDING_CRC);
});

/**
 * Texto de prueba con el formato real de la 041: primera línea el
 * marcador, líneas MESA/Cliente/platos/Pago y `Total: ₡X` como última.
 */
function confirmacion(lineaTotal: string | null): string {
  const lineas = [
    "PEDIDO CONFIRMADO",
    "Mesa: 8",
    "Cliente: Christian",
    "2x Casado con pollo",
    "1x Fresco de cas",
    "Pago: SINPE",
  ];
  if (lineaTotal !== null) lineas.push(lineaTotal);
  return lineas.join("\n");
}

describe("extraerTotalDeConfirmacion", () => {
  it("marcador + «Total: ₡4.300» → 4300", () => {
    expect(extraerTotalDeConfirmacion(confirmacion("Total: ₡4.300"))).toBe(
      4300,
    );
  });

  it("marcador + «Total: ₡9.500» → 9500", () => {
    expect(extraerTotalDeConfirmacion(confirmacion("Total: ₡9.500"))).toBe(
      9500,
    );
  });

  it("marcador + «Total: ₡4.300,50» → 4300.50 (punto miles, coma decimal)", () => {
    expect(extraerTotalDeConfirmacion(confirmacion("Total: ₡4.300,50"))).toBe(
      4300.5,
    );
  });

  it("sin símbolo ₡ («Total: 4300») → 4300", () => {
    expect(extraerTotalDeConfirmacion(confirmacion("Total: 4300"))).toBe(4300);
  });

  it("tolera espacios de más («Total:   ₡ 9.500») → 9500", () => {
    expect(
      extraerTotalDeConfirmacion(confirmacion("Total:   ₡ 9.500")),
    ).toBe(9500);
  });

  it("con marcador pero sin línea Total → null", () => {
    expect(extraerTotalDeConfirmacion(confirmacion(null))).toBeNull();
  });

  it("texto SIN marcador (aunque tenga «Total: ₡4.300») → null", () => {
    expect(
      extraerTotalDeConfirmacion(
        "Hola, ¿cuál es su pedido?\nTotal: ₡4.300",
      ),
    ).toBeNull();
  });

  it("«Total:» con basura («Total: abc») → null", () => {
    expect(extraerTotalDeConfirmacion(confirmacion("Total: abc"))).toBeNull();
  });

  it("texto vacío → null", () => {
    expect(extraerTotalDeConfirmacion("")).toBeNull();
  });
});

describe("registrarPedidoConfirmado", () => {
  const ORG = "org_1";
  const CONTACTO = "ct_1";
  const TEXTO_4300 = confirmacion("Total: ₡4.300");
  const TEXTO_9500 = confirmacion("Total: ₡9.500");

  it("con amountExplicito válido y texto con Total distinto: gana el explícito", async () => {
    await registrarPedidoConfirmado(ORG, CONTACTO, TEXTO_9500, 4300);
    expect(fijarMontoLead).toHaveBeenCalledTimes(1);
    expect(fijarMontoLead).toHaveBeenCalledWith(ORG, CONTACTO, 430000, "CRC");
    // El lead se aseguró igual (el `createLeadForContact` mockeado es el
    // efecto observable del `asegurarLeadDePedido` real).
    expect(createLeadForContact).toHaveBeenCalledTimes(1);
    expect(getBranding).toHaveBeenCalledWith(ORG);
  });

  it("sin explícito y texto con «Total: ₡4.300» → fija 430000", async () => {
    await registrarPedidoConfirmado(ORG, CONTACTO, TEXTO_4300);
    expect(fijarMontoLead).toHaveBeenCalledTimes(1);
    expect(fijarMontoLead).toHaveBeenCalledWith(ORG, CONTACTO, 430000, "CRC");
    expect(createLeadForContact).toHaveBeenCalledTimes(1);
  });

  it("sin explícito y texto sin Total parseable: no fija monto pero SÍ asegura el lead", async () => {
    await registrarPedidoConfirmado(ORG, CONTACTO, confirmacion(null));
    expect(fijarMontoLead).not.toHaveBeenCalled();
    expect(createLeadForContact).toHaveBeenCalledTimes(1);
  });

  it("amountExplicito NaN → usa el parseado del texto", async () => {
    await registrarPedidoConfirmado(ORG, CONTACTO, TEXTO_4300, NaN);
    expect(fijarMontoLead).toHaveBeenCalledTimes(1);
    expect(fijarMontoLead).toHaveBeenCalledWith(ORG, CONTACTO, 430000, "CRC");
  });

  it("amountExplicito negativo → usa el parseado del texto", async () => {
    await registrarPedidoConfirmado(ORG, CONTACTO, TEXTO_4300, -100);
    expect(fijarMontoLead).toHaveBeenCalledTimes(1);
    expect(fijarMontoLead).toHaveBeenCalledWith(ORG, CONTACTO, 430000, "CRC");
  });

  it("amountExplicito 0 (finito ≥ 0) → se respeta: fija 0 centavos", async () => {
    await registrarPedidoConfirmado(ORG, CONTACTO, TEXTO_4300, 0);
    expect(fijarMontoLead).toHaveBeenCalledTimes(1);
    expect(fijarMontoLead).toHaveBeenCalledWith(ORG, CONTACTO, 0, "CRC");
  });

  it("si getBranding falla, nunca lanza", async () => {
    vi.mocked(getBranding).mockRejectedValueOnce(new Error("bd caída"));
    await expect(
      registrarPedidoConfirmado(ORG, CONTACTO, TEXTO_4300),
    ).resolves.toBeUndefined();
  });

  it("si la BD está caída, nunca lanza", async () => {
    ctlDb.getDbLanza = true;
    await expect(
      registrarPedidoConfirmado(ORG, CONTACTO, TEXTO_4300, 4300),
    ).resolves.toBeUndefined();
  });
});

describe("integración del hook (acción update_lead)", () => {
  const ORG = "org_1";
  const CONTACTO = "ct_1";

  it("update_lead con marcador en el reply y amount explícito: el monto fijado sale del explícito", async () => {
    const accion = {
      action: "update_lead",
      reply: confirmacion("Total: ₡4.300"),
      amount: 4300,
    };
    // Lo que el hook hace: detecta el marcador y delega en
    // `registrarPedidoConfirmado` con el texto y el amount.
    expect(accionTraePedidoConfirmado(accion)).toBe(true);
    await registrarPedidoConfirmado(ORG, CONTACTO, accion.reply, accion.amount);

    expect(fijarMontoLead).toHaveBeenCalledTimes(1);
    expect(fijarMontoLead).toHaveBeenCalledWith(ORG, CONTACTO, 430000, "CRC");
    expect(createLeadForContact).toHaveBeenCalledTimes(1);
  });

  it("doble confirmación: fijarMontoLead recibe siempre el mismo valor derivado del explícito (sin escrituras en conflicto)", async () => {
    await registrarPedidoConfirmado(
      ORG,
      CONTACTO,
      confirmacion("Total: ₡4.300"),
      4300,
    );
    // Segunda confirmación cuyo texto dice otro total: el explícito manda.
    await registrarPedidoConfirmado(
      ORG,
      CONTACTO,
      confirmacion("Total: ₡9.500"),
      4300,
    );
    const llamadas = vi.mocked(fijarMontoLead).mock.calls;
    expect(llamadas).toHaveLength(2);
    for (const llamada of llamadas) {
      expect(llamada[2]).toBe(430000);
    }
  });
});
