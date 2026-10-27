"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ZernioConnect } from "@/components/settings/zernio-connect";

/**
 * 032 — Conexión de WhatsApp por Zernio.
 *
 * Misma forma que TikTok: la llave se prueba contra la plataforma ANTES de
 * guardar, se cifra, y hacia fuera solo se enseña su cola. Vive debajo del
 * asistente de Meta en la misma pantalla porque es el mismo canal con otro
 * transporte: cada número usa uno solo, no los dos a la vez.
 */

type Connection = {
  accountRef: string;
  displayName: string | null;
  status: "connected" | "reconnect_required";
  tokenLast4: string;
  hasWebhookSecret: boolean;
};

const PASOS = [
  "El número se vincula en el panel de Zernio (Accounts → Connect), no desde aquí.",
  "La API key se crea en Zernio → Settings → API Keys y se muestra una sola vez (empieza con sk_).",
];

const REGLAS = [
  "Los mensajes de ese número entran a la misma bandeja que el resto, con el distintivo de WhatsApp.",
  "Cada número usa un solo transporte: el de Meta de arriba o este de Zernio, no los dos a la vez.",
  "Ventana de 24 horas desde el último mensaje del cliente, igual que por Meta. Fuera de ella no sale texto libre.",
];

export function WhatsappZernioClient() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refetch = useCallback(async () => {
    const c = await fetch("/api/settings/whatsapp/zernio")
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
              La API key de Zernio expiró o fue revocada.
            </p>
            <p className="text-danger-text opacity-80">
              Los envíos por Zernio están pausados. Pega una nueva abajo para
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
              WhatsApp conectado por Zernio
              {connection.displayName ? `: ${connection.displayName}` : ""}
            </p>
            <p className="text-success-text opacity-80">
              Cuenta {connection.accountRef} · llave que termina en ····
              {connection.tokenLast4}
              {connection.hasWebhookSecret ? " · firma del webhook activa" : ""}
            </p>
          </div>
          <Badge variant="success">Zernio activo</Badge>
          <Desconectar onHecho={() => void refetch()} />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            {connection ? "Reconectar WhatsApp por Zernio" : "Conectar WhatsApp por Zernio"}
          </CardTitle>
          <CardDescription>
            Para un número que vive en Zernio en vez de directo en Meta. La
            bandeja, el agente y el pipeline son los mismos; cambia solo por
            dónde entran y salen los mensajes.
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

          <ZernioConnect
            endpoint="/api/settings/whatsapp/zernio"
            what="tu número de WhatsApp"
            idPrefix="wa-zernio"
            onSaved={() => void refetch()}
          />
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Soltar el transporte Zernio.
 *
 * Pide confirmación porque corta la entrada y la salida por Zernio al
 * instante. No borra la bandeja ni el webhook de Zernio (es compartido por
 * llave): sin conexión, lo que llegue por esa cuenta se descarta.
 */
function Desconectar({ onHecho }: { onHecho: () => void }) {
  const [confirmando, setConfirmando] = useState(false);
  const [yendo, setYendo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function soltar() {
    setYendo(true);
    setError(null);
    const res = await fetch("/api/settings/whatsapp/zernio", {
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
      <span className="text-text-2">¿Soltar el transporte Zernio?</span>
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
