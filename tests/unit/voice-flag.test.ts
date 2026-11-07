import { describe, expect, it } from "vitest";
import { parseVozFlag, vozDisabledResponse } from "@/server/voice/flag";

/**
 * 050 — La bandera de la voz. Mismo contrato que la agenda (015): el caso
 * que importa es el DEFAULT — una instancia que no la pidió no debe acabar
 * con la pestaña encendida por un despiste de configuración — y la
 * superficie apagada es 404, no 403.
 */

describe("parseVozFlag", () => {
  it("sin variable, la voz no existe", () => {
    expect(parseVozFlag(undefined)).toBe(false);
    expect(parseVozFlag("")).toBe(false);
    expect(parseVozFlag("   ")).toBe(false);
  });

  it("`on` la enciende, con espacios y mayúsculas de por medio", () => {
    expect(parseVozFlag("on")).toBe(true);
    expect(parseVozFlag("ON")).toBe(true);
    expect(parseVozFlag("  On  ")).toBe(true);
  });

  it("acepta las otras formas de decir que sí", () => {
    expect(parseVozFlag("1")).toBe(true);
    expect(parseVozFlag("true")).toBe(true);
    expect(parseVozFlag("TRUE")).toBe(true);
    expect(parseVozFlag("si")).toBe(true);
    expect(parseVozFlag("sí")).toBe(true);
    expect(parseVozFlag("yes")).toBe(true);
  });

  it("cualquier otra cosa deja la voz apagada, incluido `off` y `false`", () => {
    expect(parseVozFlag("off")).toBe(false);
    expect(parseVozFlag("false")).toBe(false);
    expect(parseVozFlag("0")).toBe(false);
    expect(parseVozFlag("no")).toBe(false);
    expect(parseVozFlag("voz")).toBe(false);
    // Un typo no enciende nada: apagada es el estado seguro.
    expect(parseVozFlag("onn")).toBe(false);
  });
});

describe("vozDisabledResponse", () => {
  it("apagada, la superficie no existe: 404 sin cuerpo", async () => {
    const res = vozDisabledResponse();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });
});
