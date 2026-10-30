import { apiError, parseBody, withAuth } from "@/lib/api";
import {
  actualizarCampana,
  actualizarCampanaSchema,
  CampaignError,
  campaignErrorStatus,
  eliminarCampana,
  obtenerCampana,
} from "@/server/campaigns/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** 048 — Detalle de una campaña. */
export const GET = withAuth(async (session, _req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  try {
    const campana = await obtenerCampana(session.organizationId, id);
    return Response.json({ campaign: campana });
  } catch (err) {
    if (err instanceof CampaignError) {
      return apiError(campaignErrorStatus(err), err.code, err.message);
    }
    throw err;
  }
});

/** 048 — Edita una campaña (solo borrador; en programada solo scheduledAt). */
export const PUT = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, actualizarCampanaSchema);
  if (!body.ok) return body.response;

  try {
    const campana = await actualizarCampana(
      session.organizationId,
      id,
      body.data
    );
    return Response.json({ campaign: campana });
  } catch (err) {
    if (err instanceof CampaignError) {
      return apiError(campaignErrorStatus(err), err.code, err.message);
    }
    throw err;
  }
});

/** 048 — Elimina una campaña (salvo en `enviando`: primero se pausa). */
export const DELETE = withAuth(async (session, _req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  try {
    await eliminarCampana(session.organizationId, id);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof CampaignError) {
      return apiError(campaignErrorStatus(err), err.code, err.message);
    }
    throw err;
  }
});
