import { describe, expect, it } from "vitest";
import {
  comparePositionDesc,
  dropPositionAtTop,
} from "@/lib/pipeline-order";

/** 040 — Pedidos (y leads) nuevos arriba: posición mayor primero.
 * Puras, sin BD: el componente (`pipeline-client.tsx`) no tiene
 * tests, así que la lógica de orden vive aquí probada y el
 * componente solo la usa. */

describe("comparePositionDesc", () => {
  it("ordena de mayor a menor: el más nuevo (posición más alta) queda arriba", () => {
    const leads = [
      { id: "viejo", position: 0 },
      { id: "nuevo", position: 2 },
      { id: "medio", position: 1 },
    ];
    expect([...leads].sort(comparePositionDesc).map((l) => l.id)).toEqual([
      "nuevo",
      "medio",
      "viejo",
    ]);
  });

  it("una posición MAYOR que la del primero queda arriba", () => {
    const columna = [{ position: 2 }, { position: 1 }, { position: 0 }];
    const arriba = { position: 3 };
    expect([...columna, arriba].sort(comparePositionDesc)[0]).toBe(arriba);
  });

  it("una posición ENTRE dos vecinas queda en medio", () => {
    const columna = [{ position: 2 }, { position: 0 }];
    const medio = { position: 1 };
    expect([...columna, medio].sort(comparePositionDesc)).toEqual([
      { position: 2 },
      medio,
      { position: 0 },
    ]);
  });

  it("una posición MENOR que la del último queda abajo", () => {
    const columna = [{ position: 2 }, { position: 1 }];
    const abajo = { position: 0 };
    const orden = [...columna, abajo].sort(comparePositionDesc);
    expect(orden[orden.length - 1]).toBe(abajo);
  });
});

describe("dropPositionAtTop", () => {
  it("columna vacía: 0", () => {
    expect(dropPositionAtTop([])).toBe(0);
  });

  it("columna contigua: max + 1, no la cantidad (coinciden, pero por la razón correcta)", () => {
    expect(dropPositionAtTop([0, 1, 2])).toBe(3);
  });

  it("con huecos: max + 1, NUNCA la cantidad (la cantidad empataría)", () => {
    // Posiciones 0 y 2 (una tarjeta salió de la columna): la cantidad
    // es 2 y ya hay una tarjeta con 2; max + 1 da 3, sin empate.
    expect(dropPositionAtTop([0, 2])).toBe(3);
  });

  it("el orden de entrada no importa", () => {
    expect(dropPositionAtTop([2, 0, 1])).toBe(3);
  });

  it("el resultado queda arriba con el sort descendente", () => {
    const destino = [0, 2];
    const soltada = { position: dropPositionAtTop(destino) };
    const columna = [...destino.map((p) => ({ position: p })), soltada];
    expect(columna.sort(comparePositionDesc)[0]).toBe(soltada);
  });

  it("el resultado nunca es negativo (lo exige el PATCH del lead)", () => {
    expect(dropPositionAtTop([])).toBeGreaterThanOrEqual(0);
    expect(dropPositionAtTop([0])).toBeGreaterThanOrEqual(0);
  });
});
