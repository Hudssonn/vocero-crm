import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  calcularSubtotalColones,
  calcularTotalColones,
  construirTextoPedidoVoz,
  identidadContactoVoz,
  procesarPedidoDeVoz,
  resolverExtra,
  resolverPlato,
  telefonoVozValido,
  validarPedidoVoz,
  type LlamadaVozParaPedido,
  type PedidoVozExtraido,
  type PedidoVozValidado,
} from "@/server/voice/voice-order";

/**
 * 050 — Pedido por voz → pantalla de cocina.
 *
 * Puras (builder, validación, recálculo) sin BD. `procesarPedidoDeVoz` se
 * ejercita con dependencias inyectadas (modelo y persistencia falsos): el
 * camino con BD real se verifica en vivo en devapp (Principio IX). El
 * nodo Normalizar del puente n8n se prueba ejecutando su `jsCode` contra
 * un payload con la forma real del webhook de ElevenLabs.
 */

const EXTRACCION_VALIDA: PedidoVozExtraido = {
  items: [
    { nombre: "Casado con pollo", cantidad: 2, nota: "sin cebolla", extras: [] },
    { nombre: "Fresco de cas", cantidad: 1, nota: null, extras: [] },
  ],
  total_colones: 8200,
  tipo: "local",
  mesa: 4,
  direccion: null,
  zona: null,
  nombre_cliente: "Andrea",
  pago: "local",
  confianza: "alta",
};

function validarOk(extraido: PedidoVozExtraido): PedidoVozValidado {
  const validado = validarPedidoVoz(extraido);
  expect(validado.ok).toBe(true);
  if (!validado.ok) throw new Error("debió validar");
  return validado.pedido;
}

describe("resolverPlato / resolverExtra: nombres del menú", () => {
  it("resuelve por nombre exacto y sin acentos ni mayúsculas", () => {
    expect(resolverPlato("Casado con pollo")?.precioColones).toBe(3500);
    expect(resolverPlato("CASADO CON POLLO")?.precioColones).toBe(3500);
    expect(resolverPlato("Cafe")?.nombre).toBe("Café");
    expect(resolverPlato("Chifrijo")?.precioColones).toBe(3500);
  });

  it("resuelve alias que el cliente dice por voz", () => {
    expect(resolverPlato("hamburguesa")?.nombre).toBe("Hamburguesa de la casa");
    expect(resolverPlato("alitas")?.nombre).toBe("Alitas BBQ (6 piezas)");
    expect(resolverPlato("fresco cas")?.nombre).toBe("Fresco de cas");
  });

  it("un plato inventado no resuelve", () => {
    expect(resolverPlato("Casado con res")).toBeNull();
    expect(resolverPlato("Pizza")).toBeNull();
    expect(resolverPlato("")).toBeNull();
  });

  it("extras conocidos con precio; uno inventado no resuelve", () => {
    expect(resolverExtra("queso")?.precioColones).toBe(500);
    expect(resolverExtra("doble carne")?.precioColones).toBe(1500);
    expect(resolverExtra("extra queso")?.nombre).toBe("Queso");
    expect(resolverExtra("aguacate")).toBeNull();
  });
});

