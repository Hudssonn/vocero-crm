import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOICE_AGENT_ID,
  VOICE_AGENTS,
  voiceAgentByAgentId,
  voiceAgentById,
} from "@/lib/voice-agents";

/**
 * 050 — El catálogo estático de agentes de voz. Tres agentes, cada uno con
 * su agent ID PÚBLICO de ElevenLabs (lo que pide el widget web). Aquí no va
 * ninguna llave API ni secreto: un agent ID que pareciera una llave es un
 * error de carga del catálogo, y esta prueba lo atrapa.
 */

describe("catálogo de agentes de voz", () => {
  it("son tres: Alex, Sofía y Luciano, con su negocio y su rol", () => {
    expect(VOICE_AGENTS.map((a) => a.nombre)).toEqual(["Alex", "Sofía", "Luciano"]);
    expect(VOICE_AGENTS.map((a) => a.negocio)).toEqual([
      "Expresiones Artísticas",
      "SolidGround",
      "SolidGround",
    ]);
    expect(VOICE_AGENTS.map((a) => a.rol)).toEqual([
      "Vendedor",
      "Asesora laboral",
      "Vendedor",
    ]);
  });

  it("cada uno trae su agent ID público de ElevenLabs, sin secretos", () => {
    expect(VOICE_AGENTS.map((a) => a.agentId)).toEqual([
      "agent_7601m4f7a5swe9et2q3c2hmrn7pb",
      "agent_1401m4fnaet4fda9q53rwx6ceh5h",
      "agent_8801m4gb7nnze8kaqsh1gc5ddpxx",
    ]);
    // Los agent IDs son únicos y ninguno parece una llave (sk-… o similar).
    const ids = VOICE_AGENTS.map((a) => a.agentId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id.startsWith("agent_")).toBe(true);
      expect(id).not.toMatch(/sk-|api[_-]?key|secret|token/i);
    }
  });

  it("estado configurado activo y sin número asignado todavía", () => {
    // "Activo" es lo configurado, no un health-check en vivo de ElevenLabs
    // (no existe endpoint público de estado); el número llega con Telnyx.
    for (const a of VOICE_AGENTS) {
      expect(a.estado).toBe("activo");
      expect(a.telefono).toBeNull();
    }
  });

  it("el selector cae en Alex por defecto y resuelve por id o por agent ID", () => {
    expect(DEFAULT_VOICE_AGENT_ID).toBe("alex");
    expect(voiceAgentById("sofia").nombre).toBe("Sofía");
    expect(voiceAgentById("luciano").agentId).toBe(
      "agent_8801m4gb7nnze8kaqsh1gc5ddpxx",
    );
    expect(voiceAgentById("inexistente").nombre).toBe("Alex");
    expect(voiceAgentById(null).nombre).toBe("Alex");
    expect(voiceAgentByAgentId("agent_1401m4fnaet4fda9q53rwx6ceh5h")?.nombre).toBe(
      "Sofía",
    );
    expect(voiceAgentByAgentId("agent_inexistente")).toBeNull();
    expect(voiceAgentByAgentId(null)).toBeNull();
  });
});
