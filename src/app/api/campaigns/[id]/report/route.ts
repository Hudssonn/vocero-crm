import { apiError, withAuth } from "@/lib/api";
import {
  CampaignError,
  campaignErrorStatus,
  reporteCampana,
} from "@/server/campaigns/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** 048 — Reporte de la campaña: conteos por estado de destinatario. */
export const GET = withAuth(async (session, _req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  try {
    const reporte = await reporteCampana(session.organizationId, id);
    return Response.json(reporte);
  } catch (err) {
    if (err instanceof CampaignError) {
      return apiError(campaignErrorStatus(err), err.code, err.message);
    }
    throw err;
  }
});