describe("validarPedidoVoz: el menú manda, no el modelo", () => {
  it("acepta un pedido válido y normaliza los nombres", () => {
    const pedido = validarOk({
      ...EXTRACCION_VALIDA,
      items: [
        { nombre: "hamburguesa", cantidad: 1, nota: null, extras: ["doble carne"] },
      ],
      total_colones: 5300,
      tipo: "llevar",
      mesa: null,
      nombre_cliente: null,
      pago: null,
    });
    expect(pedido.items[0]?.nombre).toBe("Hamburguesa de la casa");
    expect(pedido.items[0]?.extras[0]?.nombre).toBe("Doble carne");
    expect(pedido.totalColones).toBe(5300);
  });

  it("rechaza plato que no está en el menú", () => {
    const validado = validarPedidoVoz({
      ...EXTRACCION_VALIDA,
      items: [{ nombre: "Casado con res", cantidad: 1, nota: null, extras: [] }],
      total_colones: 4000,
    });
    expect(validado.ok).toBe(false);
    if (validado.ok) throw new Error("debió rechazar");
    expect(validado.motivo).toContain("no está en el menú");
  });

  it("rechaza extra que no está en el menú", () => {
    const validado = validarPedidoVoz({
      ...EXTRACCION_VALIDA,
      items: [
        { nombre: "Hamburguesa de la casa", cantidad: 1, nota: null, extras: ["aguacate"] },
      ],
      total_colones: 3800,
    });
    expect(validado.ok).toBe(false);
    if (validado.ok) throw new Error("debió rechazar");
    expect(validado.motivo).toContain("extra no está en el menú");
  });

  it("rechaza total que no cuadra con el menú", () => {
    const validado = validarPedidoVoz({ ...EXTRACCION_VALIDA, total_colones: 9999 });
    expect(validado.ok).toBe(false);
    if (validado.ok) throw new Error("debió rechazar");
    expect(validado.motivo).toContain("total no cuadra");
    expect(validado.motivo).toContain("8200");
  });

  it("rechaza confianza baja aunque todo cuadre", () => {
    const validado = validarPedidoVoz({ ...EXTRACCION_VALIDA, confianza: "baja" });
    expect(validado.ok).toBe(false);
    if (validado.ok) throw new Error("debió rechazar");
    expect(validado.motivo).toContain("confianza baja");
  });

  it("rechaza cantidad no entera o menor que 1 y pedido sin platos", () => {
    expect(
      validarPedidoVoz({
        ...EXTRACCION_VALIDA,
        items: [{ nombre: "Café", cantidad: 0, nota: null, extras: [] }],
        total_colones: 0,
      }).ok,
    ).toBe(false);
    expect(
      validarPedidoVoz({ ...EXTRACCION_VALIDA, items: [], total_colones: 0 }).ok,
    ).toBe(false);
  });

  it("domicilio exige dirección, zona y mínimo de 5000 colones", () => {
    const base: PedidoVozExtraido = {
      items: [{ nombre: "Arroz con camarones", cantidad: 2, nota: null, extras: [] }],
      total_colones: 12500,
      tipo: "domicilio",
      mesa: null,
      direccion: "Calle 1, casa 2",
      zona: "barrios",
      nombre_cliente: "Luis",
      pago: "contra_entrega",
      confianza: "alta",
    };
    expect(validarPedidoVoz(base).ok).toBe(true);
    expect(validarPedidoVoz({ ...base, direccion: "" }).ok).toBe(false);
    expect(validarPedidoVoz({ ...base, zona: null, total_colones: 11000 }).ok).toBe(false);
    const chico: PedidoVozExtraido = {
      ...base,
      items: [{ nombre: "Agua", cantidad: 1, nota: null, extras: [] }],
      total_colones: 1800,
    };
    const validado = validarPedidoVoz(chico);
    expect(validado.ok).toBe(false);
    if (validado.ok) throw new Error("debió rechazar");
    expect(validado.motivo).toContain("mínimo");
  });
});

describe("calcularTotalColones: recálculo desde el menú", () => {
  it("suma platos y extras", () => {
    const pedido = validarOk({
      ...EXTRACCION_VALIDA,
      items: [
        { nombre: "Hamburguesa de la casa", cantidad: 1, nota: null, extras: ["queso"] },
        { nombre: "Gaseosa", cantidad: 2, nota: null, extras: [] },
      ],
      total_colones: 3800 + 500 + 2 * 900,
      tipo: "llevar",
      mesa: null,
      pago: null,
    });
    expect(calcularTotalColones(pedido)).toBe(6100);
    expect(calcularSubtotalColones(pedido)).toBe(6100);
  });

  it("a domicilio suma el recargo según la zona; el subtotal no", () => {
    const pedido = validarOk({
      items: [{ nombre: "Arroz con camarones", cantidad: 2, nota: null, extras: [] }],
      total_colones: 12500,
      tipo: "domicilio",
      mesa: null,
      direccion: "Calle 1",
      zona: "barrios",
      nombre_cliente: null,
      pago: null,
      confianza: "alta",
    });
    expect(calcularSubtotalColones(pedido)).toBe(11000);
    expect(calcularTotalColones(pedido)).toBe(12500);
  });
});

