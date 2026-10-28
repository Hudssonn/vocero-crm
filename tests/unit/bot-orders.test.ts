import { describe, expect, it } from "vitest";
import {
  ORDER_STAGES,
  formatOrderText,
  menuOrderSchema,
  orderContactIdentity,
  orderContactName,
  type MenuOrderInput,
} from "@/server/orders/service";

/** 033 — Pedidos del menú QR. Pruebas puras, sin base de datos: el camino
 * con BD se verifica en vivo en devapp (Principio IX), como exige el fork. */

const mesa = {
  orderId: "pedido-1",
  mesa: 5,
  paraLlevar: false,
  codigo: null,
  items: [
    { nombre: "Casado con pollo", cantidad: 2, nota: "sin cebolla", extras: ["queso"] },
    { nombre: "Fresco de cas", cantidad: 1, nota: null, extras: [] },
  ],
  total: 8200,
};

const llevar = {
  orderId: "pedido-2",
  mesa: null,
  paraLlevar: true,
  codigo: "P-1234",
  items: [{ nombre: "Hamburguesa de la casa", cantidad: 1, nota: null, extras: [] }],
  total: 3800,
};

/** 037 — Para llevar con entrega y pago: delivery a domicilio, pago en efectivo. */
const delivery: MenuOrderInput = {
  orderId: "pedido-3",
  mesa: null,
  paraLlevar: true,
  codigo: "P-5678",
  items: [{ nombre: "Casado con pollo", cantidad: 1, nota: null, extras: [] }],
  total: 6500,
  entrega: "delivery",
  direccion: "100 m este de la soda, casa verde",
  pago: "repartidor",
  conCuanto: 10000,
};

/** 037 — Para llevar con retiro en el local, pago en efectivo. */
const retiro: MenuOrderInput = {
  orderId: "pedido-4",
  mesa: null,
  paraLlevar: true,
  codigo: "P-9012",
  items: [{ nombre: "Fresco de cas", cantidad: 1, nota: null, extras: [] }],
  total: 1200,
  entrega: "retiro",
  direccion: null,
  pago: "local",
  conCuanto: 5000,
};

/** 038 — Pedido en mesa con nombre y celular del cliente. */
const mesaConCliente = {
  ...mesa,
  nombre: "María Pérez",
  telefono: "88887777",
};

/** 038 — Delivery con nombre del cliente, sin teléfono. */
const deliveryConCliente = {
  ...delivery,
  nombre: "Juan Rojas",
  telefono: null,
};

