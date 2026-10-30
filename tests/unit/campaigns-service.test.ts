import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaApiError } from "@/lib/meta/client";
import {
  KAPSO_API_BASE,
  KAPSO_GRAPH_VERSION,
  construirCuerpoPlantillaKapso,
  parametrosDePlantilla,
  sendKapsoTemplate,
} from "@/server/whatsapp/send-kapso";
import {
  CampaignError,
  campaignErrorStatus,
  crearCampanaSchema,
  fusionarVariables,
  loteDestinatariosSchema,
  normalizarTelefonoCampana,
} from "@/server/campaigns/service";

/**
 * 048 — Campañas por WhatsApp: validaciones puras, orden de parámetros de
 * plantilla y envío de plantilla por Kapso con `fetch` falso. Sin base de
 * datos: lo que toca la BD vive en el servicio y se prueba en vivo.
 */

const PHONE_NUMBER_ID = "1295326617007791";
const API_KEY = "kapso_llave_de_prueba";
const URL_ESPERADA =
  `${KAPSO_API_BASE}/meta/whatsapp/${KAPSO_GRAPH_VERSION}/` +
  `${PHONE_NUMBER_ID}/messages`;

function respuesta(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("048 · normalización de teléfonos de campaña", () => {
  it("deja solo dígitos (sin +, espacios ni guiones)", () => {
    expect(normalizarTelefonoCampana("+506 7028-6104")).toEqual({
      ok: true,
      phone: "50670286104",
    });
  });
  it("rechaza menos de 7 y más de 15 dígitos", () => {
    expect(normalizarTelefonoCampana("123456").ok).toBe(false);
    expect(normalizarTelefonoCampana("1".repeat(16)).ok).toBe(false);
    expect(normalizarTelefonoCampana("50670286104").ok).toBe(true);
  });
  it("rechaza el vacío", () => {
    const r = normalizarTelefonoCampana("  ( ) - ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("sin_telefono");
  });
});

describe("048 · fusión de variables", () => {
  it("las del destinatario mandan sobre las globales", () => {
    expect(
      fusionarVariables({ nombre: "Cliente", promo: "10%" }, { nombre: "Hudson" })
    ).toEqual({ nombre: "Hudson", promo: "10%" });
  });
  it("tolera nulos", () => {
    expect(fusionarVariables(null, undefined)).toEqual({});
  });
});

describe("048 · parámetros posicionales de la plantilla", () => {
  it("claves numéricas ordenadas numéricamente (1, 2, 10 — no 1, 10, 2)", () => {
    const params = parametrosDePlantilla({
      "10": "diez",
      "2": "dos",
      "1": "uno",
    });
    expect(params.map((p) => p.text)).toEqual(["uno", "dos", "diez"]);
    expect(params[0]).toEqual({ type: "text", text: "uno" });
  });
  it("claves con nombre van después, alfabéticamente", () => {
    const params = parametrosDePlantilla({
      nombre: "Hudson",
      "1": "uno",
      ciudad: "Escazú",
    });
    expect(params.map((p) => p.text)).toEqual(["uno", "Escazú", "Hudson"]);
  });
  it("sin variables → sin parámetros", () => {
    expect(parametrosDePlantilla({})).toEqual([]);
  });
});

describe("048 · cuerpo de la plantilla para Kapso", () => {
  it("arma el cuerpo formato Meta con components de body", () => {
    const cuerpo = construirCuerpoPlantillaKapso({
      to: "50670286104",
      templateName: "promo_octubre",
      languageCode: "es_CR",
      variables: { "1": "Hudson", "2": "20%" },
    });
    expect(cuerpo).toEqual({
      messaging_product: "whatsapp",
      to: "50670286104",
      type: "template",
      template: {
        name: "promo_octubre",
        language: { code: "es_CR" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Hudson" },
              { type: "text", text: "20%" },
            ],
          },
        ],
      },
    });
  });
  it("sin variables no lleva components", () => {
    const cuerpo = construirCuerpoPlantillaKapso({
      to: "50670286104",
      templateName: "aviso",
      languageCode: "es_CR",
    });
    expect(cuerpo).toEqual({
      messaging_product: "whatsapp",
      to: "50670286104",
      type: "template",
      template: { name: "aviso", language: { code: "es_CR" } },
    });
  });
});