describe("construirTextoPedidoVoz: mismo formato que el chat", () => {
  it("local con mesa, cliente, nota y pago", () => {
    const pedido = validarOk(EXTRACCION_VALIDA);
    expect(construirTextoPedidoVoz(pedido, "conv_123")).toBe(
      [
        "PEDIDO CONFIRMADO",
        "Canal: Voz",
        "Llamada: conv_123",
        "MESA: 4",
        "Cliente: Andrea",
        "2x Casado con pollo — sin cebolla",
        "1x Fresco de cas",
        "Pago: En el local",
        "Total: ₡8200",
      ].join("\n"),
    );
  });

  it("para llevar y domicilio con extras", () => {
    const llevar = validarOk({
      ...EXTRACCION_VALIDA,
      items: [
        { nombre: "Hamburguesa de la casa", cantidad: 1, nota: "sin cebolla", extras: ["queso", "doble carne"] },
      ],
      total_colones: 5800,
      tipo: "llevar",
      mesa: null,
      nombre_cliente: null,
      pago: null,
    });
    const textoLlevar = construirTextoPedidoVoz(llevar, "conv_9");
    expect(textoLlevar).toContain("PARA LLEVAR");
    expect(textoLlevar).not.toContain("MESA:");
    expect(textoLlevar).not.toContain("Cliente:");
    expect(textoLlevar).not.toContain("Pago:");
    expect(textoLlevar).toContain("1x Hamburguesa de la casa — sin cebolla — extras: Queso, Doble carne");
    expect(textoLlevar).toContain("Total: ₡5800");

    const domicilio = validarOk({
      items: [{ nombre: "Arroz con camarones", cantidad: 2, nota: null, extras: [] }],
      total_colones: 12000,
      tipo: "domicilio",
      mesa: null,
      direccion: "Calle 1, casa 2",
      zona: "centro",
      nombre_cliente: "Luis",
      pago: "contra_entrega",
      confianza: "alta",
    });
    const textoDomicilio = construirTextoPedidoVoz(domicilio, null);
    expect(textoDomicilio).toContain("DELIVERY");
    expect(textoDomicilio).toContain("Dirección: Calle 1, casa 2");
    expect(textoDomicilio).toContain("Pago: Contra entrega");
    expect(textoDomicilio).not.toContain("Llamada:");
    expect(textoDomicilio).toContain("Total: ₡12000");
  });
});

describe("telefonoVozValido / identidadContactoVoz", () => {
  it("acepta dígitos de 8 a 15; lo demás no es teléfono", () => {
    expect(telefonoVozValido("50688888888")).toBe("50688888888");
    expect(telefonoVozValido("+506 8888-8888")).toBe("50688888888");
    expect(telefonoVozValido("8888")).toBeNull();
    expect(telefonoVozValido("")).toBeNull();
    expect(telefonoVozValido(null)).toBeNull();
  });

  it("la identidad sin teléfono es voz:<conversation_id>", () => {
    expect(identidadContactoVoz("conv_123")).toBe("voz:conv_123");
    expect(identidadContactoVoz(null)).toMatch(/^voz:vc_/);
  });
});

