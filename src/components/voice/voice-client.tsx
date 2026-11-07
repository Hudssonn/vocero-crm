"use client";

import { createElement, useCallback, useEffect, useState } from "react";
import Script from "next/script";
import { AlertTriangle, PhoneCall } from "lucide-react";
import { VOICE_AGENTS, voiceAgentById, type VoiceAgent } from "@/lib/voice-agents";
import type { LlamadaVozSerializada } from "@/server/voice/calls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

/**
 * 050 — Agentes de voz: selector + widget de prueba de ElevenLabs +
 * historial de llamadas del puente de voz.
 *
 * El widget es el `elevenlabs-convai` oficial: solo recibe el agent ID
 * PÚBLICO del agente elegido. Aquí NO va ninguna llave API ni secreto: el
 * widget habla directo con ElevenLabs desde el navegador. El script del
 * widget se carga UNA vez (`next/script`, `afterInteractive`); al cambiar
 * de agente se re-monta el elemento con `key={agentId}`, lo que corta la
 * llamada activa si la había — la UI lo avisa antes.
 *
 * El historial lo deja el puente de voz (`POST /api/voz/post-llamada`) y se
 * lee por `GET /api/voice/calls`, fecha desc, de 50 en 50. Lo que el puente
 * aún no entrega (grabación, transcripción) se enseña con "—": la UI no
 * promete lo que el puente no trae.
 */

const PAGE_SIZE = 50;

/**
 * Lo que no viene (null, undefined o cadena vacía) se enseña con "—":
 * el puente manda "" en lo que no trae y las filas viejas pueden traer
 * cadenas vacías guardadas antes de la normalización del endpoint.
 */
function textoO(valor: string | null | undefined): string {
  return valor && valor.trim() !== "" ? valor : "—";
}

/** ¿Hay algo que enseñar, o es un hueco (null / "" / solo espacios)? */
function hayTexto(valor: string | null | undefined): boolean {
  return typeof valor === "string" && valor.trim() !== "";
}

function formatoDuracion(segundos: number): string {
  const s = Math.max(0, Math.floor(segundos));
  const min = Math.floor(s / 60);
  const resto = s % 60;
  return `${min}:${String(resto).padStart(2, "0")}`;
}

