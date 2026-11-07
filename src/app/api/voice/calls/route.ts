import { withAuth } from "@/lib/api";
import {
  listarLlamadasVoz,
  serializarLlamadaVoz,
  VOICE_CALLS_PAGE_MAX,
} from "@/server/voice/calls";
import { vozDisabledResponse, vozEnabled } from "@/server/voice/flag";

export const dynamic = "force-dynamic";

/**
 * 050 — Historial de llamadas de voz de la organización.
 *
 * `GET /api/voice/calls?limit=50&offset=0` (tope 100, fecha desc). El
 * alcance es SIEMPRE `session.organizationId`: nunca se acepta una
 * organización por parámetro. Sin `VOZ=on`, 404: la superficie no existe.
 */
export const GET = withAuth(async (session, req: Request) => {
  if (!vozEnabled()) return vozDisabledResponse();
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? "50");
  const offsetRaw = Number(url.searchParams.get("offset") ?? "0");
  const limit = Number.isFinite(limitRaw) ? limitRaw : 50;
  const offset = Number.isFinite(offsetRaw) ? offsetRaw : 0;
  const { calls, hasMore } = await listarLlamadasVoz(session.organizationId, {
    limit,
    offset,
  });
  return Response.json({
    calls: calls.map(serializarLlamadaVoz),
    hasMore,
    limit: Math.min(Math.max(Math.floor(limit), 1), VOICE_CALLS_PAGE_MAX),
    offset: Math.max(Math.floor(offset), 0),
  });
});
