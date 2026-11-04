import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeAvailability } from "@/server/agenda/availability";
import { createBlock, BookingError } from "@/server/agenda/service";
import {
  DEFAULT_CALENDAR_SETTINGS,
  type CalendarSettings,
} from "@/server/agenda/settings";

/**
 * BUG 1 — doble booking por diseño, en dos mitades:
 *
 * 1. `createBlock` (service.ts) insertaba sin validar nada: el índice único
 *    parcial solo frena el instante exacto, así que un bloqueo encima de una
 *    cita agendada (o de otro bloqueo) entraba sin que nada lo detuviera.
 *    El fix valida el solape ANTES de insertar y lanza `slot_taken`.
 *
 * 2. `getBusyIntervals` (availability.ts) filtraba con
 *    `gte(scheduledAt, fromUtc)`: un bloqueo que cruza la medianoche
 *    (23:00 → 09:00) no aparecía en el cómputo del día siguiente y se
 *    ofrecían huecos ocupados. El fix usa criterio de solape en la consulta.
 *
 * Estos tests no tocan Postgres: mockean `getDb` y verifican el
 * comportamiento del código con las filas que la consulta (ya corregida)
 * devolvería. El guardarraíl de la última sección fija el texto del criterio
 * SQL para que el cambio no se revierta en silencio.
 */

type FilaOcupante = {
  id: string;
  scheduledAt: Date;
  durationMinutes: number;
};

const estado = vi.hoisted(() => ({
  filasOcupantes: [] as FilaOcupante[],
  insertLlamado: false,
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(estado.filasOcupantes),
      }),
    }),
    insert: () => ({
      values: (v: unknown) => ({
        returning: () => {
          estado.insertLlamado = true;
          return Promise.resolve([
            { ...(v as Record<string, unknown>), id: "booking_blk1" },
          ]);
        },
      }),
    }),
  }),
  schema: {
    booking: {
      id: "id",
      organizationId: "organizationId",
      kind: "kind",
      status: "status",
      source: "source",
      scheduledAt: "scheduledAt",
      durationMinutes: "durationMinutes",
      notes: "notes",
      isTest: "isTest",
    },
  },
}));

const ORG = "org_1";

const AJUSTES: CalendarSettings = {
  ...DEFAULT_CALENDAR_SETTINGS,
  timezone: "America/Costa_Rica", // UTC-6 fijo, sin horario de verano
  slotMinutes: 30,
  bufferMinutes: 0,
  minNoticeHours: 0,
  weeklyHours: {
    mon: [],
    tue: [],
    wed: [],
    thu: [{ start: "08:00", end: "18:00" }],
    fri: [],
    sat: [],
    sun: [],
  },
};

describe("createBlock valida el solape antes de insertar", () => {
  beforeEach(() => {
    estado.filasOcupantes = [];
    estado.insertLlamado = false;
  });

  it("rechaza el bloqueo que pisa parcialmente una cita agendada", async () => {
    // Cita 14:00–15:00 UTC; el bloqueo 14:30–15:30 la pisa.
    estado.filasOcupantes = [
      {
        id: "booking_cita1",
        scheduledAt: new Date("2026-11-05T14:00:00.000Z"),
        durationMinutes: 60,
      },
    ];
    await expect(
      createBlock({
        organizationId: ORG,
        startUtc: "2026-11-05T14:30:00.000Z",
        durationMinutes: 60,
      })
    ).rejects.toMatchObject({ code: "slot_taken" });
    expect(estado.insertLlamado).toBe(false);
  });

  it("rechaza el bloqueo que envuelve por completo a otro bloqueo", async () => {
    // Bloqueo existente 10:00–12:00; el nuevo 09:00–13:00 lo contiene.
    estado.filasOcupantes = [
      {
        id: "booking_blk0",
        scheduledAt: new Date("2026-11-05T10:00:00.000Z"),
        durationMinutes: 120,
      },
    ];
    const promesa = createBlock({
      organizationId: ORG,
      startUtc: "2026-11-05T09:00:00.000Z",
      durationMinutes: 240,
    });
    await expect(promesa).rejects.toBeInstanceOf(BookingError);
    await expect(promesa).rejects.toMatchObject({ code: "slot_taken" });
    expect(estado.insertLlamado).toBe(false);
  });

  it("permite el bloqueo adyacente: termina donde empieza la cita", async () => {
    // [14:00, 15:00) no se solapa con [15:00, 16:00): el borde no cuenta.
    estado.filasOcupantes = [
      {
        id: "booking_cita1",
        scheduledAt: new Date("2026-11-05T15:00:00.000Z"),
        durationMinutes: 60,
      },
    ];
    const bloque = await createBlock({
      organizationId: ORG,
      startUtc: "2026-11-05T14:00:00.000Z",
      durationMinutes: 60,
    });
    expect(estado.insertLlamado).toBe(true);
    expect(bloque.id).toBe("booking_blk1");
  });

  it("permite el bloqueo cuando no hay nada activo encima", async () => {
    estado.filasOcupantes = [];
    const bloque = await createBlock({
      organizationId: ORG,
      startUtc: "2026-11-05T14:00:00.000Z",
      durationMinutes: 60,
      notes: "inventario",
    });
    expect(estado.insertLlamado).toBe(true);
    expect(bloque.id).toBe("booking_blk1");
  });

  it("duración inválida se rechaza antes de tocar la base", async () => {
    await expect(
      createBlock({
        organizationId: ORG,
        startUtc: "2026-11-05T14:00:00.000Z",
        durationMinutes: 0,
      })
    ).rejects.toMatchObject({ code: "invalid" });
    expect(estado.insertLlamado).toBe(false);
  });
});

