import { eq } from "drizzle-orm";
import { z } from "zod";
import { chatJson, type ChatJsonResult } from "@/lib/ai";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { normalizeMx } from "@/lib/meta/client";
import { getOrCreateContactByIdentity } from "@/server/inbox/identity";
import { getOrCreateConversation } from "@/server/inbox/ingest";
import {
  esPipelineDePedidos,
  registrarPedidoConfirmado,
} from "@/server/orders/order-pipeline";

/**
 * 050 — Pedido por voz → pantalla de cocina (Soda La Esquina).
 *
 * Cuando el puente de voz registra una llamada (`POST /api/voz/post-llamada`),
 * la ruta intenta convertirla en pedido SOLO si la organización tiene
 * pipeline de pedidos (etapa «Nuevo pedido», solo la soda) y la llamada
 * trae texto usable (resumen o transcripción). El pedido se extrae con el
 * LLM del backend (`chatJson`, el mismo helper del turno del agente; el
 * segundo pase del PR #30 es específico de agenda — `resolverFalloAgenda` —
 * y no sirve aquí) y se valida en el servidor contra el menú: si algo no
 * cuadra, NO se crea el pedido y la llamada queda en el historial de voz
 * para revisión humana. Nunca se lanza excepción desde este camino: el 201
 * de la llamada no se ve afectado.
 *
 * El pedido creado es un lead en «Nuevo pedido» con un mensaje
 * «PEDIDO CONFIRMADO» (mismo formato que el chat), así la pantalla de
 * cocina lo enseña por `GET /api/bot/board` sin tocar nada de ella.
 *
 * CAVEAT — contacto `voz:<conversation_id>`: igual que el menú QR crea un
 * contacto por pedido (`menu:<orderId>`), la voz crea un contacto por
 * llamada, porque un lead por contacto es lo que deja ver cada pedido como
 * tarjeta. Ese contacto NO se reconcilia con el de WhatsApp del mismo
 * cliente (el teléfono rara vez viene en el webhook de voz): si la misma
 * persona pide por voz y por WhatsApp, quedan dos contactos y dos tarjetas.
 * Reconciliarlos es trabajo aparte.
 */

/** Menú de Soda La Esquina con precios en colones (~/workspace/kb-menu-soda.txt). */
export const SODA_MENU: { nombre: string; precioColones: number }[] = [
  { nombre: "Sopa de pejibaye", precioColones: 2800 },
  { nombre: "Patacones con frijoles", precioColones: 2500 },
  { nombre: "Casado con pollo", precioColones: 3500 },
  { nombre: "Casado con pescado", precioColones: 4200 },
  { nombre: "Arroz con camarones", precioColones: 5500 },
  { nombre: "Olla de carne", precioColones: 4500 },
  { nombre: "Hamburguesa de la casa", precioColones: 3800 },
  { nombre: "Fresco de cas", precioColones: 1200 },
  { nombre: "Café", precioColones: 1000 },
  { nombre: "Gaseosa", precioColones: 900 },
  { nombre: "Flan de coco", precioColones: 1800 },
  { nombre: "Cajeta", precioColones: 1200 },
  { nombre: "Papas fritas", precioColones: 2000 },
  { nombre: "Nachos con queso", precioColones: 3000 },
  { nombre: "Alitas BBQ (6 piezas)", precioColones: 3500 },
  { nombre: "Perro caliente", precioColones: 2500 },
  { nombre: "Aros de cebolla", precioColones: 2200 },
  { nombre: "Té frío", precioColones: 1200 },
  { nombre: "Limonada", precioColones: 1200 },
  { nombre: "Agua", precioColones: 800 },
  { nombre: "Jugo de naranja", precioColones: 1500 },
  { nombre: "Imperial", precioColones: 1800 },
  { nombre: "Pilsen", precioColones: 1700 },
  { nombre: "Bavaria", precioColones: 1800 },
  { nombre: "Corona", precioColones: 2500 },
  { nombre: "Heineken", precioColones: 2200 },
  { nombre: "Budweiser", precioColones: 2200 },
  { nombre: "Stella Artois", precioColones: 2500 },
  { nombre: "Michelob Ultra", precioColones: 2500 },
  { nombre: "Chifrijo", precioColones: 3500 },
];

/** Extras con precio (solo la hamburguesa los tiene en el menú). */
export const SODA_EXTRAS: { nombre: string; precioColones: number }[] = [
  { nombre: "Queso", precioColones: 500 },
  { nombre: "Doble carne", precioColones: 1500 },
];

