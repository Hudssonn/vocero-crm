import { apiError, withAuth } from "@/lib/api";
import {
  CampaignError,
  campaignErrorStatus,
  iniciarCampana,
} from "@/server/campaigns/service";
import { programarTandaCampanas } from "@/server/campaigns/worker";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * 048 — Inicia una campaña (borrador/programada/pausada → enviando).
 * Exige plantilla y al menos un destinatario pendiente; despierta al worker
 * para que no espere al barrido.
 */
export const POST = withAuth(async (session, _req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  try {
    const campana = await iniciarCampana(session.organizationId, id);
    programarTandaCampanas();
    return Response.json({ campaign: campana });
  } catch (err) {
    if (err instanceof CampaignError) {
      return apiError(campaignErrorStatus(err), err.code, err.message);
    }
    throw err;
  }
});
