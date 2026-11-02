"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
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
import { cn } from "@/lib/utils";

/**
 * 031 — Conexión del canal de correo.
 *
 * El negocio conecta SU buzón (IMAP/SMTP genérico): los correos entran a la
 * misma bandeja que los demás canales. Gemela de las otras pantallas de
 * canal: se prueba antes de guardar, la contraseña se cifra y nunca vuelve
 * al navegador, y la pantalla solo existe con el canal encendido.
 */

type Connection = {
  emailAddress: string;
  displayName: string | null;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  status: "connected" | "auth_failed" | "error";
  lastError: string | null;
  lastCheckAt: string | null;
};

type Preset = "gmail" | "microsoft" | "propio";

const PRESETS: Record<
  Preset,
  { label: string; imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; smtpSecure: boolean }
> = {
  gmail: {
    label: "Gmail / Google Workspace",
    imapHost: "imap.gmail.com",
    imapPort: 993,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    smtpSecure: true,
  },
  microsoft: {
    label: "Microsoft 365 / Outlook",
    imapHost: "outlook.office365.com",
    imapPort: 993,
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    smtpSecure: false,
  },
  propio: {
    label: "Dominio propio / otro",
    imapHost: "",
    imapPort: 993,
    smtpHost: "",
    smtpPort: 465,
    smtpSecure: true,
  },
};

