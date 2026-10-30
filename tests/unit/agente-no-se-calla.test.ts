import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * 045 — El agente no se calla por un glitch de formato.
 *
 * Contrato bajo prueba (implementación en paralelo por el coordinador):
 * - `chatJson(schema, mensajes, { fallbackToRawReply?: boolean })`: tras
 *   agotar los 3 reintentos con error `invalid_output`, si la opción
 *   `fallbackToRawReply` está activa y el texto crudo del último intento
 *   califica (`textoCrudoSirveComoRespuesta`), intenta
 *   `schema.safeParse({ action: "reply", text: crudoTrimmed })`; si valida,
 *   retorna `{ ok: true, data, raw, recoveredFromRaw: true }`.
 * - `textoCrudoSirveComoRespuesta(raw)`: pura. false si el texto está
 *   vacío/solo espacios, si empieza con `{` o si contiene el fragmento
 *   `"action":` (pinta de JSON roto); true para texto plano normal.
 * - La opción viene apagada por defecto: sin ella el comportamiento es el
 *   de siempre (`invalid_output`, sin `recoveredFromRaw`).
 *
 * Patrones de mock (los de ai-adapter.test.ts para `chatJson`, y los de
 * monto-desde-confirmacion.test.ts para `registrarPedidoConfirmado`):
 * - `@/server/ai/credentials` parcial: la credencial de IA es `null`
 *   (se cae a las variables del entorno), sin tocar la BD.
 * - `fetch` global stubbeado: el proveedor se simula por intento.
 * - Para el hook de la 044: `@/lib/db` con builder thenable,
 *   `createLeadForContact` como `vi.fn()`, `fijarMontoLead` y
 *   `getBranding` mockeados (la llamada interna a `asegurarLeadDePedido`
 *   no se mockea: corre la real contra el mock de BD, igual que la 044).
 */