describe("procesarPedidoDeVoz: el camino incierto no crea pedido", () => {
  function depsFalsas(extraccion: unknown) {
    const persistir = vi.fn(
      async (
        _organizationId: string,
        _pedido: PedidoVozValidado,
        _llamada: LlamadaVozParaPedido,
      ) => {},
    );
    const preguntarModelo = vi.fn(async () => ({
      ok: true as const,
      data: extraccion as PedidoVozExtraido,
      raw: "{}",
    }));
    return {
      persistir,
      preguntarModelo,
      deps: {
        esPedidos: async () => true,
        preguntarModelo,
        persistir,
      },
    };
  }

  it("camino feliz: extrae, valida y persiste con el pedido validado", async () => {
    const { persistir, preguntarModelo, deps } = depsFalsas(EXTRACCION_VALIDA);
    const resultado = await procesarPedidoDeVoz(
      "org_1",
      {
        summary: "Pidió dos casados con pollo sin cebolla y un fresco de cas.",
        transcript: "Agente: ¿Qué desea? Cliente: Dos casados con pollo sin cebolla y un fresco de cas.",
        conversationId: "conv_123",
      },
      deps,
    );
    expect(resultado).toEqual({ creado: true });
    expect(preguntarModelo).toHaveBeenCalledTimes(1);
    expect(persistir).toHaveBeenCalledTimes(1);
    const pedidoPersistido = persistir.mock.calls[0]?.[1];
    expect(pedidoPersistido?.totalColones).toBe(8200);
    expect(pedidoPersistido?.items[0]?.nombre).toBe("Casado con pollo");
  });

  it("sin texto usable no llama al modelo ni persiste", async () => {
    const { persistir, preguntarModelo, deps } = depsFalsas(EXTRACCION_VALIDA);
    const resultado = await procesarPedidoDeVoz(
      "org_1",
      { summary: "  ", transcript: null, conversationId: "conv_1" },
      deps,
    );
    expect(resultado).toEqual({
      creado: false,
      motivo: "sin texto usable (ni resumen ni transcripción)",
    });
    expect(preguntarModelo).not.toHaveBeenCalled();
    expect(persistir).not.toHaveBeenCalled();
  });

  it("sin pipeline de pedidos no llama al modelo ni persiste", async () => {
    const { persistir, preguntarModelo } = depsFalsas(EXTRACCION_VALIDA);
    const resultado = await procesarPedidoDeVoz(
      "org_1",
      { summary: "Pidió un casado.", conversationId: "conv_1" },
      {
        esPedidos: async () => false,
        preguntarModelo,
        persistir,
      },
    );
    expect(resultado.creado).toBe(false);
    expect(preguntarModelo).not.toHaveBeenCalled();
    expect(persistir).not.toHaveBeenCalled();
  });

  it("confianza baja → no se crea el pedido, la llamada queda para revisión humana", async () => {
    const { persistir, deps } = depsFalsas({ ...EXTRACCION_VALIDA, confianza: "baja" });
    const resultado = await procesarPedidoDeVoz(
      "org_1",
      { summary: "No se entendió bien el pedido.", conversationId: "conv_1" },
      deps,
    );
    expect(resultado.creado).toBe(false);
    if (resultado.creado) throw new Error("debió fallar");
    expect(resultado.motivo).toContain("confianza baja");
    expect(persistir).not.toHaveBeenCalled();
  });

  it("total que no cuadra → no se crea el pedido", async () => {
    const { persistir, deps } = depsFalsas({ ...EXTRACCION_VALIDA, total_colones: 1 });
    const resultado = await procesarPedidoDeVoz(
      "org_1",
      { summary: "Pidió dos casados.", conversationId: "conv_1" },
      deps,
    );
    expect(resultado.creado).toBe(false);
    expect(persistir).not.toHaveBeenCalled();
  });

  it("fallo del modelo → no se crea el pedido y no se lanza excepción", async () => {
    const persistir = vi.fn(async () => {});
    const resultado = await procesarPedidoDeVoz(
      "org_1",
      { summary: "Pidió un casado.", conversationId: "conv_1" },
      {
        esPedidos: async () => true,
        preguntarModelo: async () => ({
          ok: false as const,
          error: "provider_error" as const,
          detail: "el proveedor no contestó",
        }),
        persistir,
      },
    );
    expect(resultado.creado).toBe(false);
    expect(persistir).not.toHaveBeenCalled();
  });

  it("fallo al persistir → no se lanza excepción", async () => {
    const resultado = await procesarPedidoDeVoz(
      "org_1",
      { summary: "Pidió un casado.", conversationId: "conv_1" },
      {
        esPedidos: async () => true,
        preguntarModelo: async () => ({
          ok: true as const,
          data: {
            ...EXTRACCION_VALIDA,
            items: [{ nombre: "Café", cantidad: 1, nota: null, extras: [] }],
            total_colones: 1000,
            mesa: null,
            nombre_cliente: null,
            pago: null,
          },
          raw: "{}",
        }),
        persistir: async () => {
          throw new Error("BD caída");
        },
      },
    );
    expect(resultado.creado).toBe(false);
  });
});

