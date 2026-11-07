import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isVozKeyConfigured, validVozKey, vozPostLlamadaSchema } from "@/server/voice/calls";

/**
 * 050 — Lo que el puente de voz manda y lo que el endpoint acepta.
 *
 * El puente de hoy (n8n, nodo "Normalizar") manda `instance`, `phone`,
 * `name`, `direction`, `duration_sec`, `summary` y `recording_url`. El
 * schema acepta esos campos MÁS los opcionales que el puente aún no envía
 * (`agent_id`, `conversation_id`, `transcript`): cuando lleguen, entran sin
 * tocar el endpoint. Lo que no viene queda NULL, no inventado.
 *
 * La llave (`X-Voz-Key` contra `VOZ_API_KEY`) sigue el mismo patrón que la
 * de `/api/bot/*`: mínimo 16 caracteres y comparación en tiempo constante.
 */

const ENV_ORIGINAL = { ...process.env };

beforeEach(() => {
  delete process.env.VOZ_API_KEY;
});

afterEach(() => {
  process.env = { ...ENV_ORIGINAL };
});

describe("vozPostLlamadaSchema: lo que manda el puente de hoy", () => {
  it("acepta el cuerpo completo del puente (nodo Normalizar)", () => {
    const parsed = vozPostLlamadaSchema.safeParse({
      instance: "tep",
      phone: "50688888888",
      name: "María",
      direction: "inbound",
      duration_sec: 95,
      summary: "Preguntó por precios.",
      recording_url: "",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("debió parsear");
    expect(parsed.data).toMatchObject({
      phone: "50688888888",
      name: "María",
      direction: "inbound",
      duration_sec: 95,
      summary: "Preguntó por precios.",
    });
    // El puente manda "" en lo que no trae: "" es ausente, no un dato.
    expect(parsed.data.recording_url).toBeUndefined();
  });

  it("acepta el mínimo: solo el teléfono", () => {
    const parsed = vozPostLlamadaSchema.safeParse({ phone: "50688888888" });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("debió parsear");
    expect(parsed.data?.phone).toBe("50688888888");
    // Lo que no viene no se inventa: queda ausente (NULL al guardar).
    expect(parsed.data?.name).toBeUndefined();
    expect(parsed.data?.summary).toBeUndefined();
    expect(parsed.data?.recording_url).toBeUndefined();
  });

  it("acepta los opcionales que el puente aún no envía", () => {
    const parsed = vozPostLlamadaSchema.safeParse({
      phone: "50688888888",
      agent_id: "agent_7601m4f7a5swe9et2q3c2hmrn7pb",
      conversation_id: "conv_abc123",
      transcript: "Agente: Hola. Cliente: Hola.",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("debió parsear");
    expect(parsed.data).toMatchObject({
      agent_id: "agent_7601m4f7a5swe9et2q3c2hmrn7pb",
      conversation_id: "conv_abc123",
      transcript: "Agente: Hola. Cliente: Hola.",
    });
  });

  it("sin teléfono la llamada se guarda igual: phone queda ausente (NULL)", () => {
    // El puente no siempre trae teléfono; perder la llamada por eso sería
    // peor que guardarla sin a quién atribuirla (la UI enseña "—").
    for (const [body, esperado] of [
      [{}, undefined],
      [{ phone: "" }, undefined],
      [{ phone: null }, null],
    ] as const) {
      const parsed = vozPostLlamadaSchema.safeParse(body);
      expect(parsed.success).toBe(true);
      if (!parsed.success) throw new Error("debió parsear");
      expect(parsed.data?.phone).toBe(esperado);
    }
  });

  it('"" se normaliza a ausente en los opcionales (no se guarda como dato)', () => {
    const parsed = vozPostLlamadaSchema.safeParse({
      phone: "50688888888",
      name: "",
      summary: "",
      recording_url: "",
      transcript: "",
      agent_id: "",
      conversation_id: "",
      instance: "",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("debió parsear");
    expect(parsed.data.name).toBeUndefined();
    expect(parsed.data.summary).toBeUndefined();
    expect(parsed.data.recording_url).toBeUndefined();
    expect(parsed.data.transcript).toBeUndefined();
    expect(parsed.data.agent_id).toBeUndefined();
    expect(parsed.data.conversation_id).toBeUndefined();
    expect(parsed.data.instance).toBeUndefined();
  });

  it("duration acepta número o string numérico; \"\" es ausente", () => {
    const numerica = vozPostLlamadaSchema.safeParse({
      phone: "50688888888",
      duration_sec: "95",
    });
    expect(numerica.success).toBe(true);
    if (!numerica.success) throw new Error("debió parsear");
    expect(numerica.data.duration_sec).toBe(95);
    const alias = vozPostLlamadaSchema.safeParse({
      phone: "50688888888",
      duration_secs: "30",
    });
    expect(alias.success).toBe(true);
    if (!alias.success) throw new Error("debió parsear");
    expect(alias.data.duration_secs).toBe(30);
    const vacia = vozPostLlamadaSchema.safeParse({
      phone: "50688888888",
      duration_sec: "",
    });
    expect(vacia.success).toBe(true);
    if (!vacia.success) throw new Error("debió parsear");
    expect(vacia.data.duration_sec).toBeUndefined();
    expect(
      vozPostLlamadaSchema.safeParse({ phone: "50688888888", duration_sec: "9.5" })
        .success,
    ).toBe(false);
  });

  it("recording_url solo acepta http(s)", () => {
    expect(
      vozPostLlamadaSchema.safeParse({
        phone: "50688888888",
        recording_url: "https://ejemplo.com/audio.mp3",
      }).success,
    ).toBe(true);
    expect(
      vozPostLlamadaSchema.safeParse({
        phone: "50688888888",
        recording_url: "http://ejemplo.com/audio.mp3",
      }).success,
    ).toBe(true);
    for (const mala of [
      "ftp://ejemplo.com/audio.mp3",
      "javascript:alert(1)",
      "no-es-una-url",
    ]) {
      expect(
        vozPostLlamadaSchema.safeParse({
          phone: "50688888888",
          recording_url: mala,
        }).success,
      ).toBe(false);
    }
  });

  it("direction es enum estricto; sin ella, el registro usa inbound", () => {
    expect(
      vozPostLlamadaSchema.safeParse({ phone: "50688888888", direction: "" })
        .success,
    ).toBe(false);
    const sinDireccion = vozPostLlamadaSchema.safeParse({
      phone: "50688888888",
    });
    expect(sinDireccion.success).toBe(true);
    if (!sinDireccion.success) throw new Error("debió parsear");
    expect(sinDireccion.data.direction).toBeUndefined();
  });

  it("rechaza dirección y duración imposibles", () => {
    expect(
      vozPostLlamadaSchema.safeParse({ phone: "50688888888", direction: "perdida" })
        .success,
    ).toBe(false);
    expect(
      vozPostLlamadaSchema.safeParse({ phone: "50688888888", duration_sec: -5 })
        .success,
    ).toBe(false);
    expect(
      vozPostLlamadaSchema.safeParse({ phone: "50688888888", duration_sec: 1.5 })
        .success,
    ).toBe(false);
  });

  it("un campo nuevo del puente no rompe el endpoint: se ignora", () => {
    const parsed = vozPostLlamadaSchema.safeParse({
      phone: "50688888888",
      campo_futuro_de_elevenlabs: { lo_que_sea: true },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("debió parsear");
    expect(parsed.data).not.toHaveProperty("campo_futuro_de_elevenlabs");
  });
});

describe("validVozKey: X-Voz-Key contra VOZ_API_KEY", () => {
  it("sin VOZ_API_KEY, nada pasa", () => {
    expect(isVozKeyConfigured()).toBe(false);
    expect(validVozKey("cualquier-llave-larga")).toBe(false);
    expect(validVozKey(null)).toBe(false);
  });

  it("una llave corta equivale a no tenerla", () => {
    process.env.VOZ_API_KEY = "corta";
    expect(isVozKeyConfigured()).toBe(false);
    expect(validVozKey("corta")).toBe(false);
  });

  it("solo la llave exacta pasa; otra de igual largo, no", () => {
    process.env.VOZ_API_KEY = "llave-secreta-de-16+";
    expect(isVozKeyConfigured()).toBe(true);
    expect(validVozKey("llave-secreta-de-16+")).toBe(true);
    expect(validVozKey("llave-secreta-de-16!")).toBe(false);
    expect(validVozKey("llave-secreta-de-16")).toBe(false);
    expect(validVozKey(null)).toBe(false);
  });
});
