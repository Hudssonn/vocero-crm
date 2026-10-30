"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * 046 — Conexión de WhatsApp por Kapso (BSP oficial de Meta).
 *
 * Misma forma que Zernio: la llave se prueba contra la plataforma ANTES de
 * guardar, se cifra, y hacia fuera solo se enseña su cola. Vive debajo del
 * asistente de Meta en la misma pantalla porque es el mismo canal con otro
 * transporte: cada número usa uno solo, no varios a la vez.
 */

type Connection = {
  source: string;
  phoneNumberId: string;
  wabaId: string | null;
  displayName: string | null;
  status: "connected" | "reconnect_required";
  apiKeyLast4: string;
  hasWebhookSecret: boolean;
};

const PASOS = [
  "El número se conecta en el panel de Kapso (por coexistencia con la app de WhatsApp Business), no desde aquí.",
  "La API key se crea en Kapso → Integrate → API keys y se muestra una sola vez.",
  "El secreto del webhook lo genera Kapso al dar de alta el webhook hacia Vocero (Integrate → Webhooks → pestaña WhatsApp).",
];

const REGLAS = [
  "Los mensajes de ese número entran a la misma bandeja que el resto, con el distintivo de WhatsApp.",
  "Cada número usa un solo transporte: el de Meta de arriba, este de Kapso o el de Zernio, no varios a la vez.",
  "Ventana de 24 horas desde el último mensaje del cliente, igual que por Meta. Fuera de ella no sale texto libre.",
];

