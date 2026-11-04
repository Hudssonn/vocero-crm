import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/ai";
import type { AgendaTurn } from "@/server/agenda/agent";
import type { AgentActionType } from "@/server/ai/actions";
import {
  esAccionAgenda,
  notaFalloAgenda,
  resolverFalloAgenda,
  TEXTO_FALLO_AGENDA,
  type AccionAgenda,
} from "@/server/ai/agenda-fallo";

/**
 * BUG 4 — Cuando el motor de agenda no puede completar la acción, el modelo
 * lo ve en un segundo pase y reacciona (responde con sus palabras, pide otra
 * acción de agenda o deriva a un humano) en vez de entregar el texto crudo.
 */

const MENSAJES_BASE: ChatMessage[] = [
  { role: "system", content: "prompt del agente" },
  { role: "user", content: "quiero mover mi cita" },
];

const INTENTO: AccionAgenda = {
  action: "reschedule_slot",
  startUtc: "2026-11-05T14:00:00.000Z",
  reply: "¡Listo! Moví tu cita.",
};

const FALLO_MOTOR: AgendaTurn = {
  ok: false,
  text: "No encontré una cita activa para mover. ¿Querés que te agende una nueva?",
};

function segundoPaseFijo(respuesta: AgentActionType) {
  const llamadas: ChatMessage[][] = [];
  return {
    llamadas,
    preguntarModelo: async (msgs: ChatMessage[]) => {
      llamadas.push(msgs);
      return { ok: true as const, data: respuesta, raw: "{}" };
    },
  };
}

describe("esAccionAgenda", () => {
  it("reconoce las 4 acciones de agenda", () => {
    const acciones: AgentActionType[] = [
      { action: "offer_slots" },
      { action: "book_slot", startUtc: "x" },
      { action: "cancel_slot" },
      { action: "reschedule_slot", startUtc: "x" },
    ];
    for (const a of acciones) expect(esAccionAgenda(a)).toBe(true);
  });

  it("rechaza las acciones que no van al motor", () => {
    const acciones: AgentActionType[] = [
      { action: "none" },
      { action: "reply", text: "hola" },
      { action: "update_lead", note: "n" },
      { action: "move_stage", stage: "Nuevo" },
      { action: "handoff" },
    ];
    for (const a of acciones) expect(esAccionAgenda(a)).toBe(false);
  });
});

describe("notaFalloAgenda", () => {
  it("le dice al modelo qué intentó, qué pasó y que responda el JSON", () => {
    const nota = notaFalloAgenda(INTENTO, FALLO_MOTOR);
    expect(nota.role).toBe("system");
    expect(nota.content).toContain("reschedule_slot");
    expect(nota.content).toContain(JSON.stringify(INTENTO));
    expect(nota.content).toContain(FALLO_MOTOR.text);
    expect(nota.content).toContain("JSON de la acción");
    expect(nota.content).toContain("No repitas la misma acción");
  });
});

describe("TEXTO_FALLO_AGENDA", () => {
  it("es honesto: no finge una confirmación que nunca ocurrió", () => {
    expect(TEXTO_FALLO_AGENDA).not.toMatch(/listo|agendé/i);
    expect(TEXTO_FALLO_AGENDA.length).toBeGreaterThan(0);
  });
});

describe("resolverFalloAgenda", () => {
  it("el modelo reacciona con sus palabras: la acción nueva sigue su camino", async () => {
    const { llamadas, preguntarModelo } = segundoPaseFijo({
      action: "reply",
      text: "No encontré tu cita activa, pero te ofrezco estos horarios…",
    });
    const res = await resolverFalloAgenda({
      accion: INTENTO,
      turno: FALLO_MOTOR,
      messages: MENSAJES_BASE,
      preguntarModelo,
      ejecutarMotor: async () => {
        throw new Error("no debería llamarse al motor");
      },
    });
    expect(res.decision).toBe("accion-nueva");
    expect(llamadas).toHaveLength(1);
    // El segundo pase ve los mensajes originales + la nota del fallo.
    expect(llamadas[0]).toHaveLength(MENSAJES_BASE.length + 1);
    expect(llamadas[0]?.slice(0, -1)).toEqual(MENSAJES_BASE);
    const nota = llamadas[0]?.[llamadas[0].length - 1];
    expect(nota?.role).toBe("system");
    expect(nota?.content).toContain(FALLO_MOTOR.text);
    if (res.decision === "accion-nueva") {
      expect(res.action).toEqual({
        action: "reply",
        text: "No encontré tu cita activa, pero te ofrezco estos horarios…",
      });
    }
  });

  it("el modelo pide otra acción de agenda: UN reintento con el motor y se entrega", async () => {
    const otra: AccionAgenda = { action: "offer_slots" };
    const llamadasMotor: AccionAgenda[] = [];
    const { preguntarModelo } = segundoPaseFijo(otra);
    const reintento: AgendaTurn = { ok: true, text: "Tengo estos horarios…" };
    const res = await resolverFalloAgenda({
      accion: INTENTO,
      turno: FALLO_MOTOR,
      messages: MENSAJES_BASE,
      preguntarModelo,
      ejecutarMotor: async (a) => {
        llamadasMotor.push(a);
        return reintento;
      },
    });
    expect(llamadasMotor).toEqual([otra]);
    expect(res).toEqual({ decision: "texto-motor", turno: reintento });
  });

  it("si el segundo pase falla, se entrega el texto original del motor (como antes)", async () => {
    let motorLlamado = false;
    const res = await resolverFalloAgenda({
      accion: INTENTO,
      turno: FALLO_MOTOR,
      messages: MENSAJES_BASE,
      preguntarModelo: async () => ({
        ok: false as const,
        error: "provider_error" as const,
        detail: "se cayó el proveedor",
      }),
      ejecutarMotor: async () => {
        motorLlamado = true;
        return { ok: true, text: "nunca" };
      },
    });
    expect(motorLlamado).toBe(false);
    expect(res).toEqual({ decision: "texto-motor", turno: FALLO_MOTOR });
  });

  it("si el reintento del motor lanza, se entrega el turno original sin propagar", async () => {
    const { preguntarModelo } = segundoPaseFijo({
      action: "book_slot",
      startUtc: "2026-11-05T15:00:00.000Z",
    });
    const res = await resolverFalloAgenda({
      accion: INTENTO,
      turno: FALLO_MOTOR,
      messages: MENSAJES_BASE,
      preguntarModelo,
      ejecutarMotor: async () => {
        throw new Error("explotó el motor");
      },
    });
    expect(res).toEqual({ decision: "texto-motor", turno: FALLO_MOTOR });
  });

  it("el modelo puede derivar a un humano en el segundo pase", async () => {
    const { preguntarModelo } = segundoPaseFijo({
      action: "handoff",
      farewell: "Te comunico con el equipo.",
    });
    const res = await resolverFalloAgenda({
      accion: INTENTO,
      turno: FALLO_MOTOR,
      messages: MENSAJES_BASE,
      preguntarModelo,
      ejecutarMotor: async () => ({ ok: true, text: "nunca" }),
    });
    expect(res.decision).toBe("accion-nueva");
    if (res.decision === "accion-nueva") {
      expect(res.action.action).toBe("handoff");
    }
  });
});
