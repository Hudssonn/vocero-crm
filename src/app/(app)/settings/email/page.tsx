import { notFound } from "next/navigation";
import { EmailClient } from "@/components/settings/email-client";
import { isChannelEnabled } from "@/server/channels/enabled";

export const dynamic = "force-dynamic";

export default function EmailSettingsPage() {
  // Sin el canal encendido esta pantalla no existe en esta instancia (ADR-001).
  if (!isChannelEnabled("email")) notFound();
  return <EmailClient />;
}