export function EmailClient() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [preset, setPreset] = useState<Preset>("gmail");
  const [emailAddress, setEmailAddress] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [clave, setClave] = useState("");
  const [imapHost, setImapHost] = useState(PRESETS.gmail.imapHost);
  const [imapPort, setImapPort] = useState(String(PRESETS.gmail.imapPort));
  const [smtpHost, setSmtpHost] = useState(PRESETS.gmail.smtpHost);
  const [smtpPort, setSmtpPort] = useState(String(PRESETS.gmail.smtpPort));
  const [smtpSecure, setSmtpSecure] = useState(PRESETS.gmail.smtpSecure);
  const [busy, setBusy] = useState<"test" | "save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    const c = await fetch("/api/settings/email")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (c?.connection) {
      const conn = c.connection as Connection;
      setConnection(conn);
      setEmailAddress(conn.emailAddress);
      setDisplayName(conn.displayName ?? "");
      setUsername(conn.username);
      setImapHost(conn.imapHost);
      setImapPort(String(conn.imapPort));
      setSmtpHost(conn.smtpHost);
      setSmtpPort(String(conn.smtpPort));
      setSmtpSecure(conn.smtpSecure);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  function applyPreset(p: Preset) {
    setPreset(p);
    const v = PRESETS[p];
    if (p !== "propio" || !connection) {
      setImapHost(v.imapHost);
      setImapPort(String(v.imapPort));
      setSmtpHost(v.smtpHost);
      setSmtpPort(String(v.smtpPort));
      setSmtpSecure(v.smtpSecure);
    }
  }

  function payload() {
    return {
      emailAddress: emailAddress.trim(),
      displayName: displayName.trim() || null,
      imapHost: imapHost.trim(),
      imapPort: Number(imapPort) || 993,
      imapSecure: true,
      smtpHost: smtpHost.trim(),
      smtpPort: Number(smtpPort) || 465,
      smtpSecure,
      username: username.trim(),
      password: clave || undefined,
    };
  }

  async function run(mode: "test" | "save") {
    setBusy(mode);
    setError(null);
    setNotice(null);
    const res = await fetch(
      mode === "test" ? "/api/settings/email/test" : "/api/settings/email",
      {
        method: mode === "test" ? "POST" : "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload()),
      }
    ).catch(() => null);
    setBusy(null);
    const data = (await res?.json().catch(() => null)) as {
      error?: { message?: string };
      mensajesEnBuzon?: number;
    } | null;
    if (!res?.ok) {
      setError(data?.error?.message ?? "No se pudo completar la operación");
      return;
    }
    if (mode === "test") {
      setNotice(
        `Conexión correcta: IMAP y SMTP responden (el buzón tiene ${data?.mensajesEnBuzon ?? 0} correos).`
      );
    } else {
      setClave("");
      setNotice("Buzón conectado. Los correos nuevos entrarán a la bandeja en menos de un minuto.");
      void refetch();
    }
  }

  async function disconnect() {
    setBusy("delete");
    setError(null);
    setNotice(null);
    const res = await fetch("/api/settings/email", { method: "DELETE" }).catch(
      () => null
    );
    setBusy(null);
    if (!res?.ok) {
      setError("No se pudo desconectar el buzón");
      return;
    }
    setConnection(null);
    setClave("");
    setNotice("Buzón desconectado. Las conversaciones que ya entraron se quedan en la bandeja.");
  }

  if (!loaded) return <p className="text-sm text-muted-foreground">Cargando…</p>;

  const canSubmit =
    emailAddress.trim().length > 3 &&
    username.trim().length > 0 &&
    imapHost.trim().length > 0 &&
    smtpHost.trim().length > 0 &&
    (clave.length > 0 || Boolean(connection));

  return (
    <div className="max-w-3xl space-y-6">
      {connection?.status === "connected" && (
        <div className="flex items-center gap-3 rounded-lg border border-success-soft bg-success-tint p-4">
          <CheckCircle2 className="h-5 w-5 text-success" />
          <div className="flex-1 text-sm">
            <p className="font-medium text-success-text">
              Conectado: {connection.emailAddress}
            </p>
            <p className="text-success-text opacity-80">
              {connection.lastCheckAt
                ? `Última revisión del buzón: ${new Date(connection.lastCheckAt).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" })}`
                : "El buzón se revisa cada minuto."}
            </p>
          </div>
          <Badge variant="success">Correo activo</Badge>
        </div>
      )}

      {connection && connection.status !== "connected" && (
        <div className="flex items-start gap-2 rounded-lg border border-danger-soft bg-danger-tint p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium text-danger-text">
              {connection.status === "auth_failed"
                ? "El buzón rechazó el usuario o la contraseña."
                : "El buzón no responde."}
            </p>
            <p className="text-danger-text opacity-80">
              {connection.lastError ??
                "Revisa los datos abajo y vuelve a guardar: guardar prueba la conexión de nuevo."}
            </p>
          </div>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{connection ? "Buzón de correo" : "Conectar el correo"}</CardTitle>
          <CardDescription>
            Los correos de tus clientes entran a la misma bandeja que WhatsApp,
            con su distintivo de canal. El correo sigue viviendo en tu servidor:
            aquí solo se guarda la conexión, con la contraseña cifrada.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>¿Dónde está el buzón?</Label>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(PRESETS) as Preset[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => applyPreset(p)}
                  aria-pressed={preset === p}
                  className={cn(
                    "rounded-full border px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors",
                    preset === p
                      ? "border-brand bg-brand-tint text-brand-text"
                      : "border-border-strong hover:bg-accent"
                  )}
                >
                  {PRESETS[p].label}
                </button>
              ))}
            </div>
          </div>

          {preset === "gmail" && (
            <p className="flex items-start gap-2 text-xs text-text-2">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Gmail no acepta tu contraseña normal: crea una{" "}
              <strong>contraseña de aplicación</strong> en tu cuenta de Google
              (Seguridad → Verificación en dos pasos → Contraseñas de
              aplicaciones) y pégala aquí. Son 16 letras.
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="em-address">Correo del buzón</Label>
              <Input
                id="em-address"
                type="email"
                value={emailAddress}
                onChange={(e) => {
                  setEmailAddress(e.target.value);
                  if (!username) setUsername(e.target.value);
                }}
                placeholder="ventas@tunegocio.com"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="em-name">Nombre que verán los clientes (opcional)</Label>
              <Input
                id="em-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Ventas Tunegocio"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="em-user">Usuario</Label>
              <Input
                id="em-user"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="ventas@tunegocio.com"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="em-pass">
                Contraseña{connection ? " (vacía = conservar la guardada)" : ""}
              </Label>
              <Input
                id="em-pass"
                type="password"
                value={clave}
                onChange={(e) => setClave(e.target.value)}
                placeholder={connection ? "••••••••" : ""}
                autoComplete="off"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="em-imap">Servidor de entrada (IMAP)</Label>
              <div className="flex gap-2">
                <Input
                  id="em-imap"
                  value={imapHost}
                  onChange={(e) => setImapHost(e.target.value)}
                  placeholder="imap.tunegocio.com"
                  autoComplete="off"
                />
                <Input
                  aria-label="Puerto IMAP"
                  value={imapPort}
                  onChange={(e) => setImapPort(e.target.value.replace(/\D/g, ""))}
                  className="w-24"
                  inputMode="numeric"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="em-smtp">Servidor de salida (SMTP)</Label>
              <div className="flex gap-2">
                <Input
                  id="em-smtp"
                  value={smtpHost}
                  onChange={(e) => setSmtpHost(e.target.value)}
                  placeholder="smtp.tunegocio.com"
                  autoComplete="off"
                />
                <Input
                  aria-label="Puerto SMTP"
                  value={smtpPort}
                  onChange={(e) => setSmtpPort(e.target.value.replace(/\D/g, ""))}
                  className="w-24"
                  inputMode="numeric"
                />
              </div>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={smtpSecure}
              onChange={(e) => setSmtpSecure(e.target.checked)}
              className="h-4 w-4"
            />
            SMTP con conexión segura (SSL/TLS) — en el puerto 587 déjalo sin
            marcar: ahí la seguridad es STARTTLS.
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {notice && <p className="text-sm text-success-text">{notice} ✓</p>}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy !== null || !canSubmit}
              onClick={() => void run("test")}
            >
              {busy === "test" ? "Probando…" : "Probar conexión"}
            </Button>
            <Button disabled={busy !== null || !canSubmit} onClick={() => void run("save")}>
              {busy === "save" ? "Probando y guardando…" : connection ? "Guardar cambios" : "Probar y conectar"}
            </Button>
            {connection && (
              <Button
                variant="destructive"
                disabled={busy !== null}
                onClick={() => void disconnect()}
              >
                {busy === "delete" ? "Desconectando…" : "Desconectar"}
              </Button>
            )}
          </div>

          <p className="flex items-start gap-2 text-xs text-text-2">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            SolidGround revisa el buzón cada minuto y nunca marca tus correos como
            leídos en tu servidor: tu correo se sigue viendo igual en tu
            teléfono y tu computadora.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
