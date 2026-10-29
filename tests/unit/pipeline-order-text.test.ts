import { describe, expect, it } from "vitest";
import {
  boardOrderText,
  firstMessageTextByConversation,
  hasOrderConfirmedMarker,
} from "@/server/orders/order-text";

/** 037 — El cajón del pipeline enseña el primer mensaje del pedido.
 * Pruebas puras, sin base de datos: la ruta solo lee las filas y esta
 * función elige cuál es el primer mensaje de cada conversación. */

describe("firstMessageTextByConversation", () => {
  it("gana el mensaje más antiguo aunque la lista venga desordenada", () => {
    const result = firstMessageTextByConversation([
      {
        conversationId: "cv_1",
        text: "segundo mensaje",
        createdAt: new Date("2026-10-28T10:01:00Z"),
      },
      {
        conversationId: "cv_1",
        text: "Pedido desde el menú QR",
        createdAt: new Date("2026-10-28T10:00:00Z"),
      },
    ]);
    expect(result.get("cv_1")).toBe("Pedido desde el menú QR");
  });

  it("separa por conversación: cada una guarda su propio primer mensaje", () => {
    const result = firstMessageTextByConversation([
      {
        conversationId: "cv_1",
        text: "primer pedido",
        createdAt: new Date("2026-10-28T10:00:00Z"),
      },
      {
        conversationId: "cv_2",
        text: "otro pedido",
        createdAt: new Date("2026-10-28T09:00:00Z"),
      },
      {
        conversationId: "cv_1",
        text: "después",
        createdAt: new Date("2026-10-28T11:00:00Z"),
      },
    ]);
    expect(result.get("cv_1")).toBe("primer pedido");
    expect(result.get("cv_2")).toBe("otro pedido");
  });

  it("en empate de hora gana el primero que llegó en la lista", () => {
    const same = new Date("2026-10-28T10:00:00Z");
    const result = firstMessageTextByConversation([
      { conversationId: "cv_1", text: "primero", createdAt: same },
      { conversationId: "cv_1", text: "segundo", createdAt: same },
    ]);
    expect(result.get("cv_1")).toBe("primero");
  });

  it("sin mensajes no devuelve nada, y una conversación sin mensajes no aparece", () => {
    expect(firstMessageTextByConversation([]).size).toBe(0);
    const result = firstMessageTextByConversation([
      {
        conversationId: "cv_1",
        text: "hola",
        createdAt: new Date("2026-10-28T10:00:00Z"),
      },
    ]);
    expect(result.has("cv_2")).toBe(false);
  });

  it("un primer mensaje sin texto queda en null, no lo tapa el siguiente", () => {
    const result = firstMessageTextByConversation([
      {
        conversationId: "cv_1",
        text: null,
        createdAt: new Date("2026-10-28T10:00:00Z"),
      },
      {
        conversationId: "cv_1",
        text: "después",
        createdAt: new Date("2026-10-28T10:01:00Z"),
      },
    ]);
    expect(result.get("cv_1")).toBe(null);
  });
});

/** 041 — Texto del board para pedidos por chat. Pura, sin BD: recibe
 * los mensajes de UNA conversación en orden asc por createdAt. */
describe("boardOrderText", () => {
  it("con dos marcadores gana el último", () => {
    expect(
      boardOrderText([
        { text: "hola" },
        { text: "PEDIDO CONFIRMADO\nprimer cierre" },
        { text: "PEDIDO CONFIRMADO\ncierre final" },
      ]),
    ).toBe("PEDIDO CONFIRMADO\ncierre final");
  });

  it("un mensaje posterior sin marcador no tapa al confirmado", () => {
    expect(
      boardOrderText([
        { text: "hola" },
        { text: "PEDIDO CONFIRMADO\n2x casado" },
        { text: "gracias" },
      ]),
    ).toBe("PEDIDO CONFIRMADO\n2x casado");
  });

  it("sin marcador devuelve el primer mensaje, aunque el primero sea null", () => {
    expect(boardOrderText([{ text: "hola" }, { text: "después" }])).toBe("hola");
    expect(boardOrderText([{ text: null }, { text: "después" }])).toBeNull();
  });

  it("los mensajes sin texto no pueden tener marcador y no lo inventan", () => {
    expect(
      boardOrderText([{ text: null }, { text: "PEDIDO CONFIRMADO\nok" }]),
    ).toBe("PEDIDO CONFIRMADO\nok");
    expect(boardOrderText([])).toBeNull();
  });

  it("el marcador vale tras trim, pero no en medio del texto", () => {
    expect(hasOrderConfirmedMarker("  PEDIDO CONFIRMADO\n2x casado")).toBe(true);
    expect(hasOrderConfirmedMarker("ojo: PEDIDO CONFIRMADO")).toBe(false);
    expect(hasOrderConfirmedMarker(null)).toBe(false);
  });
});
