import { describe, expect, it } from "vitest";
import {
  armarCsvCierre,
  ENCABEZADO_CIERRE,
  escaparCampoCsv,
  formatearColones,
  mesaOCodigoDeContacto,
  type FilaCierre,
} from "@/server/analytics/cierre";
import { colonesACentavos } from "@/server/leads/amount";
import { agentActionSchema } from "@/server/ai/actions";
import { buildAgentSystemPrompt } from "@/server/ai/prompts";

/**
 * 042 — Cierre de caja real. Pruebas puras, sin BD: el camino con BD
 * (quién ganó en el período, zona del negocio) se verifica en vivo en
 * devapp, igual que el resto de Resultados.
 */

const fila = (parcial: Partial<FilaCierre> & { cliente: string }): FilaCierre => ({
  fecha: "2026-10-28",
  mesaOCodigo: "",
  totalCents: null,
  currency: null,
  etapa: "Entregado",
  ...parcial,
});

describe("armarCsvCierre", () => {
  it("encabezado exacto, BOM al inicio y CRLF", () => {
    const csv = armarCsvCierre([], "CRC");
    expect(csv.startsWith("\uFEFF" + ENCABEZADO_CIERRE)).toBe(true);
    expect(ENCABEZADO_CIERRE).toBe("Fecha;Cliente;Mesa o código;Total (₡);Etapa");
    expect(csv).toContain("\r\n");
    expect(csv).not.toMatch(/(?<!\r)\n/);
  });

  it("sin filas trae encabezado + TOTAL en cero, nunca un archivo vacío", () => {
    expect(armarCsvCierre([], "CRC")).toBe(
      "\uFEFFFecha;Cliente;Mesa o código;Total (₡);Etapa\r\nTOTAL;;;0,00;\r\n"
    );
  });

  it("filas con total en colones, coma decimal y 2 decimales, y fila TOTAL", () => {
    const csv = armarCsvCierre(
      [
        fila({
          cliente: "Mesa 8 · Andrea",
          mesaOCodigo: "Mesa 8",
          totalCents: 430000,
          currency: "CRC",
        }),
        fila({
          cliente: "Para llevar P-9202 · Luis",
          mesaOCodigo: "Para llevar P-9202",
          totalCents: 1250,
          currency: "CRC",
        }),
      ],
      "CRC"
    );
    expect(csv).toContain(
      "2026-10-28;Mesa 8 · Andrea;Mesa 8;4300,00;Entregado\r\n"
    );
    expect(csv).toContain(
      "2026-10-28;Para llevar P-9202 · Luis;Para llevar P-9202;12,50;Entregado\r\n"
    );
    expect(csv).toContain("\r\nTOTAL;;;4312,50;\r\n");
  });

  it("monto NULL y moneda distinta salen con total vacío y NO suman", () => {
    const csv = armarCsvCierre(
      [
        fila({ cliente: "Cliente viejo", totalCents: null, currency: null }),
        fila({
          cliente: "Turista",
          totalCents: 100000,
          currency: "USD",
        }),
        fila({ cliente: "Andrea", totalCents: 180000, currency: "CRC" }),
      ],
      "CRC"
    );
    expect(csv).toContain("2026-10-28;Cliente viejo;;;Entregado\r\n");
    expect(csv).toContain("2026-10-28;Turista;;;Entregado\r\n");
    expect(csv).toContain("\r\nTOTAL;;;1800,00;\r\n");
  });

  it("ordena por fecha ascendente y luego por cliente", () => {
    const csv = armarCsvCierre(
      [
        fila({ fecha: "2026-10-28", cliente: "Zulma", totalCents: 100, currency: "CRC" }),
        fila({ fecha: "2026-10-27", cliente: "Andrea", totalCents: 100, currency: "CRC" }),
        fila({ fecha: "2026-10-28", cliente: "Andrea", totalCents: 100, currency: "CRC" }),
      ],
      "CRC"
    );
    const lineas = csv.split("\r\n");
    expect(lineas[1]).toMatch(/^2026-10-27;Andrea;/);
    expect(lineas[2]).toMatch(/^2026-10-28;Andrea;/);
    expect(lineas[3]).toMatch(/^2026-10-28;Zulma;/);
  });

  it("escapa `;`, comillas y saltos de línea en los campos", () => {
    expect(escaparCampoCsv("Ana; López")).toBe('"Ana; López"');
    expect(escaparCampoCsv('Ana "La" López')).toBe('"Ana ""La"" López"');
    expect(escaparCampoCsv("Ana\nLópez")).toBe('"Ana\nLópez"');
    expect(escaparCampoCsv("Andrea")).toBe("Andrea");
    const csv = armarCsvCierre(
      [fila({ cliente: 'Ana; "La"\nLópez', totalCents: 100, currency: "CRC" })],
      "CRC"
    );
    expect(csv).toContain('2026-10-28;"Ana; ""La""\nLópez";;1,00;Entregado\r\n');
  });
});