describe("menuOrderSchema", () => {
  it("pedido en mesa válido pasa", () => {
    expect(menuOrderSchema.safeParse(mesa).success).toBe(true);
  });

  it("pedido para llevar válido pasa", () => {
    expect(menuOrderSchema.safeParse(llevar).success).toBe(true);
  });

  it("mesa sin número en comer ahí falla", () => {
    expect(
      menuOrderSchema.safeParse({ ...mesa, mesa: null }).success,
    ).toBe(false);
  });

  it("para llevar sin código falla", () => {
    expect(
      menuOrderSchema.safeParse({ ...llevar, codigo: null }).success,
    ).toBe(false);
  });

  it("sin platos falla", () => {
    expect(menuOrderSchema.safeParse({ ...mesa, items: [] }).success).toBe(false);
  });

  it("cantidad cero falla", () => {
    expect(
      menuOrderSchema.safeParse({
        ...mesa,
        items: [{ nombre: "Café", cantidad: 0, nota: null, extras: [] }],
      }).success,
    ).toBe(false);
  });

  it("037: delivery con dirección y pago pasa", () => {
    expect(menuOrderSchema.safeParse(delivery).success).toBe(true);
  });

  it("037: retiro sin dirección pasa", () => {
    expect(menuOrderSchema.safeParse(retiro).success).toBe(true);
  });

  it("037: delivery sin dirección falla", () => {
    expect(
      menuOrderSchema.safeParse({ ...delivery, direccion: null }).success,
    ).toBe(false);
  });

  it("037: delivery con dirección vacía falla", () => {
    expect(
      menuOrderSchema.safeParse({ ...delivery, direccion: "   " }).success,
    ).toBe(false);
  });

  it("037: pedido viejo sin entrega ni pago sigue pasando", () => {
    expect(menuOrderSchema.safeParse(mesa).success).toBe(true);
    expect(menuOrderSchema.safeParse(llevar).success).toBe(true);
  });

  it("037: conCuanto negativo falla", () => {
    expect(
      menuOrderSchema.safeParse({ ...delivery, conCuanto: -100 }).success,
    ).toBe(false);
  });

  it("037: entrega o pago fuera del contrato falla", () => {
    expect(
      menuOrderSchema.safeParse({ ...delivery, entrega: "express" }).success,
    ).toBe(false);
    expect(
      menuOrderSchema.safeParse({ ...delivery, pago: "tarjeta" }).success,
    ).toBe(false);
  });

  it("038: pedido con nombre y teléfono pasa", () => {
    expect(menuOrderSchema.safeParse(mesaConCliente).success).toBe(true);
    expect(menuOrderSchema.safeParse(deliveryConCliente).success).toBe(true);
  });

  it("038: pedido viejo sin nombre ni teléfono sigue pasando", () => {
    expect(menuOrderSchema.safeParse(mesa).success).toBe(true);
    expect(menuOrderSchema.safeParse(llevar).success).toBe(true);
    expect(menuOrderSchema.safeParse(delivery).success).toBe(true);
  });
});

describe("formatOrderText", () => {
  it("mesa: línea MESA, platos con nota y extras, y total", () => {
    const text = formatOrderText(mesa);
    expect(text).toContain("Pedido desde el menú QR");
    expect(text).toContain("MESA: 5");
    expect(text).toContain("2x Casado con pollo — sin cebolla — extras: queso");
    expect(text).toContain("1x Fresco de cas");
    expect(text).not.toContain("Fresco de cas —");
    expect(text).toContain("Total: ₡8200");
  });

  it("para llevar: línea PARA LLEVAR con el código, sin MESA", () => {
    const text = formatOrderText(llevar);
    expect(text).toContain("PARA LLEVAR: P-1234");
    expect(text).not.toContain("MESA:");
  });

  it("037: delivery: línea DELIVERY + dirección, pago al repartidor y con cuánto, antes del total", () => {
    const text = formatOrderText(delivery);
    expect(text).toContain("DELIVERY: P-5678");
    expect(text).toContain("Dirección: 100 m este de la soda, casa verde");
    expect(text).not.toContain("PARA LLEVAR:");
    expect(text).toContain("Pago: Al repartidor");
    expect(text).toContain("Con cuánto cancela: ₡10000");
    expect(text.indexOf("Pago:")).toBeLessThan(text.indexOf("Total:"));
    expect(text.indexOf("Con cuánto")).toBeLessThan(text.indexOf("Total:"));
  });

  it("037: retiro: línea PARA LLEVAR, pago en el local y con cuánto", () => {
    const text = formatOrderText(retiro);
    expect(text).toContain("PARA LLEVAR: P-9012");
    expect(text).not.toContain("DELIVERY:");
    expect(text).not.toContain("Dirección:");
    expect(text).toContain("Pago: En el local");
    expect(text).toContain("Con cuánto cancela: ₡5000");
  });

  it("037: mesa con SINPE: pago de una vez y sin con cuánto", () => {
    const text = formatOrderText({ ...mesa, pago: "sinpe" });
    expect(text).toContain("MESA: 5");
    expect(text).toContain("Pago: SINPE de una vez");
    expect(text).not.toContain("Con cuánto");
  });

  it("037: pedido viejo sin pago: no agrega líneas de pago ni de vuelto", () => {
    const text = formatOrderText(mesa);
    expect(text).not.toContain("Pago:");
    expect(text).not.toContain("Con cuánto");
  });

  it("038: mesa con cliente: MESA se queda y Cliente/Celular van tras ella, antes de los platos", () => {
    const text = formatOrderText(mesaConCliente);
    expect(text).toContain("MESA: 5");
    expect(text).toContain("Cliente: María Pérez");
    expect(text).toContain("Celular: 88887777");
    expect(text.indexOf("MESA:")).toBeLessThan(text.indexOf("Cliente:"));
    expect(text.indexOf("Cliente:")).toBeLessThan(text.indexOf("Celular:"));
    expect(text.indexOf("Celular:")).toBeLessThan(text.indexOf("2x Casado"));
  });

  it("038: sin teléfono no hay línea Celular; sin nombre no hay línea Cliente", () => {
    const sinTelefono = formatOrderText(deliveryConCliente);
    expect(sinTelefono).toContain("Cliente: Juan Rojas");
    expect(sinTelefono).not.toContain("Celular:");
    const sinNombre = formatOrderText(mesa);
    expect(sinNombre).not.toContain("Cliente:");
    expect(sinNombre).not.toContain("Celular:");
  });

  it("038: nombre solo con espacios no agrega línea Cliente", () => {
    const text = formatOrderText({ ...mesa, nombre: "   ", telefono: "   " });
    expect(text).not.toContain("Cliente:");
    expect(text).not.toContain("Celular:");
  });
});

