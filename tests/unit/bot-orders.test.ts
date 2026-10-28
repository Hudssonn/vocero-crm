import { describe, expect, it } from "vitest";
import {
  ORDER_STAGES,
  formatOrderText,
  menuOrderSchema,
  orderContactIdentity,
  orderContactName,
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
});

describe("ORDER_STAGES", () => {
  it("seis etapas en orden, con las anclas al final", () => {
    expect(ORDER_STAGES.map((s) => s.name)).toEqual([
      "Nuevo pedido",
      "En preparación",
      "Listo",
      "Pagado",
      "Entregado",
      "Perdido",
    ]);
    expect(ORDER_STAGES.map((s) => s.kind)).toEqual([
      "open",
      "open",
      "open",
      "open",
      "won",
      "lost",
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
});
