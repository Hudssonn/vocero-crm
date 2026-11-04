import { describe, it, expect } from "vitest";
import {
  diagnosticoSchema,
  calcularPrecioMensual,
  aplicarPrecioBackend,
  type DiagnosticoInput,
} from "@/server/diagnostico/service";

const base: DiagnosticoInput = {
  tipoNegocio: "restaurante",
  tipoNegocioOtro: null,
  problemas: ["Pierdo clientes de noche"],
  canales: ["whatsapp"],
  modulos: ["citas"],
  precioMensual: 25000,
  nombre: "Juan Pérez",
  telefono: "8888-8888",
  email: null,
};

describe("calcularPrecioMensual (replica la regla de la herramienta de diagnóstico)", () => {
  it("sin módulos cobra solo la base ₡25.000", () => {
    expect(calcularPrecioMensual([], false)).toBe(25000);
    expect(calcularPrecioMensual(null, false)).toBe(25000);
    expect(calcularPrecioMensual(undefined, null)).toBe(25000);
  });

  it("suma ₡10.000 por módulo", () => {
    expect(calcularPrecioMensual(["citas"], false)).toBe(35000);
    expect(calcularPrecioMensual(["citas", "campanas"], false)).toBe(45000);
    expect(calcularPrecioMensual(["citas", "campanas", "postventa"], false)).toBe(55000);
  });

  it("con 4 o más módulos aplica el paquete completo de ₡50.000", () => {
    const cuatro = ["citas", "campanas", "restaurante", "postventa"];
    expect(calcularPrecioMensual(cuatro, false)).toBe(50000);
    expect(calcularPrecioMensual([...cuatro, "otro"], false)).toBe(50000);
  });

  it("el VIP web suma ₡20.000 al total", () => {
    expect(calcularPrecioMensual([], true)).toBe(45000);
    expect(calcularPrecioMensual(["citas"], true)).toBe(55000);
    expect(calcularPrecioMensual(["citas", "campanas", "restaurante", "postventa"], true)).toBe(70000);
  });

  it("ignora módulos repetidos o vacíos", () => {
    expect(calcularPrecioMensual(["citas", "citas", "CITAS "], false)).toBe(35000);
    expect(calcularPrecioMensual(["", "   "], false)).toBe(25000);
  });
});

describe("BUG 3: el precio del request no se puede manipular", () => {
  it("aplicarPrecioBackend ignora el precioMensual que manda el frontend", () => {
    // Simula el ataque por curl: el frontend manda ₡1 con un módulo
    // seleccionado, o ₡999.999.999 inflado.
    for (const precioFalso of [1, 999999999]) {
      const corregido = aplicarPrecioBackend({
        ...base,
        modulos: ["citas"],
        precioMensual: precioFalso,
      });
      expect(corregido.precioMensual).toBe(35000);
    }
  });

  it("también corrige el precio falso cuando hay paquete completo + VIP", () => {
    const corregido = aplicarPrecioBackend({
      ...base,
      modulos: ["citas", "campanas", "restaurante", "postventa"],
      vipWeb: true,
      precioMensual: 1,
    });
    expect(corregido.precioMensual).toBe(70000);
  });

  it("no toca los demás campos del input", () => {
    const corregido = aplicarPrecioBackend({ ...base, precioMensual: 1 });
    expect(corregido.nombre).toBe(base.nombre);
    expect(corregido.modulos).toEqual(base.modulos);
  });
});

describe("diagnosticoSchema: precio finito (bonus del auditor)", () => {
  it("rechaza Infinity", () => {
    const r = diagnosticoSchema.safeParse({ ...base, precioMensual: Infinity });
    expect(r.success).toBe(false);
  });

  it("sigue aceptando precios positivos finitos", () => {
    const r = diagnosticoSchema.safeParse({ ...base, precioMensual: 45000 });
    expect(r.success).toBe(true);
  });
});
