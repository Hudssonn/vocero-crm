import { apiError, withAuth } from "@/lib/api";
import { getBranding } from "@/server/branding";
import { PeriodError, periodFromRequest } from "@/server/analytics/period";
import { construirCsvCierre } from "@/server/analytics/cierre";

export const dynamic = "force-dynamic";

/**
 * 042 — Descarga del cierre del período en CSV (abre en Excel en
 * español). Ruta interna con sesión: la organización sale siempre de
 * la sesión, nunca de un parámetro. La lógica vive en
 * `src/server/analytics/cierre.ts`; aquí solo se exporta el handler.
 */
export const GET = withAuth(async (session, req: Request) => {
  try {
    const [period, branding] = await Promise.all([
      periodFromRequest(session.organizationId, new URL(req.url)),
      getBranding(session.organizationId),
    ]);
    const csv = await construirCsvCierre(
      session.organizationId,
      period,
      branding.currency
    );
    const nombre = `cierre-${period.dto.from}-a-${period.dto.to}.csv`;
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${nombre}"`,
      },
    });
  } catch (err) {
    if (err instanceof PeriodError) {
      return apiError(422, "invalid_period", err.message);
    }
    throw err;
  }
});
