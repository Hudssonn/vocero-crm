import { apiError, withAuth } from "@/lib/api";
import {
  CampaignError,
  campaignErrorStatus,
  pausarCampana,
} from "@/server/campaigns/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** 048 — Pausa una campaña (enviando/programada → pausada). */
export const POST = withAuth(async (session, _req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  try {
    const campana = await pausarCampana(session.organizationId, id);
    return Response.json({ campaign: campana });
  } catch (err) {
    if (err instanceof CampaignError) {
      return apiError(campaignErrorStatus(err), err.code, err.message);
    }
    throw err;
  }
});
