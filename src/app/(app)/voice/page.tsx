import { notFound, redirect } from "next/navigation";
import { VoiceClient } from "@/components/voice/voice-client";
import { getSessionOrNull } from "@/lib/auth/session";
import { vozEnabled } from "@/server/voice/flag";

export const dynamic = "force-dynamic";

/**
 * 050 — Agentes de voz: probar los agentes de ElevenLabs y ver el historial
 * de llamadas que deja el puente de voz.
 */
export default async function VoicePage() {
  // Sin la bandera esta pantalla no existe en esta instancia.
  if (!vozEnabled()) notFound();
  const session = await getSessionOrNull();
  if (!session) redirect("/login");

  return <VoiceClient />;
}