describe("048 · validación de crear campaña", () => {
  const base = {
    name: "Promo octubre",
    templateName: "promo_octubre",
    templateLanguage: "es_CR",
  };
  it("acepta una campaña válida", () => {
    expect(crearCampanaSchema.safeParse(base).success).toBe(true);
  });
  it("rechaza nombre de plantilla con mayúsculas o espacios", () => {
    expect(
      crearCampanaSchema.safeParse({ ...base, templateName: "Promo Octubre" })
        .success
    ).toBe(false);
  });
  it("rechaza un idioma que Meta no acepta", () => {
    expect(
      crearCampanaSchema.safeParse({ ...base, templateLanguage: "xx_YY" })
        .success
    ).toBe(false);
  });
  it("rechaza más de 20 variables", () => {
    const variables = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`v${i}`, "x"])
    );
    expect(
      crearCampanaSchema.safeParse({ ...base, variables }).success
    ).toBe(false);
  });
});

describe("048 · validación del lote de destinatarios", () => {
  it("acepta un lote válido", () => {
    const r = loteDestinatariosSchema.safeParse({
      recipients: [
        { phone: "+506 7028-6104", variables: { "1": "Hudson" } },
        { phone: "50663514244", contactId: "ct_abc" },
      ],
    });
    expect(r.success).toBe(true);
  });
  it("rechaza el lote vacío y el de más de 2000", () => {
    expect(
      loteDestinatariosSchema.safeParse({ recipients: [] }).success
    ).toBe(false);
    const grande = Array.from({ length: 2001 }, () => ({
      phone: "50670286104",
    }));
    expect(
      loteDestinatariosSchema.safeParse({ recipients: grande }).success
    ).toBe(false);
  });
});

describe("048 · códigos de error de dominio", () => {
  it("mapea cada código a su status HTTP", () => {
    expect(campaignErrorStatus(new CampaignError("not_found", "x"))).toBe(404);
    expect(campaignErrorStatus(new CampaignError("estado_invalido", "x"))).toBe(
      409
    );
    expect(
      campaignErrorStatus(new CampaignError("sin_destinatarios", "x"))
    ).toBe(422);
    expect(campaignErrorStatus(new CampaignError("sin_plantilla", "x"))).toBe(
      422
    );
    expect(campaignErrorStatus(new CampaignError("sin_telefono", "x"))).toBe(
      422
    );
  });
});

describe("048 · envío de plantilla por Kapso", () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("hace POST con X-API-Key y cuerpo de plantilla", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      respuesta({ messages: [{ id: "wamid.plantilla1" }] })
    );

    const r = await sendKapsoTemplate({
      phoneNumberId: PHONE_NUMBER_ID,
      apiKey: API_KEY,
      to: "50670286104",
      templateName: "promo_octubre",
      languageCode: "es_CR",
      variables: { "1": "Hudson" },
    });

    expect(r.platformMessageId).toBe("wamid.plantilla1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL_ESPERADA);
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe(API_KEY);
    const cuerpo = JSON.parse(init.body as string);
    expect(cuerpo.type).toBe("template");
    expect(cuerpo.template.name).toBe("promo_octubre");
    expect(cuerpo.template.language).toEqual({ code: "es_CR" });
    expect(cuerpo.template.components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "Hudson" }] },
    ]);
  });

  it("un 401 de Kapso se traduce a MetaApiError con isAuthError", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      respuesta({ error: { message: "Unauthorized", code: 401 } }, 401)
    );

    const promesa = sendKapsoTemplate({
      phoneNumberId: PHONE_NUMBER_ID,
      apiKey: "llave_muerta",
      to: "50670286104",
      templateName: "promo_octubre",
      languageCode: "es_CR",
    });
    await expect(promesa).rejects.toMatchObject({
      name: "MetaApiError",
      status: 401,
    });
    try {
      await promesa;
    } catch (err) {
      expect((err as MetaApiError).isAuthError).toBe(true);
    }
  });

  it("sin ID de mensaje en la respuesta → error", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(respuesta({ messages: [] }));

    await expect(
      sendKapsoTemplate({
        phoneNumberId: PHONE_NUMBER_ID,
        apiKey: API_KEY,
        to: "50670286104",
        templateName: "promo_octubre",
        languageCode: "es_CR",
      })
    ).rejects.toThrow("Kapso no devolvió ID de mensaje");
  });

  it("si no hay red → MetaApiError de contacto", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockRejectedValue(new Error("caída la red"));

    await expect(
      sendKapsoTemplate({
        phoneNumberId: PHONE_NUMBER_ID,
        apiKey: API_KEY,
        to: "50670286104",
        templateName: "promo_octubre",
        languageCode: "es_CR",
      })
    ).rejects.toThrow("No se pudo contactar la API de Kapso");
  });
});
