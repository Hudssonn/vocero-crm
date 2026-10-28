import { describe, expect, it } from "vitest";
import { assembleOrderBoard } from "@/server/orders/board";

/** 034 — Tablero de la pantalla de cocina. Pruebas puras, sin BD: el
 * camino con BD se verifica en vivo en devapp (Principio IX). */

const stages = [
  { id: "stg-ventas", name: "Nuevo", kind: "open" },
  { id: "stg-nuevo", name: "Nuevo pedido", kind: "open" },
  { id: "stg-prep", name: "En preparación", kind: "open" },
  { id: "stg-pagado", name: "Pagado", kind: "open" },
  { id: "stg-cliente", name: "Cliente", kind: "won" },
  { id: "stg-entregado", name: "Entregado", kind: "won" },
  { id: "stg-perdido", name: "Perdido", kind: "lost" },
];

const leads = [
  { leadId: "ld-1", stageId: "stg-nuevo", name: "Mesa 5", conversationId: "cv-1" },
  { leadId: "ld-2", stageId: "stg-prep", name: "Mesa 2", conversationId: "cv-2" },
  { leadId: "ld-3", stageId: "stg-nuevo", name: "Para llevar P-9", conversationId: null },
];

const messages = [
  { conversationId: "cv-1", text: "Pedido mesa 5", createdAt: new Date("2026-10-27T22:49:00.000Z") },
  { conversationId: "cv-1", text: "respuesta posterior", createdAt: new Date("2026-10-27T22:55:00.000Z") },
  { conversationId: "cv-2", text: "Pedido mesa 2", createdAt: new Date("2026-10-27T22:50:00.000Z") },
];

describe("assembleOrderBoard", () => {
  it("deja fuera las etapas que no son de pedidos", () => {
    const board = assembleOrderBoard(stages, leads, messages);
    expect(board.stages.map((s) => s.name)).toEqual([
      "Nuevo pedido",
      "En preparación",
      "Entregado",
    ]);
  });

  it("por tarjeta pega el PRIMER mensaje (el texto del pedido), no el último", () => {
    const board = assembleOrderBoard(stages, leads, messages);
    const mesa5 = board.orders.find((o) => o.leadId === "ld-1");
    expect(mesa5?.text).toBe("Pedido mesa 5");
    expect(mesa5?.orderedAt).toBe("2026-10-27T22:49:00.000Z");
    expect(mesa5?.name).toBe("Mesa 5");
    expect(mesa5?.stageId).toBe("stg-nuevo");
  });

  it("040 — conserva el orden de entrada: no reordena a ascendente", () => {
    // `assembleOrderBoard` no ordena; el orden lo pone la consulta
    // (`orderBy(desc(position))` en `board.ts`). Si la BD entrega
    // nuevo-arriba, la pantalla lo recibe nuevo-arriba.
    const board = assembleOrderBoard(
      stages,
      [
        { leadId: "ld-nuevo", stageId: "stg-nuevo", name: "Mesa 9", conversationId: null },
        { leadId: "ld-viejo", stageId: "stg-nuevo", name: "Mesa 1", conversationId: null },
      ],
      [],
    );
    expect(board.orders.map((o) => o.leadId)).toEqual(["ld-nuevo", "ld-viejo"]);
  });

  it("sin conversación, texto y hora quedan en null sin tumbar el resto", () => {
    const board = assembleOrderBoard(stages, leads, messages);
    const llevar = board.orders.find((o) => o.leadId === "ld-3");
    expect(llevar?.text).toBeNull();
    expect(llevar?.orderedAt).toBeNull();
    expect(board.orders).toHaveLength(3);
  });
});
