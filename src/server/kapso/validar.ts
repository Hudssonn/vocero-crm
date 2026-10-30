import { z } from "zod";

/**
 * 046 — Valida una llave de proyecto de Kapso contra su API.
 *
 * Lee el número (`GET /meta/whatsapp/v24.0/{phoneNumberId}`) con la llave
 * candidata: si Kapso la acepta, el número existe y la llave calza, y de la
 * respuesta se saca el nombre visible y la WABA. Se usa ANTES de guardar la
 * conexión: una llave que no sirve nunca llega a la base.
 */

const KAPSO_API_BASE = "https://api.kapso.ai/meta/whatsapp/v24.0";

const respuestaNumero = z.object({}).passthrough();

export type NumeroKapsoValidado = {
  displayName: string | null;
  wabaId: string | null;
};

export type FallaValidacionKapso = {
  status: number;
  code: string;
  message: string;
};

function textoDe(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() ? valor : null;
}

export async function validarNumeroKapso(
  apiKey: string,
  phoneNumberId: string
): Promise<
  { ok: true; numero: NumeroKapsoValidado } | { ok: false; falla: FallaValidacionKapso }
> {
  let respuesta: Response;
  try {
    respuesta = await fetch(
      `${KAPSO_API_BASE}/${encodeURIComponent(phoneNumberId)}`,
      {
        headers: { "X-API-Key": apiKey },
        signal: AbortSignal.timeout(15_000),
      }
    );
  } catch {
    return {
      ok: false,
      falla: {
        status: 502,
        code: "kapso_unreachable",
        message: "No se pudo contactar a Kapso; inténtalo de nuevo",
      },
    };
  }

  if (respuesta.status === 401 || respuesta.status === 403) {
    return {
      ok: false,
      falla: {
        status: 401,
        code: "kapso_unauthorized",
        message: "Kapso rechazó la llave de proyecto; revísala y pégala de nuevo",
      },
    };
  }
  if (respuesta.status === 404) {
    return {
      ok: false,
      falla: {
        status: 404,
        code: "kapso_number_not_found",
        message: "Kapso no conoce ese phone_number_id con esa llave",
      },
    };
  }
  if (!respuesta.ok) {
    return {
      ok: false,
      falla: {
        status: 502,
        code: "kapso_error",
        message: `Kapso respondió ${respuesta.status}; inténtalo de nuevo`,
      },
    };
  }

  const datos: unknown = await respuesta.json().catch(() => null);
  const parseado = respuestaNumero.safeParse(datos);
  const cuerpo = parseado.success ? parseado.data : {};
  return {
    ok: true,
    numero: {
      displayName:
        textoDe(cuerpo["display_name"]) ?? textoDe(cuerpo["name"]),
      wabaId: textoDe(cuerpo["waba_id"]) ?? textoDe(cuerpo["whatsapp_business_account_id"]),
    },
  };
}