describe("getBusyIntervals incluye lo que cruza la medianoche", () => {
  beforeEach(() => {
    estado.filasOcupantes = [];
    estado.insertLlamado = false;
  });

  it("un bloqueo 23:00→09:00 ocupa la mañana del día siguiente", async () => {
    // Bloqueo 23:00 CST (5 nov 05:00Z) → 09:00 CST (5 nov 15:00Z).
    // Empieza ANTES de fromUtc (5 nov 06:00Z) pero termina después:
    // con el criterio viejo (gte) la consulta jamás lo devolvía.
    estado.filasOcupantes = [
      {
        id: "booking_blkNoche",
        scheduledAt: new Date("2026-11-05T05:00:00.000Z"),
        durationMinutes: 600,
      },
    ];
    const huecos = await computeAvailability(ORG, {
      fromISO: "2026-11-05", // jueves
      toISO: "2026-11-05",
      now: new Date("2026-11-04T12:00:00.000Z"),
      settings: AJUSTES,
    });
    const inicios = huecos.map((h) => h.startUtc);
    // La mañana cubierta por el bloqueo no se ofrece…
    expect(inicios).not.toContain("2026-11-05T14:00:00.000Z"); // 08:00 CST
    expect(inicios).not.toContain("2026-11-05T14:30:00.000Z"); // 08:30 CST
    // …pero al terminar el bloqueo (09:00 CST) la agenda sigue viva.
    expect(inicios).toContain("2026-11-05T15:00:00.000Z"); // 09:00 CST
    expect(inicios).toContain("2026-11-05T16:00:00.000Z"); // 10:00 CST
  });
});

describe("guardarraíl: el criterio de solape no se revierte", () => {
  const raiz = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const availabilitySrc = readFileSync(
    join(raiz, "src/server/agenda/availability.ts"),
    "utf8"
  );
  const serviceSrc = readFileSync(
    join(raiz, "src/server/agenda/service.ts"),
    "utf8"
  );

  it("getBusyIntervals ya no usa gte/lte sobre scheduledAt", () => {
    expect(availabilitySrc).not.toContain(
      "gte(schema.booking.scheduledAt, input.fromUtc)"
    );
    expect(availabilitySrc).not.toContain(
      "lte(schema.booking.scheduledAt, input.toUtc)"
    );
  });

  it("ambos criterios calculan el fin del intervalo en SQL", () => {
    expect(availabilitySrc).toContain("interval '1 minute'");
    expect(serviceSrc).toContain("interval '1 minute'");
  });

  it("createBlock valida antes de insertar", () => {
    const cuerpo = serviceSrc.slice(
      serviceSrc.indexOf("export async function createBlock"),
      serviceSrc.indexOf("export async function rescheduleBooking")
    );
    expect(cuerpo).toContain("slot_taken");
    // La validación corre antes del insert, no solo en el catch.
    expect(cuerpo.indexOf("slot_taken")).toBeLessThan(cuerpo.indexOf(".insert("));
  });
});
