/**
 * 050 — Catálogo estático de los agentes de voz (ElevenLabs).
 *
 * ESTÁTICO a propósito: los tres agentes ya existen en ElevenLabs y el CRM
 * no los crea ni los administra; esta lista solo dice quiénes son y con qué
 * agent ID público se prueba cada uno en el widget web. El `agentId` es
 * público por diseño (es lo que el widget de ElevenLabs pide en el
 * navegador); aquí NO va ninguna llave API ni secreto.
 *
 * Visible en TODAS las instancias con `VOZ=on`: el catálogo no se filtra
 * por organización — una instancia = un negocio, y la bandera es la que
 * decide si la pestaña existe.
 *
 * `estado: "activo"` es estado CONFIGURADO, no un health-check en vivo:
 * ElevenLabs no expone endpoint público de estado del agente, así que nadie
 * puede afirmar desde aquí si el agente responde en este momento. La UI lo
 * dice con esas palabras.
 *
 * `telefono: null` = sin número asignado todavía (la compra en Telnyx está
 * pendiente). Cuando un agente tenga número, se pone aquí y la UI lo enseña.
 */

export type VoiceAgentStatus = "activo";

export type VoiceAgent = {
  /** Clave estable para el selector y la URL. */
  id: "alex" | "sofia" | "luciano";
  /** Nombre con el que se presenta. */
  nombre: string;
  /** Negocio al que atiende. */
  negocio: string;
  /** Qué hace cuando atiende. */
  rol: string;
  /** Agent ID PÚBLICO de ElevenLabs (lo pide el widget web). */
  agentId: string;
  /** Estado configurado — ver el comentario del módulo, no es en vivo. */
  estado: VoiceAgentStatus;
  /** Número asignado para llamarlo; null = todavía no tiene. */
  telefono: string | null;
};

export const VOICE_AGENTS: VoiceAgent[] = [
  {
    id: "alex",
    nombre: "Alex",
    negocio: "Expresiones Artísticas",
    rol: "Vendedor",
    agentId: "agent_7601m4f7a5swe9et2q3c2hmrn7pb",
    estado: "activo",
    telefono: null,
  },
  {
    id: "sofia",
    nombre: "Sofía",
    negocio: "SolidGround",
    rol: "Asesora laboral",
    agentId: "agent_1401m4fnaet4fda9q53rwx6ceh5h",
    estado: "activo",
    telefono: null,
  },
  {
    id: "luciano",
    nombre: "Luciano",
    negocio: "SolidGround",
    rol: "Vendedor",
    agentId: "agent_8801m4gb7nnze8kaqsh1gc5ddpxx",
    estado: "activo",
    telefono: null,
  },
];

export const DEFAULT_VOICE_AGENT_ID: VoiceAgent["id"] = "alex";

export function voiceAgentById(id: string | null | undefined): VoiceAgent {
  return VOICE_AGENTS.find((a) => a.id === id) ?? VOICE_AGENTS[0]!;
}

export function voiceAgentByAgentId(agentId: string | null | undefined): VoiceAgent | null {
  if (!agentId) return null;
  return VOICE_AGENTS.find((a) => a.agentId === agentId) ?? null;
}
