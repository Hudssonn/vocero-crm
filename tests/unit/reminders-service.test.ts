import { describe, expect, it } from "vitest";
import {
  calcularScheduledAt,
  decideGeneracion,
  MAX_INTENTOS,
  MS_REINTENTO,
  siguienteReintento,
} from "@/server/reminders/service";
import { reminderConfigSchema as configSchema } from "@/server/reminders/config";

/**
 * 047 — Lógica pura del servicio de recordatorios (sin BD): cuándo se
 * genera, a qué hora sale y cómo crece el backoff de reintento.
 */
const CITA = new Date("2026-11-05T16:30:00.000Z");

describe("calcularScheduledAt", () => {
  it("resta las horas antes de la cita", () => {
    expect(calcularScheduledAt(CITA, 24)).toEqual(
      new Date("2026-11-04T16:30:00.000Z")
    );
  });

  it("con 1 hora queda una hora antes", () => {
    expect(calcularScheduledAt(CITA, 1)).toEqual(
      new Date("2026-11-05T15:30:00.000Z")
    );
  });
});

describe("decideGeneracion", () => {
  it("cita agendada con config encendida → se genera", () => {
    expect(
      decideGeneracion({
        configEnabled: true,
        bookingStatus: "agendada",
        bookingIsTest: false,
      })
    ).toEqual({ generar: true });
  });

  it("config apagada → no se genera", () => {
    expect(
      decideGeneracion({
        configEnabled: false,
        bookingStatus: "agendada",
        bookingIsTest: false,
      })
    ).toEqual({ generar: false, motivo: "config_apagada" });
  });

  it("cita de prueba (Laboratorio) → no se genera", () => {
    expect(
      decideGeneracion({
        configEnabled: true,
        bookingStatus: "agendada",
        bookingIsTest: true,
      })
    ).toEqual({ generar: false, motivo: "cita_de_prueba" });
  });

  it("cita no agendada (cancelada, realizada…) → no se genera", () => {
    for (const status of ["cancelada", "realizada", "no_show"]) {
      expect(
        decideGeneracion({
          configEnabled: true,
          bookingStatus: status,
          bookingIsTest: false,
        })
      ).toEqual({ generar: false, motivo: "cita_no_agendada" });
    }
  });
});

describe("backoff de reintento", () => {
  it("crece 10 minutos por intento", () => {
    const ahora = new Date("2026-11-04T00:00:00.000Z");
    expect(siguienteReintento(1, ahora)).toEqual(
      new Date(ahora.getTime() + MS_REINTENTO)
    );
    expect(siguienteReintento(2, ahora)).toEqual(
      new Date(ahora.getTime() + 2 * MS_REINTENTO)
    );
  });

  it("tres intentos como máximo", () => {
    expect(MAX_INTENTOS).toBe(3);
  });
});

describe("reminderConfigSchema (Zod)", () => {
  it("acepta una config válida", () => {
    expect(
      configSchema.safeParse({
        enabled: true,
        hoursBefore: 24,
        message: "Hola {{nombre}}",
      }).success
    ).toBe(true);
  });

  it("rechaza hoursBefore fuera de 1–72", () => {
    expect(
      configSchema.safeParse({
        enabled: true,
        hoursBefore: 0,
        message: "Hola",
      }).success
    ).toBe(false);
    expect(
      configSchema.safeParse({
        enabled: true,
        hoursBefore: 73,
        message: "Hola",
      }).success
    ).toBe(false);
  });

  it("rechaza mensaje vacío o demasiado largo", () => {
    expect(
      configSchema.safeParse({
        enabled: true,
        hoursBefore: 24,
        message: "   ",
      }).success
    ).toBe(false);
    expect(
      configSchema.safeParse({
        enabled: true,
        hoursBefore: 24,
        message: "x".repeat(501),
      }).success
    ).toBe(false);
  });
});
