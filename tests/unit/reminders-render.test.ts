import { describe, expect, it } from "vitest";
import {
  formatFecha,
  formatHora,
  renderReminderMessage,
} from "@/server/reminders/render";

/**
 * 047 — El render del recordatorio es puro: plantilla + datos de la cita +
 * zona del negocio. Cita: 2026-11-05 16:30 UTC = 10:30 en America/Costa_Rica.
 */
const CITA = new Date("2026-11-05T16:30:00.000Z");
const TZ = "America/Costa_Rica";

describe("renderReminderMessage", () => {
  it("sustituye nombre, fecha y hora en la zona del negocio", () => {
    const texto = renderReminderMessage(
      "Hola {{nombre}}, tu cita es el {{fecha}} a las {{hora}}.",
      { nombre: "María", citaUtc: CITA, timezone: TZ }
    );
    expect(texto).toContain("Hola María,");
    expect(texto).toContain("5 de noviembre de 2026");
    expect(texto).toMatch(/10:30/);
  });

  it("tolera espacios dentro de las llaves", () => {
    const texto = renderReminderMessage("{{ nombre }} el {{ fecha }}", {
      nombre: "Juan",
      citaUtc: CITA,
      timezone: TZ,
    });
    expect(texto).toContain("Juan");
    expect(texto).toContain("5 de noviembre de 2026");
  });

  it("sin nombre usa «cliente» en vez de dejar hueco", () => {
    const texto = renderReminderMessage("Hola {{nombre}}", {
      nombre: null,
      citaUtc: CITA,
      timezone: TZ,
    });
    expect(texto).toBe("Hola cliente");
  });

  it("una variable desconocida se deja intacta (no silenciosa)", () => {
    const texto = renderReminderMessage("Hola {{nombree}}", {
      nombre: "Ana",
      citaUtc: CITA,
      timezone: TZ,
    });
    expect(texto).toBe("Hola {{nombree}}");
  });

  it("zona inválida cae al fallback sin tumbar el render", () => {
    const texto = renderReminderMessage("{{fecha}} {{hora}}", {
      nombre: "Ana",
      citaUtc: CITA,
      timezone: "Zona/Inventada",
    });
    expect(texto).toContain("5 de noviembre de 2026");
  });

  it("otra zona horaria mueve la hora de pared", () => {
    // 16:30 UTC = 11:30 en Bogotá (UTC-5).
    const hora = formatHora(CITA, "America/Bogota");
    expect(hora).toMatch(/11:30/);
  });
});

describe("formatFecha / formatHora", () => {
  it("fecha en español con día, mes y año", () => {
    expect(formatFecha(CITA, TZ)).toBe("5 de noviembre de 2026");
  });

  it("hora con minutos en la zona del negocio", () => {
    expect(formatHora(CITA, TZ)).toMatch(/^10:30/);
  });
});