function formatoFecha(iso: string): string {
  return new Date(iso).toLocaleString("es-CR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function VoiceClient() {
  const [agenteId, setAgenteId] = useState<VoiceAgent["id"]>("alex");
  const agente = voiceAgentById(agenteId);

  const [llamadas, setLlamadas] = useState<LlamadaVozSerializada[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Fallo de "Cargar más": aviso, sin vaciar la tabla ya cargada. */
  const [errorMas, setErrorMas] = useState<string | null>(null);
  /** El script del widget de ElevenLabs no cargó (ver aviso bajo el widget). */
  const [widgetError, setWidgetError] = useState(false);

  const cargar = useCallback(async (offset: number, agregar: boolean) => {
    if (agregar) {
      setCargandoMas(true);
      setErrorMas(null);
    } else {
      setCargando(true);
      setError(null);
    }
    try {
      const res = await fetch(
        `/api/voice/calls?limit=${PAGE_SIZE}&offset=${offset}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        calls: LlamadaVozSerializada[];
        hasMore: boolean;
      };
      setLlamadas((prev) => (agregar ? [...prev, ...data.calls] : data.calls));
      setHasMore(data.hasMore);
    } catch {
      // Un fallo de red o un JSON roto no deja el spinner infinito: en la
      // carga inicial enseña el error con reintento; en "Cargar más" solo
      // un aviso, la tabla que ya cargó se queda como está.
      if (agregar) {
        setErrorMas("No se pudieron cargar más llamadas");
      } else {
        setError("No se pudo cargar el historial de llamadas");
      }
    } finally {
      setCargando(false);
      setCargandoMas(false);
    }
  }, []);

  useEffect(() => {
    void cargar(0, false);
  }, [cargar]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4 lg:p-6">
      <header>
        <h1 className="text-xl font-bold">Agentes de voz</h1>
        <p className="text-sm text-muted-foreground">
          Probá cada agente hablando con él y revisá las llamadas que ya atendió.
        </p>
      </header>

      {/* Selector de agente */}
      <div
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        role="group"
        aria-label="Elegir agente de voz"
      >
        {VOICE_AGENTS.map((a) => {
          const activo = a.id === agente.id;
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => setAgenteId(a.id)}
              aria-pressed={activo}
              className={cn(
                "rounded-lg border p-4 text-left transition-colors",
                activo
                  ? "border-brand bg-brand-tint"
                  : "border-border-strong bg-card hover:bg-accent",
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-[15px] font-bold">{a.nombre}</span>
                <Badge>{a.estado === "activo" ? "Activo" : a.estado}</Badge>
              </span>
              <span className="mt-1 block text-sm text-muted-foreground">
                {a.rol} · {a.negocio}
              </span>
              <span className="mt-2 block text-sm">
                {a.telefono ?? "Sin número asignado"}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        El estado es el configurado para el agente, no una comprobación en
        vivo: ElevenLabs no publica si el agente está respondiendo en este
        momento.
      </p>

      {/* Widget de prueba */}
      <Card>
        <CardHeader>
          <CardTitle>Probar a {agente.nombre}</CardTitle>
          <CardDescription>
            {agente.rol} de {agente.negocio}. Hablá con el agente como lo
            haría un cliente.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="mb-3 flex items-start gap-2 text-sm text-muted-foreground">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-warning-text"
              aria-hidden
            />
            Cambiar de agente corta la llamada activa. Probar el agente gasta
            minutos del plan de ElevenLabs (hoy gratis).
          </p>
          {/* El widget necesita altura mínima para pintarse: sin ella el
              contenedor colapsa y el botón de llamada no se ve. */}
          <div className="widget-wrap min-h-[320px] rounded-lg border border-border-strong bg-card p-2">
            <Script
              // Versión FIJADA (0.25.1, consultada en unpkg el 2026-11-07):
              // sin fijar, unpkg sirve la última y un cambio de ElevenLabs
              // puede romper el widget sin tocar el código. El `integrity`
              // es el sha384 del archivo de esa versión (dist/index.js);
              // si se sube la versión hay que regenerarlo. next/script
              // acepta el atributo (hereda ScriptHTMLAttributes) y lo
              // aplica al <script>; sin `crossOrigin` el SRI no se verifica.
              src="https://unpkg.com/@elevenlabs/convai-widget-embed@0.25.1/dist/index.js"
              integrity="sha384-gd1WeVMkpzGTa9cCwPZg5WV8Sljfc1cHkU/Bhx+v+T29mc+dYb9xvfPkymSddt40"
              crossOrigin="anonymous"
              strategy="afterInteractive"
              onError={() => setWidgetError(true)}
            />
            {createElement("elevenlabs-convai", {
              key: agente.agentId,
              "agent-id": agente.agentId,
            })}
          </div>
          {widgetError && (
            <p role="alert" className="mt-3 text-sm text-warning-text">
              No se pudo cargar el widget de voz de ElevenLabs. Revisá la
              conexión o recargá la página; el historial de llamadas de abajo
              sigue disponible.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Historial de llamadas */}
      <Card>
        <CardHeader>
          <CardTitle>Historial de llamadas</CardTitle>
          <CardDescription>
            Las llamadas que los agentes atendieron, registradas por el puente
            de voz. La más reciente primero.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {cargando ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Cargando historial…
            </p>
          ) : error ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button variant="outline" onClick={() => void cargar(0, false)}>
                Reintentar
              </Button>
            </div>
          ) : llamadas.length === 0 ? (
            <EmptyState
              icon={PhoneCall}
              title="Todavía no hay llamadas registradas"
              description="Cuando un agente atienda una llamada, el puente de voz la registra aquí con su resumen."
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <caption className="sr-only">
                    Historial de llamadas de los agentes de voz, la más
                    reciente primero
                  </caption>
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th scope="col" className="py-2 pr-3 font-semibold">Fecha</th>
                      <th scope="col" className="py-2 pr-3 font-semibold">Número</th>
                      <th scope="col" className="py-2 pr-3 font-semibold">Duración</th>
                      <th scope="col" className="py-2 pr-3 font-semibold">Resumen</th>
                      <th scope="col" className="py-2 pr-3 font-semibold">Grabación</th>
                      <th scope="col" className="py-2 font-semibold">Transcripción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {llamadas.map((llamada) => (
                      <tr key={llamada.id} className="border-b align-top last:border-0">
                        <td className="whitespace-nowrap py-2 pr-3">
                          {formatoFecha(llamada.createdAt)}
                        </td>
                        <td className="py-2 pr-3">
                          <span className="block font-medium">{textoO(llamada.phone)}</span>
                          {hayTexto(llamada.callerName) && (
                            <span className="block text-muted-foreground">
                              {llamada.callerName}
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap py-2 pr-3">
                          {formatoDuracion(llamada.durationSec)}
                        </td>
                        <td className="max-w-[280px] py-2 pr-3">
                          {textoO(llamada.summary)}
                        </td>
                        <td className="whitespace-nowrap py-2 pr-3">
                          {hayTexto(llamada.recordingUrl) ? (
                            <a
                              href={llamada.recordingUrl as string}
                              target="_blank"
                              rel="noreferrer"
                              className="text-brand underline"
                            >
                              Escuchar
                            </a>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="max-w-[280px] py-2">
                          {hayTexto(llamada.transcript) ? (
                            <details>
                              <summary className="cursor-pointer text-brand underline">
                                Ver
                              </summary>
                              <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                                {llamada.transcript}
                              </p>
                            </details>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                La grabación y la transcripción llegan vacías mientras el
                puente de voz no las envíe: ElevenLabs no incluye la grabación
                en el webhook post-llamada.
              </p>
              {errorMas && (
                <p role="alert" className="mt-3 text-center text-sm text-warning-text">
                  {errorMas}. Las llamadas ya cargadas siguen aquí; podés
                  intentarlo de nuevo.
                </p>
              )}
              {hasMore && (
                <div className="mt-4 flex justify-center">
                  <Button
                    variant="outline"
                    disabled={cargandoMas}
                    onClick={() => void cargar(llamadas.length, true)}
                  >
                    {cargandoMas ? "Cargando…" : "Cargar más"}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