export function WhatsappKapsoClient() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refetch = useCallback(async () => {
    const c = await fetch("/api/settings/whatsapp/kapso")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (c) setConnection(c.connection);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  if (!loaded) return <p className="text-sm text-muted-foreground">Cargando…</p>;

  return (
    <div className="space-y-6">
      {connection?.status === "reconnect_required" && (
        <div className="flex items-start gap-2 rounded-lg border border-danger-soft bg-danger-tint p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium text-danger-text">
              La API key de Kapso expiró o fue revocada.
            </p>
            <p className="text-danger-text opacity-80">
              Los envíos por Kapso están pausados. Pega una nueva abajo para
              reconectar.
            </p>
          </div>
        </div>
      )}

      {connection?.status === "connected" && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-success-soft bg-success-tint p-4">
          <CheckCircle2 className="h-5 w-5 text-success" />
          <div className="min-w-[12rem] flex-1 text-sm">
            <p className="font-medium text-success-text">
              WhatsApp conectado por Kapso
              {connection.displayName ? `: ${connection.displayName}` : ""}
            </p>
            <p className="text-success-text opacity-80">
              {connection.phoneNumberId} · llave que termina en ····
              {connection.apiKeyLast4}
              {connection.hasWebhookSecret ? " · firma del webhook activa" : ""}
            </p>
          </div>
          <Badge variant="success">Kapso activo</Badge>
          <Desconectar onHecho={() => void refetch()} />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            {connection ? "Reconectar WhatsApp por Kapso" : "Conectar WhatsApp por Kapso"}
          </CardTitle>
          <CardDescription>
            Para un número que vive en Kapso (coexistencia) en vez de directo
            en Meta o por Zernio. La bandeja, el agente y el pipeline son los
            mismos; cambia solo por dónde entran y salen los mensajes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="list-disc space-y-1 pl-5 text-xs text-text-2">
            {PASOS.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-text-2">
            {REGLAS.map((regla, i) => (
              <li key={i}>{regla}</li>
            ))}
          </ul>

          <KapsoConnect
            existing={connection}
            onSaved={() => void refetch()}
          />
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Formulario de conexión: Phone Number ID, API key y secreto del webhook.
 *
 * La llave se valida contra Kapso ANTES de guardar (la ruta lo hace); al
 * guardar, la ruta devuelve la URL del webhook para pegarla en el panel de
 * Kapso. La llave nunca se muestra entera: el campo se vacía al guardar.
 */
function KapsoConnect({
  existing,
  onSaved,
}: {
  existing: Connection | null;
  onSaved: () => void;
}) {
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const canSave =
    phoneNumberId.trim().length > 0 &&
    apiKey.trim().length > 0 &&
    webhookSecret.trim().length > 0;

  async function save() {
    setSaving(true);
    setError(null);
    setWebhookUrl(null);
    const res = await fetch("/api/settings/whatsapp/kapso", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phoneNumberId: phoneNumberId.trim(),
        apiKey: apiKey.trim(),
        webhookSecret: webhookSecret.trim(),
      }),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      const data = (await res?.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(data?.error?.message ?? "No se pudo conectar. Intenta de nuevo.");
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      webhookUrl?: string;
      displayName?: string | null;
    };
    setApiKey("");
    setWebhookSecret("");
    if (data.webhookUrl) setWebhookUrl(data.webhookUrl);
    onSaved();
  }

  function copy() {
    if (!webhookUrl) return;
    void navigator.clipboard.writeText(webhookUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5 sm:max-w-md">
          <Label htmlFor="wa-kapso-phone">Phone Number ID</Label>
          <Input
            id="wa-kapso-phone"
            value={phoneNumberId}
            onChange={(e) => setPhoneNumberId(e.target.value)}
            placeholder="ID del número en Kapso"
            autoComplete="off"
          />
          <p className="text-xs text-text-2">
            El ID del número conectado (lo enseña el panel de Kapso).
          </p>
        </div>
      </div>

      <div className="space-y-1.5 sm:max-w-md">
        <Label htmlFor="wa-kapso-key">API key de Kapso</Label>
        <Input
          id="wa-kapso-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={existing ? `Guardada (····${existing.apiKeyLast4}) — pega una nueva para cambiarla` : "Kapso API key"}
          autoComplete="off"
        />
        <p className="text-xs text-text-2">
          Kapso → Integrate → API keys. Vocero la prueba contra Kapso antes de
          guardarla.
        </p>
      </div>

      <div className="space-y-1.5 sm:max-w-md">
        <Label htmlFor="wa-kapso-secret">Secreto del webhook</Label>
        <Input
          id="wa-kapso-secret"
          type="password"
          value={webhookSecret}
          onChange={(e) => setWebhookSecret(e.target.value)}
          placeholder={existing?.hasWebhookSecret ? "Guardado — pega uno nuevo para cambiarlo" : "Secreto HMAC del webhook"}
          autoComplete="off"
        />
        <p className="text-xs text-text-2">
          Kapso lo genera al dar de alta el webhook hacia Vocero; con él se
          verifica la firma de cada mensaje.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button disabled={saving || !canSave} onClick={() => void save()}>
          {saving ? "Probando…" : "Probar y conectar"}
        </Button>
      </div>

      {webhookUrl && (
        <div className="space-y-2 rounded-lg border border-success-soft bg-success-tint p-4 text-sm">
          <p className="flex items-center gap-2 font-medium text-success-text">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            Conectado. Pega esta URL en Kapso → Integrate → Webhooks:
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border bg-background px-3 py-2 text-xs">
              {webhookUrl}
            </code>
            <Button
              variant="outline"
              size="icon"
              aria-label="Copiar URL del webhook"
              onClick={copy}
            >
              <Copy className="h-4 w-4" />
            </Button>
            {copied && <span className="text-xs text-primary">Copiada ✓</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Soltar el transporte Kapso.
 *
 * Pide confirmación porque corta la entrada y la salida por Kapso al
 * instante. No borra la bandeja ni el webhook de Kapso: sin conexión, lo que
 * llegue por ese número se descarta.
 */
function Desconectar({ onHecho }: { onHecho: () => void }) {
  const [confirmando, setConfirmando] = useState(false);
  const [yendo, setYendo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function soltar() {
    setYendo(true);
    setError(null);
    const res = await fetch("/api/settings/whatsapp/kapso", {
      method: "DELETE",
    }).catch(() => null);
    setYendo(false);
    if (!res?.ok) {
      setError("No se pudo desconectar. Intenta de nuevo.");
      return;
    }
    setConfirmando(false);
    onHecho();
  }

  if (!confirmando) {
    return (
      <Button variant="outline" size="sm" onClick={() => setConfirmando(true)}>
        Desconectar
      </Button>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-text-2">¿Soltar el transporte Kapso?</span>
      <Button size="sm" variant="destructive" disabled={yendo} onClick={() => void soltar()}>
        {yendo ? "Soltando…" : "Sí, desconectar"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirmando(false)}>
        Cancelar
      </Button>
      {error && <span className="text-destructive">{error}</span>}
    </span>
  );
}
