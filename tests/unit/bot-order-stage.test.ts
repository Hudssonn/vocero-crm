import { describe, expect, it } from "vitest";
import { kitchenTransition } from "@/server/orders/stage";
import { ORDER_STAGES } from "@/server/orders/service";

describe("kitchenTransition", () => {
  it("avanza Nuevo → En preparación", () => {
    expect(kitchenTransition("Nuevo pedido", "En preparación")).toBe("move");
  });

  it("avanza En preparación → Listo", () => {
    expect(kitchenTransition("En preparación", "Listo")).toBe("move");
  });

  it("el mismo destino es duplicado, no movimiento", () => {
    expect(kitchenTransition("Nuevo pedido", "Nuevo pedido")).toBe(
      "duplicate",
    );
    expect(kitchenTransition("En preparación", "En preparación")).toBe(
      "duplicate",
    );
  });

  it("rechaza retrocesos y saltos", () => {
    expect(kitchenTransition("En preparación", "Nuevo pedido")).toBe("invalid");
    expect(kitchenTransition("Nuevo pedido", "Listo")).toBe("invalid");
    expect(kitchenTransition("Listo", "En preparación")).toBe("invalid");
  });

  it("rechaza etapas fuera de la cocina", () => {
    expect(kitchenTransition("Pagado", "Listo")).toBe("invalid");
    expect(kitchenTransition("Entregado", "Listo")).toBe("invalid");
    expect(kitchenTransition("Nuevo pedido", "Pagado")).toBe("invalid");
  });
});

describe("ORDER_STAGES con Listo", () => {
  it("Listo queda entre En preparación y Entregado", () => {
    const names = ORDER_STAGES.map((s) => s.name);
    expect(names.indexOf("Listo")).toBeGreaterThan(
      names.indexOf("En preparación"),
    );
    expect(names.indexOf("Listo")).toBeLessThan(names.indexOf("Entregado"));
  });
});