describe("formatearColones", () => {
  it("coma decimal y 2 decimales", () => {
    expect(formatearColones(430000)).toBe("4300,00");
    expect(formatearColones(1250)).toBe("12,50");
    expect(formatearColones(5)).toBe("0,05");
    expect(formatearColones(0)).toBe("0,00");
  });
});

describe("mesaOCodigoDeContacto", () => {
  it("pedido del menú: prefijo antes de ` · `", () => {
    expect(mesaOCodigoDeContacto("Mesa 4 · Andrea", true)).toBe("Mesa 4");
    expect(mesaOCodigoDeContacto("Para llevar P-9202 · Andrea", true)).toBe(
      "Para llevar P-9202"
    );
  });

  it("pedido del menú sin nombre: el identificador es el nombre entero", () => {
    expect(mesaOCodigoDeContacto("Mesa 4", true)).toBe("Mesa 4");
  });

  it("pedido por chat: vacío, el contacto no lleva identificador", () => {
    expect(mesaOCodigoDeContacto("Andrea", false)).toBe("");
    expect(mesaOCodigoDeContacto("Mesa 4 · Andrea", false)).toBe("");
  });
});

describe("colonesACentavos", () => {
  it("enteros y decimales", () => {
    expect(colonesACentavos(4300)).toBe(430000);
    expect(colonesACentavos(12.5)).toBe(1250);
  });

  it("redondeo con Math.round", () => {
    expect(colonesACentavos(10.005)).toBe(1001);
  });
});

describe("update_lead con amount (042)", () => {
  it("el esquema viejo sin amount sigue validando", () => {
    const viejo = agentActionSchema(false).safeParse({
      action: "update_lead",
      note: "Pidió dos hamburguesas",
      reply: "Perfecto, dos hamburguesas.",
    });
    expect(viejo.success).toBe(true);
  });

  it("con amount válido valida", () => {
    const nuevo = agentActionSchema(false).safeParse({
      action: "update_lead",
      note: "Pedido confirmado",
      reply: "Total: ₡4300",
      amount: 4300,
    });
    expect(nuevo.success).toBe(true);
    if (nuevo.success && nuevo.data.action === "update_lead") {
      expect(nuevo.data.amount).toBe(4300);
    }
  });

  it("el prompt describe el campo opcional y la regla de no inventar el total", () => {
    const profile = {
      name: "Sofía",
      tone: null,
      instructions: null,
      escalationRules: null,
      greeting: null,
    } as unknown as Parameters<typeof buildAgentSystemPrompt>[0]["profile"];
    const p = buildAgentSystemPrompt({
      profile,
      kb: [],
      stages: [{ name: "Nuevo" }],
    });
    const linea =
      p.split("\n").find((l) => l.startsWith('- {"action":"update_lead"')) ?? "";
    expect(linea).toMatch(/amount/);
    expect(linea).toMatch(/total en colones que estás confirmando en reply/);
    expect(linea).toMatch(/nunca se inventa ni se estima/);
  });
});