describe("ORDER_STAGES", () => {
  it("cuatro etapas en orden, con el ancla al final", () => {
    expect(ORDER_STAGES.map((s) => s.name)).toEqual([
      "Nuevo pedido",
      "En preparación",
      "Listo",
      "Entregado",
    ]);
    expect(ORDER_STAGES.map((s) => s.kind)).toEqual([
      "open",
      "open",
      "open",
      "won",
    ]);
  });
});

describe("identidad del pedido", () => {
  it("un pedido, un contacto: la identidad deriva del orderId", () => {
    expect(orderContactIdentity("pedido-1")).toBe("menu:pedido-1");
    expect(orderContactIdentity("pedido-1")).not.toBe(
      orderContactIdentity("pedido-2"),
    );
  });

  it("el nombre del contacto es la mesa o el código para llevar", () => {
    expect(orderContactName(mesa)).toBe("Mesa 5");
    expect(orderContactName(llevar)).toBe("Para llevar P-1234");
  });

  it("037: delivery se llama Delivery, retiro sigue siendo Para llevar", () => {
    expect(orderContactName(delivery)).toBe("Delivery P-5678");
    expect(orderContactName(retiro)).toBe("Para llevar P-9012");
  });

  it("038: con nombre del cliente, el contacto dice mesa/código Y nombre (para entregar)", () => {
    expect(orderContactName(mesaConCliente)).toBe("Mesa 5 · María Pérez");
    expect(orderContactName(deliveryConCliente)).toBe("Delivery P-5678 · Juan Rojas");
    expect(orderContactName({ ...llevar, nombre: "Ana Soto" })).toBe(
      "Para llevar P-1234 · Ana Soto",
    );
  });

  it("038: nombre vacío o solo espacios cae al nombre viejo (Mesa / Para llevar / Delivery)", () => {
    expect(orderContactName({ ...mesa, nombre: null })).toBe("Mesa 5");
    expect(orderContactName({ ...mesa, nombre: "   " })).toBe("Mesa 5");
    expect(orderContactName({ ...llevar, nombre: "" })).toBe("Para llevar P-1234");
    expect(orderContactName({ ...delivery, nombre: null })).toBe("Delivery P-5678");
  });

  it("038: el nombre con espacios alrededor se guarda recortado", () => {
    expect(orderContactName({ ...mesa, nombre: "  María Pérez  " })).toBe(
      "Mesa 5 · María Pérez",
    );
  });
});
