"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Cable, Plus, Sparkles, Trash2 } from "lucide-react";
import { BrainStatusCard } from "@/components/agent/brain-status-card";
import {
  externalAnswerLabel,
  externalAnswering,
  externalDown,
  type BrainStatusDto,
} from "@/lib/brain-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

type Profile = {
  enabled: boolean;
  name: string;
  tone: string | null;
  instructions: string | null;
  escalationRules: string | null;
  greeting: string | null;
  emailSignature: string | null;
};

type KbEntry = {
  id: string;
  kind: "qa" | "block";
  question: string | null;
  answer: string | null;
  content: string | null;
};

export function AgentClient() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [aiConfigured, setAiConfigured] = useState(true);
  const [aiMensaje, setAiMensaje] = useState<string | null>(null);
  const [entries, setEntries] = useState<KbEntry[]>([]);
  const [kbSize, setKbSize] = useState<{ chars: number; warnAt: number; warning: boolean } | null>(null);
  const [saved, setSaved] = useState(false);
  // «Quién responde»: se refresca solo, porque la última llamada del cerebro
  // externo y su /health cambian sin que nadie toque esta pantalla.
  const [brain, setBrain] = useState<BrainStatusDto | null>(null);

  const loadBrain = useCallback(async () => {
    const b = await fetch("/api/agent/brain-status")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    setBrain(b);
  }, []);

  const refetch = useCallback(async () => {
    const [p, kb, size] = await Promise.all([
      fetch("/api/agent/profile").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/kb").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/kb/size").then((r) => (r.ok ? r.json() : null)),
      loadBrain(),
    ]).catch(() => [null, null, null]);
    if (p) {
      setProfile(p.profile);
      setAiConfigured(p.aiConfigured);
      setAiMensaje(p.aiMensaje ?? null);
    }
    if (kb) setEntries(kb.entries);
    if (size) setKbSize(size);
  }, [loadBrain]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    const id = setInterval(() => void loadBrain(), 30_000);
    return () => clearInterval(id);
  }, [loadBrain]);

  if (!profile) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Cargando…
      </div>
    );
  }

  async function saveProfile(patch: Partial<Profile>) {
    await fetch("/api/agent/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => null);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    void refetch();
  }

  // Sin token de IA, este aviso pedía configurarlo aunque contestara un
  // cerebro externo, y eso mentía. Con uno contestando, se dice eso; con uno
  // caído, ya lo dice la tarjeta de arriba.
  const aiCallout = aiConfigured
    ? null
    : brain && externalAnswering(brain)
      ? "externo"
      : brain && externalDown(brain)
        ? null
        : "configurar";

  return (
    <div className="h-full overflow-y-auto">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 sm:px-6 sm:py-4">
        <h2 className="text-[17px] font-bold tracking-tight">Agente de IA</h2>
        <div className="flex items-center gap-3">
          {saved && <span className="text-xs text-primary">Guardado ✓</span>}
          <span className="text-sm text-muted-foreground">
            {profile.enabled ? "Encendido" : "Apagado"}
          </span>
          {/* El interruptor compartido (#53): el pomo propio de aquí era
              `absolute` sin `left`, arrancaba del centro de la pista y
              encendido quedaba afuera. */}
          {/* Encender exige IA; APAGAR se puede siempre. Con la llave pausada
              (#85) el agente sigue «encendido» sin poder pensar, y un
              interruptor bloqueado dejaría al dueño sin forma de callarlo. */}
          <Switch
            checked={profile.enabled}
            disabled={!aiConfigured && !profile.enabled}
            label="Agente encendido"
            onCheckedChange={(enabled) => void saveProfile({ enabled })}
          />
        </div>
      </header>

      {brain && (
        <div className="mx-4 mt-4 sm:mx-6 sm:mt-6">
          <BrainStatusCard status={brain} />
        </div>
      )}

      {aiCallout === "externo" && brain && (
        <div className="mx-4 mt-4 rounded-lg border border-brand-soft bg-brand-tint p-5 text-center sm:mx-6 sm:mt-6 sm:p-6">
          <Cable className="mx-auto mb-2 h-8 w-8 text-primary" strokeWidth={1.7} />
          <p className="font-medium">{externalAnswerLabel(brain)}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            No necesitas el agente incluido: el comportamiento y el conocimiento
            que dejes aquí abajo quedan disponibles para tu cerebro externo por
            la API.
          </p>
        </div>
      )}
      {aiCallout === "configurar" && (
        <div className="mx-4 mt-4 rounded-lg border border-brand-soft bg-brand-tint p-5 text-center sm:mx-6 sm:mt-6 sm:p-6">
          <Sparkles className="mx-auto mb-2 h-8 w-8 text-primary" />
          <p className="font-medium">
            {aiMensaje ? "Tu agente no puede contestar" : "Configura tu proveedor de IA para activar el agente"}
          </p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            {aiMensaje ??
              "Elige el proveedor, el modelo y pega tu llave: sin reiniciar nada."}{" "}
            Mientras tanto puedes dejar listo el comportamiento y el conocimiento aquí
            abajo.
          </p>
          <Link
            href="/settings/ai"
            className="mt-3 inline-block text-sm font-medium text-brand-text underline underline-offset-2"
          >
            Ir a Ajustes → IA →
          </Link>
        </div>
      )}

      <div className="grid gap-4 p-4 sm:gap-6 sm:p-6 lg:grid-cols-2">
        <ProfileSection profile={profile} onSave={saveProfile} />
        <KbSection entries={entries} kbSize={kbSize} onChanged={() => void refetch()} />
      </div>
    </div>
  );
}

