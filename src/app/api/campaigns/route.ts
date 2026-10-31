import { apiError, parseBody, withAuth } from "@/lib/api";
import {
  CampaignError,
  campaignErrorStatus,
  crearCampana,
  crearCampanaSchema,
  listarCampanas,
} from "@/server/campaigns/service";

export const dynamic = "force-dynamic";

/** 048 — Lista las campañas de la organización con conteos básicos. */
export const GET = withAuth(async (session) => {
  const campanas = await listarCampanas(session.organizationId);
  return Response.json({ campaigns: campanas });
});

/** 048 — Crea una campaña (borrador, o programada si trae scheduledAt futuro). */
export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, crearCampanaSchema);
  if (!body.ok) return body.response;

  try {
    const campana = await crearCampana(session.organizationId, body.data);
    return Response.json({ campaign: campana }, { status: 201 });
  } catch (err) {
    if (err instanceof CampaignError) {
      return apiError(campaignErrorStatus(err), err.code, err.message);
    }
    throw err;
  }
});