/** Recargo a domicilio por zona, en colones; pedido mínimo a domicilio. */
export const RECARGO_DOMICILIO = { centro: 1000, barrios: 1500 } as const;
export const MINIMO_DOMICILIO_COLONES = 5000;

/** Minúsculas, sin acentos, sin espacios de más: para comparar nombres. */
export function normalizarNombrePlato(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Formas cortas que el cliente dice por voz → plato del menú. */
const ALIAS_PLATOS: Record<string, string> = {
  "casado de pollo": "Casado con pollo",
  "casado pollo": "Casado con pollo",
  "casado de pescado": "Casado con pescado",
  "casado pescado": "Casado con pescado",
  "fresco cas": "Fresco de cas",
  cas: "Fresco de cas",
  hamburguesa: "Hamburguesa de la casa",
  alitas: "Alitas BBQ (6 piezas)",
  "alitas bbq": "Alitas BBQ (6 piezas)",
  chifrijo: "Chifrijo",
  "hot dog": "Perro caliente",
  "sopa pejibaye": "Sopa de pejibaye",
  patacones: "Patacones con frijoles",
  "arroz camarones": "Arroz con camarones",
  "olla carne": "Olla de carne",
  flan: "Flan de coco",
  cafe: "Café",
  "te frio": "Té frío",
  "jugo naranja": "Jugo de naranja",
  "papas": "Papas fritas",
  nachos: "Nachos con queso",
  "aros cebolla": "Aros de cebolla",
};

const MENU_POR_NORMALIZADO = new Map(
  SODA_MENU.map((item) => [normalizarNombrePlato(item.nombre), item]),
);
const EXTRAS_POR_NORMALIZADO = new Map(
  SODA_EXTRAS.map((extra) => [normalizarNombrePlato(extra.nombre), extra]),
);

/** Nombre tal como lo dijo el modelo → plato del menú, o null. Pura. */
export function resolverPlato(
  nombre: string,
): { nombre: string; precioColones: number } | null {
  const normalizado = normalizarNombrePlato(nombre);
  return (
    MENU_POR_NORMALIZADO.get(normalizado) ??
    (ALIAS_PLATOS[normalizado]
      ? (MENU_POR_NORMALIZADO.get(
          normalizarNombrePlato(ALIAS_PLATOS[normalizado] as string),
        ) ?? null)
      : null)
  );
}

/** Extra tal como lo dijo el modelo → extra del menú, o null. Pura. */
export function resolverExtra(
  nombre: string,
): { nombre: string; precioColones: number } | null {
  const normalizado = normalizarNombrePlato(nombre);
  if (normalizado === "extra queso") {
    return EXTRAS_POR_NORMALIZADO.get("queso") ?? null;
  }
  return EXTRAS_POR_NORMALIZADO.get(normalizado) ?? null;
}

/** Lo que el modelo debe devolver: SOLO JSON con este esquema. */
export const pedidoVozSchema = z.object({
  items: z
    .array(
      z.object({
        nombre: z.string().min(1),
        cantidad: z.number().int().min(1),
        nota: z.string().nullish(),
        extras: z.array(z.string()).nullish(),
      }),
    )
    .min(1),
  total_colones: z.number().int().min(0),
  tipo: z.enum(["local", "llevar", "domicilio"]),
  mesa: z.number().int().min(1).nullish(),
  direccion: z.string().nullish(),
  zona: z.enum(["centro", "barrios"]).nullish(),
  nombre_cliente: z.string().nullish(),
  pago: z.enum(["local", "contra_entrega"]).nullish(),
  confianza: z.enum(["alta", "baja"]),
});

export type PedidoVozExtraido = z.infer<typeof pedidoVozSchema>;

export type PedidoVozItemValidado = {
  nombre: string;
  cantidad: number;
  nota: string | null;
  extras: { nombre: string; precioColones: number }[];
};

export type PedidoVozValidado = {
  items: PedidoVozItemValidado[];
  totalColones: number;
  tipo: "local" | "llevar" | "domicilio";
  mesa: number | null;
  direccion: string | null;
  zona: "centro" | "barrios" | null;
  nombreCliente: string | null;
  pago: "local" | "contra_entrega" | null;
};

/**
 * Total en colones de un pedido validado, recalculado desde el menú:
 * platos + extras + recargo a domicilio según la zona. Puro.
 */
export function calcularTotalColones(pedido: PedidoVozValidado): number {
  let total = 0;
  for (const item of pedido.items) {
    const plato = resolverPlato(item.nombre);
    if (!plato) continue;
    total += plato.precioColones * item.cantidad;
    for (const extra of item.extras) {
      total += extra.precioColones * item.cantidad;
    }
  }
  if (pedido.tipo === "domicilio" && pedido.zona) {
    total += RECARGO_DOMICILIO[pedido.zona];
  }
  return total;
}

/** Subtotal sin recargo (lo que compara el pedido mínimo a domicilio). Puro. */
export function calcularSubtotalColones(pedido: PedidoVozValidado): number {
  let total = 0;
  for (const item of pedido.items) {
    const plato = resolverPlato(item.nombre);
    if (!plato) continue;
    total += plato.precioColones * item.cantidad;
    for (const extra of item.extras) {
      total += extra.precioColones * item.cantidad;
    }
  }
  return total;
}

export type ValidacionPedidoVoz =
  | { ok: true; pedido: PedidoVozValidado }
  | { ok: false; motivo: string };

/**
 * Valida lo extraído contra el menú. Pura y estricta: cada plato existe,
 * cantidades enteras ≥ 1, extras conocidos, el total recalculado desde los
 * precios del menú es igual al extraído, tipo válido, domicilio con
 * dirección, zona y mínimo, y confianza alta. Cualquier fallo → no se crea
 * el pedido (fail-closed, revisión humana).
 */
export function validarPedidoVoz(extraido: unknown): ValidacionPedidoVoz {
  const parseado = pedidoVozSchema.safeParse(extraido);
  if (!parseado.success) {
    return {
      ok: false,
      motivo: `la extracción no cumple el esquema: ${parseado.error.issues
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
    };
  }
  const datos = parseado.data;
  if (datos.confianza !== "alta") {
    return {
      ok: false,
      motivo: "confianza baja: el pedido no quedó claro en la llamada",
    };
  }

  const items: PedidoVozItemValidado[] = [];
  for (const item of datos.items) {
    const plato = resolverPlato(item.nombre);
    if (!plato) {
      return {
        ok: false,
        motivo: `plato no está en el menú: ${item.nombre}`,
      };
    }
    const extras: PedidoVozItemValidado["extras"] = [];
    for (const extra of item.extras ?? []) {
      const resuelto = resolverExtra(extra);
      if (!resuelto) {
        return { ok: false, motivo: `extra no está en el menú: ${extra}` };
      }
      extras.push(resuelto);
    }
    items.push({
      nombre: plato.nombre,
      cantidad: item.cantidad,
      nota: item.nota?.trim() ? item.nota.trim() : null,
      extras,
    });
  }

  const pedido: PedidoVozValidado = {
    items,
    totalColones: datos.total_colones,
    tipo: datos.tipo,
    mesa: datos.mesa ?? null,
    direccion: datos.direccion?.trim() ? datos.direccion.trim() : null,
    zona: datos.zona ?? null,
    nombreCliente: datos.nombre_cliente?.trim()
      ? datos.nombre_cliente.trim()
      : null,
    pago: datos.pago ?? null,
  };

  if (pedido.tipo === "domicilio") {
    if (!pedido.direccion) {
      return { ok: false, motivo: "domicilio sin dirección" };
    }
    if (!pedido.zona) {
      return { ok: false, motivo: "domicilio sin zona (centro o barrios)" };
    }
    if (calcularSubtotalColones(pedido) < MINIMO_DOMICILIO_COLONES) {
      return {
        ok: false,
        motivo: `domicilio por debajo del mínimo de ${MINIMO_DOMICILIO_COLONES} colones`,
      };
    }
  }

  const recalculado = calcularTotalColones(pedido);
  if (recalculado !== pedido.totalColones) {
    return {
      ok: false,
      motivo:
        `total no cuadra: el modelo dijo ${pedido.totalColones} colones ` +
        `pero el menú da ${recalculado} colones`,
    };
  }
  return { ok: true, pedido };
}

const PAGO_TEXTO_VOZ = {
  local: "Pago: En el local",
  contra_entrega: "Pago: Contra entrega",
} as const;

/**
 * Texto de confirmación del pedido por voz, mismo formato que el chat para
 * que la pantalla de cocina lo lea por el marcador «PEDIDO CONFIRMADO».
 * Puro y determinístico. El total va como «Total: ₡X», como lo espera el
 * tablero; los precios en palabras («colones») solo viven en el prompt del
 * LLM, no aquí.
 */
export function construirTextoPedidoVoz(
  pedido: PedidoVozValidado,
  conversationId: string | null,
): string {
  const lines = ["PEDIDO CONFIRMADO", "Canal: Voz"];
  if (conversationId) lines.push(`Llamada: ${conversationId}`);
  if (pedido.tipo === "local") {
    if (pedido.mesa !== null) lines.push(`MESA: ${pedido.mesa}`);
  } else if (pedido.tipo === "llevar") {
    lines.push("PARA LLEVAR");
  } else {
    lines.push("DELIVERY");
    lines.push(`Dirección: ${pedido.direccion}`);
  }
  if (pedido.nombreCliente) lines.push(`Cliente: ${pedido.nombreCliente}`);
  for (const item of pedido.items) {
    let line = `${item.cantidad}x ${item.nombre}`;
    if (item.nota) line += ` — ${item.nota}`;
    if (item.extras.length > 0) {
      line += ` — extras: ${item.extras.map((e) => e.nombre).join(", ")}`;
    }
    lines.push(line);
  }
  if (pedido.pago) lines.push(PAGO_TEXTO_VOZ[pedido.pago]);
  lines.push(`Total: ₡${pedido.totalColones}`);
  return lines.join("\n");
}

/** Menú en texto para el prompt de extracción (sale de SODA_MENU, no se duplica). */
function menuParaPrompt(): string {
  const platos = SODA_MENU.map(
    (item) => `- ${item.nombre}: ${item.precioColones} colones`,
  ).join("\n");
  const extras = SODA_EXTRAS.map(
    (extra) => `- ${extra.nombre}: ${extra.precioColones} colones`,
  ).join("\n");
  return (
    `${platos}\nExtras de hamburguesa:\n${extras}\n` +
    `A domicilio: Centro recargo ${RECARGO_DOMICILIO.centro} colones, ` +
    `barrios recargo ${RECARGO_DOMICILIO.barrios} colones, ` +
    `pedido mínimo ${MINIMO_DOMICILIO_COLONES} colones (sin contar el recargo).`
  );
}

/** Prompt estricto de extracción: solo JSON, nada inventado. Puro. */
export function promptExtraccionPedidoVoz(textoLlamada: string): {
  system: string;
  user: string;
} {
  return {
    system:
      "Extraés el pedido de una llamada a Soda La Esquina a partir del " +
      "resumen y la transcripción. Respondés SOLO con un objeto JSON, sin " +
      "explicaciones ni markdown. Usá EXACTAMENTE los platos, extras y " +
      "precios del menú de abajo: nunca inventes un plato, un precio, un " +
      "ingrediente ni una dirección. Si algo del pedido no quedó claro " +
      "(plato, cantidad, mesa, dirección o total), marcá confianza \"baja\". " +
      "El total_colones es un número entero en colones, sin símbolo: sumá " +
      "cada plato por su cantidad más sus extras, y si es a domicilio sumá " +
      "el recargo según la zona. Las notas por plato (por ejemplo sin " +
      "cebolla) van en \"nota\"; los extras solo pueden ser los del menú.\n\n" +
      "MENÚ DE SODA LA ESQUINA (precios en colones):\n" +
      menuParaPrompt() +
      "\n\nEsquema JSON: {\"items\": [{\"nombre\": string, \"cantidad\": number, " +
      "\"nota\": string | null, \"extras\": [string]}], " +
      "\"total_colones\": number, \"tipo\": \"local\" | \"llevar\" | " +
      "\"domicilio\", \"mesa\": number | null, \"direccion\": string | null, " +
      "\"zona\": \"centro\" | \"barrios\" | null, \"nombre_cliente\": string | " +
      "null, \"pago\": \"local\" | \"contra_entrega\" | null, " +
      "\"confianza\": \"alta\" | \"baja\"}.",
    user: textoLlamada,
  };
}

export type LlamadaVozParaPedido = {
  summary?: string | null;
  transcript?: string | null;
  phone?: string | null;
  name?: string | null;
  conversationId?: string | null;
};

export type ResultadoPedidoVoz =
  | { creado: true }
  | { creado: false; motivo: string };

export type DependenciasPedidoVoz = {
  /** Pregunta al modelo; por defecto `chatJson` con el prompt estricto. */
  preguntarModelo?: (
    texto: string,
  ) => Promise<ChatJsonResult<PedidoVozExtraido>>;
  /** ¿La org tiene pipeline de pedidos? Por defecto `esPipelineDePedidos`. */
  esPedidos?: (organizationId: string) => Promise<boolean>;
  /** Guarda contacto + conversación + mensaje + lead. Por defecto el flujo real. */
  persistir?: (
    organizationId: string,
    pedido: PedidoVozValidado,
    llamada: LlamadaVozParaPedido,
  ) => Promise<void>;
};

/** Identidad estable del contacto de un pedido por voz: una llamada, un contacto. */
export function identidadContactoVoz(conversationId: string | null): string {
  return `voz:${conversationId ?? newId("voiceCall")}`;
}

/** Teléfono usable para reconciliar con un contacto de WhatsApp, o null. Pura. */
export function telefonoVozValido(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digitos = phone.replace(/\D/g, "");
  if (digitos.length < 8 || digitos.length > 15) return null;
  return normalizeMx(digitos);
}

/**
 * Guarda el pedido: contacto (por teléfono si viene uno válido, si no
 * `voz:<conversation_id>`) + conversación + mensaje de confirmación + lead
 * en «Nuevo pedido» con su monto. Espeja `createMenuOrder`, sin llamarla
 * (ella crea contacto `menu:<orderId>` y exige `MenuOrderInput`).
 * No crea el mensaje dos veces: si la conversación ya tiene mensajes, no
 * inserta otro (reintento del mismo `conversation_id`).
 */
export async function persistirPedidoVoz(
  organizationId: string,
  pedido: PedidoVozValidado,
  llamada: LlamadaVozParaPedido,
): Promise<void> {
  const telefono = telefonoVozValido(llamada.phone);
  const nombreLlamada = llamada.name?.trim() ? llamada.name.trim() : null;
  const nombre = pedido.nombreCliente ?? nombreLlamada;
  const { contact } = await getOrCreateContactByIdentity(organizationId, {
    identity: telefono ?? identidadContactoVoz(llamada.conversationId ?? null),
    channel: "whatsapp",
    phone: telefono,
    waUserId: null,
    profileName: nombre ?? "Llamada de voz",
  });

  const conversation = await getOrCreateConversation(
    organizationId,
    contact.id,
    { channel: "whatsapp" },
  );

  const texto = construirTextoPedidoVoz(
    pedido,
    llamada.conversationId ?? null,
  );

  const db = getDb();
  const existentes = await db
    .select({ id: schema.message.id })
    .from(schema.message)
    .where(
      scoped(
        schema.message.organizationId,
        organizationId,
        eq(schema.message.conversationId, conversation.id),
      ),
    )
    .limit(1);
  if (existentes.length === 0) {
    await db.insert(schema.message).values({
      id: newId("message"),
      organizationId,
      conversationId: conversation.id,
      direction: "in",
      type: "text",
      text: texto,
      status: "delivered",
    });
  }

  await registrarPedidoConfirmado(
    organizationId,
    contact.id,
    texto,
    pedido.totalColones,
  );
}

/**
 * Intenta crear el pedido de una llamada de voz. Nunca lanza: cualquier
 * fallo se loguea y se devuelve como `{creado:false, motivo}` — la llamada
 * ya quedó registrada y el 201 no se ve afectado. El pedido solo se crea
 * si la org tiene pipeline de pedidos, hay texto usable, el modelo extrae
 * con confianza alta y la validación contra el menú pasa.
 */
export async function procesarPedidoDeVoz(
  organizationId: string,
  llamada: LlamadaVozParaPedido,
  deps: DependenciasPedidoVoz = {},
): Promise<ResultadoPedidoVoz> {
  try {
    const texto = [llamada.summary, llamada.transcript]
      .map((parte) => parte?.trim() ?? "")
      .filter((parte) => parte.length > 0)
      .join("\n");
    if (!texto) {
      return {
        creado: false,
        motivo: "sin texto usable (ni resumen ni transcripción)",
      };
    }

    const esPedidos = deps.esPedidos ?? esPipelineDePedidos;
    if (!(await esPedidos(organizationId))) {
      return {
        creado: false,
        motivo: "la organización no tiene pipeline de pedidos",
      };
    }

    const preguntarModelo =
      deps.preguntarModelo ??
      ((textoLlamada: string) => {
        const prompt = promptExtraccionPedidoVoz(textoLlamada);
        return chatJson(
          pedidoVozSchema,
          [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
          { organizationId },
        );
      });
    const extraido = await preguntarModelo(texto);
    if (!extraido.ok) {
      const motivo = `el modelo no pudo extraer el pedido (${extraido.error}: ${extraido.detail})`;
      console.error(`[voz-pedido] ${motivo}`);
      return { creado: false, motivo };
    }

    const validado = validarPedidoVoz(extraido.data);
    if (!validado.ok) {
      console.error(`[voz-pedido] pedido no válido: ${validado.motivo}`);
      return { creado: false, motivo: validado.motivo };
    }

    const persistir = deps.persistir ?? persistirPedidoVoz;
    await persistir(organizationId, validado.pedido, llamada);
    return { creado: true };
  } catch (err) {
    const motivo = `no se pudo procesar el pedido de voz: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[voz-pedido] ${motivo}`);
    return { creado: false, motivo };
  }
}