function ProfileSection({
  profile,
  onSave,
}: {
  profile: Profile;
  onSave: (patch: Partial<Profile>) => Promise<void>;
}) {
  const [form, setForm] = useState(profile);
  useEffect(() => setForm(profile), [profile]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Comportamiento</CardTitle>
        <CardDescription>
          Cómo se presenta y actúa el agente al responder a tus clientes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="agent-name">Nombre del agente</Label>
          <Input
            id="agent-name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="agent-tone">Tono</Label>
          <Input
            id="agent-tone"
            placeholder="p. ej. cercano y directo, con usted"
            value={form.tone ?? ""}
            onChange={(e) => setForm({ ...form, tone: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="agent-instructions">Instrucciones</Label>
          <Textarea
            id="agent-instructions"
            rows={5}
            placeholder="Qué debe y no debe hacer el agente…"
            value={form.instructions ?? ""}
            onChange={(e) => setForm({ ...form, instructions: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="agent-escalation">Reglas de escalado</Label>
          <Textarea
            id="agent-escalation"
            rows={3}
            placeholder="Cuándo pasar la conversación a un humano…"
            value={form.escalationRules ?? ""}
            onChange={(e) => setForm({ ...form, escalationRules: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="agent-greeting">Saludo</Label>
          <Input
            id="agent-greeting"
            placeholder="Saludo para conversaciones nuevas"
            value={form.greeting ?? ""}
            onChange={(e) => setForm({ ...form, greeting: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="agent-email-signature">Firma para correos</Label>
          <Textarea
            id="agent-email-signature"
            rows={3}
            placeholder={"Equipo de ventas\nTunegocio · Tel. 2222-2222"}
            value={form.emailSignature ?? ""}
            onChange={(e) => setForm({ ...form, emailSignature: e.target.value })}
          />
          <p className="text-xs text-text-2">
            Solo cierra los correos que responde el agente (tras el separador
            «--»). Los demás canales no la usan.
          </p>
        </div>
        <Button onClick={() => void onSave(form)}>Guardar comportamiento</Button>
      </CardContent>
    </Card>
  );
}

function KbSection({
  entries,
  kbSize,
  onChanged,
}: {
  entries: KbEntry[];
  kbSize: { chars: number; warnAt: number; warning: boolean } | null;
  onChanged: () => void;
}) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [block, setBlock] = useState("");

  async function addQa() {
    if (!question.trim() || !answer.trim()) return;
    await fetch("/api/kb", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "qa", question, answer }),
    }).catch(() => null);
    setQuestion("");
    setAnswer("");
    onChanged();
  }

  async function addBlock() {
    if (!block.trim()) return;
    await fetch("/api/kb", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "block", content: block }),
    }).catch(() => null);
    setBlock("");
    onChanged();
  }

  async function remove(id: string) {
    await fetch(`/api/kb/${id}`, { method: "DELETE" }).catch(() => null);
    onChanged();
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Knowledge base</CardTitle>
            <CardDescription>
              La única fuente de verdad del agente: lo que no está aquí, no lo
              afirma.
            </CardDescription>
          </div>
          {kbSize && (
            <Badge variant={kbSize.warning ? "warning" : "secondary"}>
              {kbSize.chars.toLocaleString("es-MX")} caracteres
            </Badge>
          )}
        </div>
        {kbSize?.warning && (
          <p className="text-xs text-warning-text">
            El conocimiento se acerca al límite del contexto del modelo (v1 lo
            inyecta completo en cada turno). Considera depurar entradas.
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">Nueva pregunta / respuesta</p>
          <Input
            placeholder="Pregunta (p. ej. ¿Hacen envíos?)"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <Textarea
            placeholder="Respuesta"
            rows={2}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <Button
            size="sm"
            onClick={() => void addQa()}
            disabled={!question.trim() || !answer.trim()}
          >
            <Plus className="h-4 w-4" /> Agregar P/R
          </Button>
        </div>

        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">Nuevo bloque de texto libre</p>
          <Textarea
            placeholder="Horarios, direcciones, políticas…"
            rows={3}
            value={block}
            onChange={(e) => setBlock(e.target.value)}
          />
          <Button size="sm" onClick={() => void addBlock()} disabled={!block.trim()}>
            <Plus className="h-4 w-4" /> Agregar bloque
          </Button>
        </div>

        <ul className="space-y-2">
          {entries.map((e) => (
            <li key={e.id} className="flex items-start gap-2 rounded-md border p-3">
              <div className="min-w-0 flex-1 text-sm">
                {e.kind === "qa" ? (
                  <>
                    <p className="font-medium">{e.question}</p>
                    <p className="mt-0.5 text-muted-foreground">{e.answer}</p>
                  </>
                ) : (
                  <p className="whitespace-pre-wrap text-muted-foreground">{e.content}</p>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Eliminar entrada"
                onClick={() => void remove(e.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
          {entries.length === 0 && (
            <p className="py-2 text-center text-xs text-muted-foreground">
              Sin entradas todavía: agrega lo que el agente debe saber.
            </p>
          )}
        </ul>
      </CardContent>
    </Card>
  );
}