describe("Puente Voz → Vocero: Normalizar lee la forma real de ElevenLabs", () => {
  const puente = JSON.parse(
    readFileSync(
      new URL("../../../n8n/workflows/Puente_Voz_Vocero.json", import.meta.url),
      "utf-8",
    ),
  ) as {
    active: boolean;
    nodes: { name: string; parameters: Record<string, unknown> }[];
  };

  function ejecutarNormalizar(payload: unknown) {
    const nodo = puente.nodes.find((n) => n.name === "Normalizar");
    if (!nodo) throw new Error("falta el nodo Normalizar");
    const codigo = (nodo.parameters as { jsCode: string }).jsCode;
    const ejecutar = new Function("$input", codigo) as (
      input: { first: () => { json: unknown } },
    ) => { json: Record<string, unknown> }[];
    return ejecutar({ first: () => ({ json: payload }) })[0]?.json;
  }

  it("el flujo sigue inactivo y la llave sigue siendo el placeholder", () => {
    expect(puente.active).toBe(false);
    const registrar = puente.nodes.find((n) => n.name === "Registrar en Vocero");
    const headers = (
      registrar?.parameters as {
        headerParameters: { parameters: { name: string; value: string }[] };
      }
    ).headerParameters.parameters;
    expect(headers.find((h) => h.name === "X-Voz-Key")?.value).toBe("TU_VOZ_API_KEY");
  });

  it("lee data.agent_id, data.conversation_id, call_summary_title y transcript[]", () => {
    const salida = ejecutarNormalizar({
      type: "post_call_transcription",
      data: {
        agent_id: "agent_3901m6vhmjszf1x97hbttpa5mcpt",
        conversation_id: "conv_xyz",
        status: "done",
        analysis: {
          call_summary_title: "Pidió dos casados para la mesa 4.",
          data_collection_results: { telefono: "50688888888", nombre: "Andrea" },
        },
        transcript: [
          { role: "agent", message: "Buenas, ¿en qué le ayudo?" },
          { role: "user", message: "Dos casados con pollo, por favor." },
        ],
      },
    });
    expect(salida).toMatchObject({
      instance: "tep",
      agent_id: "agent_3901m6vhmjszf1x97hbttpa5mcpt",
      conversation_id: "conv_xyz",
      phone: "50688888888",
      name: "Andrea",
      direction: "inbound",
      summary: "Pidió dos casados para la mesa 4.",
      transcript:
        "Agente: Buenas, ¿en qué le ayudo?\nCliente: Dos casados con pollo, por favor.",
    });
    expect(typeof salida?.duration_sec).toBe("number");
  });

  it("prefiere call_summary al título y acepta transcript como string", () => {
    const salida = ejecutarNormalizar({
      data: {
        agent_id: "agent_1",
        conversation_id: "conv_2",
        analysis: {
          call_summary: "Resumen completo.",
          call_summary_title: "Título corto.",
        },
        transcript: "Agente: Hola.\nCliente: Hola.",
      },
    });
    expect(salida?.summary).toBe("Resumen completo.");
    expect(salida?.transcript).toBe("Agente: Hola.\nCliente: Hola.");
    // Sin teléfono ni nombre: vacíos, no inventados.
    expect(salida?.phone).toBe("");
    expect(salida?.name).toBe("");
  });

  it("un payload mínimo no rompe el nodo", () => {
    const salida = ejecutarNormalizar({ data: {} });
    expect(salida).toMatchObject({
      agent_id: "",
      conversation_id: "",
      phone: "",
      name: "",
      summary: "",
      transcript: "",
      duration_sec: 0,
    });
  });
});
