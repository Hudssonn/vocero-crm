import { apiError, parseBody, withAuth } from "@/lib/api";
import {
  agregarDestinatarios,
  CampaignError,
  campaignErrorStatus,
  loteDestinatariosSchema,
} from "@/server/campaigns/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * 048 — Agrega destinatarios en lote. Agregar = opt-in explícito (048/D1).
 * Responde cuántos se agregaron, cuántos eran duplicados (campaña+teléfono)
 * y cuáles venían inválidos — el lote nunca falla por un teléfono malo.
 */
export const POST = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, loteDestinatariosSchema);
  if (!body.ok) return body.response;

  try {
    const resultado = await agregarDestinatarios(
      session.organizationId,
      id,
      body.data
    );
    return Response.json(resultado, { status: 201 });
  } catch (err) {
    if (err instanceof CampaignError) {
      return apiError(campaignErrorStatus(err), err.code, err.message);
    }
    throw err;
  }
});
