import { describe, it, expect } from "vitest";
import {
  diagnosticoSchema,
  diagnosticoIdentity,
  etiquetaNegocio,
  formatDiagnosticoText,
  type DiagnosticoInput,
} from "@/server/diagnostico/service";

const base: DiagnosticoInput = {
  tipoNegocio: "restaurante",
  tipoNegocioOtro: null,
  problemas: ["Pierdo clientes de noche"],
  canales: ["WhatsApp"],
  modulos: ["Citas + recordatorios"],
  precioMensual: 30000,
  nombre: "Juan Pérez",
  telefono: "8888-8888",
  email: null,
};

describe("diagnosticoSchema", () => {
  it("acepta un diagnóstico completo", () => {
    const r = diagnosticoSchema.safeParse(base);
    expect(r.success).toBe(true);
  });

  it("acepta mínimos sin opcionales", () => {
    const r = diagnosticoSchema.safeParse({
      tipoNegocio: "tienda",
      problemas: ["No doy abasto"],
      precioMensual: 25000,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.canales).toBeUndefined();
      expect(r.data.modulos).toBeUndefined();
    }
  });

  it("rechaza sin tipoNegocio", () => {
    const r = diagnosticoSchema.safeParse({ ...base, tipoNegocio: "" });
    expect(r.success).toBe(false);
  });

  it("rechaza problemas vacío", () => {
    const r = diagnosticoSchema.safeParse({ ...base, problemas: [] });
    expect(r.success).toBe(false);
  });

  it("rechaza precioMensual no positivo", () => {
    for (const precio of [0, -5000]) {
      const r = diagnosticoSchema.safeParse({ ...base, precioMensual: precio });
      expect(r.success).toBe(false);
    }
  });

  it("rechaza precioMensual no numérico", () => {
    const r = diagnosticoSchema.safeParse({
      ...base,
      precioMensual: "30000",
    });
    expect(r.success).toBe(false);
  });
});

describe("diagnosticoIdentity", () => {
  it("genera identidades únicas con prefijo diagnostico:", () => {
    const a = diagnosticoIdentity();
    const b = diagnosticoIdentity();
    expect(a.startsWith("diagnostico:")).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("etiquetaNegocio", () => {
  it("usa tipoNegocioOtro cuando el tipo es otro", () => {
    expect(
      etiquetaNegocio({ ...base, tipoNegocio: "otro", tipoNegocioOtro: "Panadería" }),
    ).toBe("Panadería");
  });

  it("cae al id cuando otro viene vacío", () => {
    expect(
      etiquetaNegocio({ ...base, tipoNegocio: "otro", tipoNegocioOtro: "   " }),
    ).toBe("otro");
  });

  it("usa el id para tipos conocidos", () => {
    expect(etiquetaNegocio(base)).toBe("restaurante");
  });
});

describe("formatDiagnosticoText", () => {
  it("incluye negocio, problemas, módulos y precio", () => {
    const t = formatDiagnosticoText(base);
    expect(t).toContain("Diagnóstico web — SolidGround");
    expect(t).toContain("Negocio: restaurante");
    expect(t).toContain("- Pierdo clientes de noche");
    expect(t).toContain("- Citas + recordatorios");
    expect(t).toContain("Precio mensual: ₡30.000");
    expect(t).toContain("Nombre: Juan Pérez");
    expect(t).toContain("Teléfono: 8888-8888");
  });

  it("omite líneas vacías y usa el texto de otro", () => {
    const t = formatDiagnosticoText({
      ...base,
      tipoNegocio: "otro",
      tipoNegocioOtro: "Salón de belleza",
      nombre: null,
      telefono: null,
      email: null,
      canales: [],
      modulos: [],
    });
    expect(t).toContain("Negocio: Salón de belleza");
    expect(t).not.toContain("Nombre:");
    expect(t).not.toContain("Teléfono:");
    expect(t).not.toContain("Correo:");
    expect(t).not.toContain("Canales:");
    expect(t).not.toContain("Módulos recomendados:");
  });
});