/** Control mutable del mock de `@/lib/db` (ver nota arriba). */
const ctlDb = {
  getDbLanza: false,
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

vi.mock("@/server/ai/credentials", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/server/ai/credentials")>();
  return {
    ...original,
    getAiCredentialSecret: async () => null,
    getAiCredentialPublic: async () => null,
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

import { chatJson, textoCrudoSirveComoRespuesta } from "@/lib/ai";
import {
  extraerTotalDeConfirmacion,
  registrarPedidoConfirmado,
} from "@/server/orders/order-pipeline";
import { createLeadForContact } from "@/server/inbox/lead-activity";
import { fijarMontoLead } from "@/server/leads/amount";
import { getBranding } from "@/server/branding";

/** Esquema del turno del agente, con tope de largo (caso 7). */
const esquemaTurno = z.object({
  action: z.literal("reply"),
  text: z.string().min(1).max(200),
});
type Turno = z.infer<typeof esquemaTurno>;

const MENSAJES = [{ role: "user", content: "Si hacer otro pedido" }] as const;

const BRANDING_CRC = {
  name: "Soda La Esquina",
  accent: "#0d5bff",
  currency: "CRC",
  favicon: null,
} as const;

function respuestaProveedor(contenido: string) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: contenido } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function fetchQueDevuelve(...contenidos: string[]) {
  const fetchMock = vi.fn();
  for (const c of contenidos) {
    fetchMock.mockResolvedValueOnce(respuestaProveedor(c));
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
  vi.stubEnv("DATABASE_URL", "postgresql://t:t@localhost:5432/t");
  vi.stubEnv("BETTER_AUTH_SECRET", "secret-de-test-suficiente");
  vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 3).toString("base64"));
  vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "verify-test");
  vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
  vi.stubEnv("OPENROUTER_MODEL", "modelo-test");

  // Mock de BD para el hook de la 044 (contacto no archivado + etapa
  // «Nuevo pedido»: asegurarLeadDePedido corre completo).
  ctlDb.getDbLanza = false;
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

describe("chatJson con fallbackToRawReply: true", () => {
  it("1. texto crudo plano tras invalid_output → se recupera como reply con el texto intacto y recoveredFromRaw: true", async () => {
    const crudo = "¡De una! ¿Qué le gustaría pedir?";
    const fetchMock = fetchQueDevuelve(crudo, crudo, crudo);

    const resultado = await chatJson<Turno>(
      esquemaTurno,
      [...MENSAJES],
      { fallbackToRawReply: true },
    );

    expect(fetchMock).toHaveBeenCalledTimes(3); // agotó los reintentos; el fallback no llama a la red
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) throw new Error("se esperaba recuperación");
    expect(resultado.data).toEqual({ action: "reply", text: crudo });
    expect(resultado.data.text).toBe(crudo); // el texto llega intacto
    expect(
      "recoveredFromRaw" in resultado && resultado.recoveredFromRaw,
    ).toBe(true);
  });

  it("2. crudo con fragmento \"action\": (JSON incompleto) → SIN recuperación, sigue invalid_output", async () => {
    const crudo = '{"action": "reply", "text": "hola"';
    const fetchMock = fetchQueDevuelve(crudo, crudo, crudo);

    const resultado = await chatJson<Turno>(
      esquemaTurno,
      [...MENSAJES],
      { fallbackToRawReply: true },
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(resultado.ok).toBe(false);
    if (resultado.ok) throw new Error("no se esperaba recuperación");
    expect(resultado.error).toBe("invalid_output");
    expect("recoveredFromRaw" in resultado).toBe(false);
  });

  it("3. crudo que empieza con { → SIN recuperación", async () => {
    const crudo = "{hola, no soy JSON válido";
    const fetchMock = fetchQueDevuelve(crudo, crudo, crudo);

    const resultado = await chatJson<Turno>(
      esquemaTurno,
      [...MENSAJES],
      { fallbackToRawReply: true },
    );

    expect(resultado.ok).toBe(false);
    if (resultado.ok) throw new Error("no se esperaba recuperación");
    expect(resultado.error).toBe("invalid_output");
    expect("recoveredFromRaw" in resultado).toBe(false);
  });

  it("4. crudo vacío / solo espacios → SIN recuperación", async () => {
    // Nota: el proveedor jamás devuelve cadena vacía (callProvider la
    // rechaza como «sin contenido»), así que el glitch real es un texto
    // de solo espacios, que sí viaja como content válido.
    const crudo = "   \n   ";
    const fetchMock = fetchQueDevuelve(crudo, crudo, crudo);

    const resultado = await chatJson<Turno>(
      esquemaTurno,
      [...MENSAJES],
      { fallbackToRawReply: true },
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(resultado.ok).toBe(false);
    if (resultado.ok) throw new Error("no se esperaba recuperación");
    expect(resultado.error).toBe("invalid_output");
    expect("recoveredFromRaw" in resultado).toBe(false);
  });

  it("5. error provider_error (500 persistente) → SIN intento de recuperación aunque la opción esté activa", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response("boom", { status: 500 })),
      );
    vi.stubGlobal("fetch", fetchMock);

    const resultado = await chatJson<Turno>(
      esquemaTurno,
      [...MENSAJES],
      { fallbackToRawReply: true },
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(resultado.ok).toBe(false);
    if (resultado.ok) throw new Error("no se esperaba recuperación");
    expect(resultado.error).toBe("provider_error");
    expect("recoveredFromRaw" in resultado).toBe(false);
  });

  it("6. opción apagada (default) con crudo plano → comportamiento idéntico al actual: invalid_output sin recoveredFromRaw", async () => {
    const crudo = "¡De una! ¿Qué le gustaría pedir?";
    const fetchMock = fetchQueDevuelve(crudo, crudo, crudo);

    const resultado = await chatJson<Turno>(esquemaTurno, [...MENSAJES]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(resultado.ok).toBe(false);
    if (resultado.ok) throw new Error("no se esperaba recuperación");
    expect(resultado.error).toBe("invalid_output");
    expect("recoveredFromRaw" in resultado).toBe(false);
  });

  it("7. crudo que excede el largo máximo del esquema → SIN recuperación (el safeParse lo rechaza)", async () => {
    const crudo = "x".repeat(300); // texto plano válido, pero > max(200)
    expect(textoCrudoSirveComoRespuesta(crudo)).toBe(true); // califica…
    const fetchMock = fetchQueDevuelve(crudo, crudo, crudo);

    const resultado = await chatJson<Turno>(
      esquemaTurno,
      [...MENSAJES],
      { fallbackToRawReply: true },
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // …pero el safeParse contra el esquema lo rechaza: no hay recuperación
    expect(resultado.ok).toBe(false);
    if (resultado.ok) throw new Error("no se esperaba recuperación");
    expect(resultado.error).toBe("invalid_output");
    expect("recoveredFromRaw" in resultado).toBe(false);
  });
});

describe("integración 045 → 044: el monto sale del texto recuperado", () => {
  it("8. texto recuperado con PEDIDO CONFIRMADO + «Total: ₡4.300» → extraerTotalDeConfirmacion da 4300 y registrarPedidoConfirmado fija 430000 centavos CRC", async () => {
    const confirmacion = [
      "PEDIDO CONFIRMADO",
      "Mesa: 8",
      "Cliente: Christian",
      "2x Casado con pollo",
      "Total: ₡4.300",
    ].join("\n");
    const fetchMock = fetchQueDevuelve(confirmacion, confirmacion, confirmacion);

    const resultado = await chatJson<Turno>(
      esquemaTurno,
      [...MENSAJES],
      { fallbackToRawReply: true },
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) throw new Error("se esperaba recuperación");
    const textoRecuperado = resultado.data.text;

    // el texto con marcador y línea Total califica para el fallback…
    expect(textoCrudoSirveComoRespuesta(textoRecuperado)).toBe(true);
    // …y el parser de la 044 extrae el monto del texto recuperado
    expect(extraerTotalDeConfirmacion(textoRecuperado)).toBe(4300);

    // punta a punta con el hook de la 044: el monto queda fijado
    await registrarPedidoConfirmado("org_1", "ct_1", textoRecuperado);
    expect(vi.mocked(fijarMontoLead)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fijarMontoLead)).toHaveBeenCalledWith(
      "org_1",
      "ct_1",
      430000, // 4300 colones en centavos
      "CRC",
    );
  });
});

describe("textoCrudoSirveComoRespuesta (función pura)", () => {
  it("9a. texto plano normal → true", () => {
    expect(
      textoCrudoSirveComoRespuesta("¡De una! ¿Qué le gustaría pedir?"),
    ).toBe(true);
  });

  it("9b. la palabra action sin comillas ni dos puntos («qué acción querés») → true", () => {
    expect(textoCrudoSirveComoRespuesta("¿qué acción querés?")).toBe(true);
  });

  it("9c. texto con espacios alrededor → true (se recorta)", () => {
    expect(textoCrudoSirveComoRespuesta("  ¡De una!  ")).toBe(true);
  });

  it("9d. fragmento \"action\": (JSON incompleto) → false", () => {
    expect(
      textoCrudoSirveComoRespuesta('{"action": "reply", "text": "hola"'),
    ).toBe(false);
  });

  it("9e. empieza con { → false", () => {
    expect(textoCrudoSirveComoRespuesta("{hola, no soy JSON")).toBe(false);
  });

  it("9f. vacío → false", () => {
    expect(textoCrudoSirveComoRespuesta("")).toBe(false);
  });

  it("9g. solo espacios → false", () => {
    expect(textoCrudoSirveComoRespuesta("   \n   ")).toBe(false);
  });
});
