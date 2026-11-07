import { timingSafeEqual } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";

/**
 * 050 — Historial de llamadas de los agentes de voz.
 *
 * El puente de voz (n8n, `Puente_Voz_Vocero.json`) le hace POST a
 * `/api/voz/post-llamada` tras cada llamada y la pestaña lee lo guardado
 * por `GET /api/voice/calls`. La ruta solo exporta handlers; la lógica vive
 * aquí para poder probarla.
 *
 * Lo que el puente envía HOY (su nodo "Normalizar" lee campos adivinados en
 * la raíz del body, sin verificar contra el payload real de ElevenLabs):
 * `instance`, `phone`, `name`, `direction`, `duration_sec`, `summary`,
 * `recording_url`. El schema acepta esos campos MÁS los opcionales
 * `agent_id`, `conversation_id` y `transcript`, que el puente aún no manda
 * pero el endpoint ya acepta para cuando lleguen.
 *
 * `instance` se acepta y se IGNORA: no existe ningún mapeo instance→org.
 * La org es la de la instancia (`resolveInstanceOrg` devuelve la primera
 * organización de la BD; una instancia = un negocio). Varias organizaciones
 * en una misma instancia NO están soportadas: el campo `instance` del puente
 * no decide nada y dos negocios en una instancia compartirían historial.
 *
 * El puente manda "" en los campos que no trae: el schema normaliza "" a
 * ausente (NULL al guardar) en vez de guardar una cadena vacía como dato.
 * `phone` es opcional por la misma razón: sin teléfono la llamada se guarda
 * igual (phone NULL) y la UI enseña "—".
 *
 * El endpoint NO inventa datos que el puente no envía: lo que no viene
 * queda NULL y la UI lo enseña con "—".
 */

const MIN_KEY_LENGTH = 16;

/** La superficie está abierta: hay `VOZ_API_KEY` y no es débil. */
export function isVozKeyConfigured(): boolean {
  const key = process.env.VOZ_API_KEY;
  return typeof key === "string" && key.length >= MIN_KEY_LENGTH;
}

/**
 * Header `X-Voz-Key` contra `VOZ_API_KEY` (env), comparación en tiempo
 * constante — mismo patrón que `validBotKey` en `src/server/bot/auth.ts`.
 * Sin `VOZ_API_KEY` configurada, nada pasa.
 */
export function validVozKey(provided: string | null): boolean {
  const expected = process.env.VOZ_API_KEY;
  if (!expected || !isVozKeyConfigured() || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * El puente manda "" en los campos que no trae: "" es ausente, no un dato.
 * También se tratan como ausentes las cadenas de solo espacios.
 */
function vacioAusente(valor: unknown): unknown {
  return typeof valor === "string" && valor.trim() === ""
    ? undefined
    : valor;
}

/** Cadena opcional: "" → ausente (NULL al guardar). */
function textoOpcional(
  max: number,
): z.ZodType<string | null | undefined, z.ZodTypeDef, unknown> {
  return z.preprocess(vacioAusente, z.string().max(max).nullish());
}

/** Entero ≥ 0 opcional: acepta número o string numérico ("95" → 95). */
function enteroOpcional(): z.ZodType<number | null | undefined, z.ZodTypeDef, unknown> {
  return z.preprocess(
    vacioAusente,
    z
      .union([
        z.number().int().min(0),
        z
          .string()
          .regex(/^\d+$/, "debe ser un entero ≥ 0")
          .transform((valor) => Number(valor)),
      ])
      .nullish(),
  );
}

/** URL opcional solo http(s): "" → ausente; otro esquema se rechaza. */
const urlHttpOpcional: z.ZodType<
  string | null | undefined,
  z.ZodTypeDef,
  unknown
> = z.preprocess(
  vacioAusente,
  z
    .string()
    .max(2000)
    .refine(
      (url) => {
        try {
          const u = new URL(url);
          return u.protocol === "http:" || u.protocol === "https:";
        } catch {
          return false;
        }
      },
      { message: "recording_url debe ser una URL http(s)" },
    )
    .nullish(),
);

/**
 * Lo que el puente manda tras cada llamada. `phone` es OPCIONAL: el puente
 * no siempre lo trae y la llamada no se puede perder por eso (queda NULL y
 * la UI enseña "—"). Todo lo demás es opcional porque el puente de hoy no
 * lo trae todo (y lo que no trae queda NULL, no inventado). Las llaves
 * desconocidas se ignoran (Zod las quita): si ElevenLabs o el puente
 * agregan campos, el endpoint no se rompe. `direction` es enum estricto
 * (`inbound`/`outbound`); cuando falta, el registro usa `inbound`.
 */
export const vozPostLlamadaSchema = z.object({
  /** El puente lo manda ("tep" o "main"); se acepta y se ignora: no existe
   *  ningún mapeo instance→org (ver comentario del encabezado). */
  instance: textoOpcional(60),
  phone: textoOpcional(30),
  name: textoOpcional(120),
  direction: z.enum(["inbound", "outbound"]).nullish(),
  duration_sec: enteroOpcional(),
  /** Alias por si un puente futuro manda el nombre del campo de ElevenLabs. */
  duration_secs: enteroOpcional(),
  summary: textoOpcional(8000),
  /** Solo http(s): una URL con otro esquema (o texto libre) se rechaza. */
  recording_url: urlHttpOpcional,
  /** Opcionales que el puente aún no envía (ver spec 050). */
  agent_id: textoOpcional(120),
  conversation_id: textoOpcional(120),
  transcript: textoOpcional(100_000),
});

export type VozPostLlamadaInput = z.infer<typeof vozPostLlamadaSchema>;

export type VoiceCallRow = typeof schema.voiceCall.$inferSelect;

export type RegistrarLlamadaResult =
  | { duplicate: false; id: string }
  | { duplicate: true; id: string };

/**
 * Guarda una llamada del puente. Idempotente por (organization_id,
 * conversation_id) cuando viene: el UNIQUE compuesto de la tabla hace que
 * un reintento devuelva la fila ya guardada (`duplicate: true`) en vez de
 * duplicarla. Sin `conversation_id` (el puente de hoy) no hay dedup posible
 * y cada POST inserta una fila.
 */
export async function registrarLlamadaVoz(
  organizationId: string,
  input: VozPostLlamadaInput,
): Promise<RegistrarLlamadaResult> {
  const db = getDb();
  const conversationId = input.conversation_id ?? null;
  const durationSec =
    input.duration_sec ?? input.duration_secs ?? 0;

  if (conversationId) {
    const existentes = await db
      .select({ id: schema.voiceCall.id })
      .from(schema.voiceCall)
      .where(
        scoped(
          schema.voiceCall.organizationId,
          organizationId,
          eq(schema.voiceCall.conversationId, conversationId),
        ),
      )
      .limit(1);
    const existente = existentes[0];
    if (existente) return { duplicate: true, id: existente.id };
  }

  const [fila] = await db
    .insert(schema.voiceCall)
    .values({
      id: newId("voiceCall"),
      organizationId,
      agentId: input.agent_id ?? null,
      conversationId,
      phone: input.phone ?? null,
      callerName: input.name ?? null,
      direction: input.direction ?? "inbound",
      durationSec,
      summary: input.summary ?? null,
      transcript: input.transcript ?? null,
      recordingUrl: input.recording_url ?? null,
    })
    .onConflictDoNothing({
      target: [
        schema.voiceCall.organizationId,
        schema.voiceCall.conversationId,
      ],
    })
    .returning({ id: schema.voiceCall.id });

  // Dos POST simultáneos con el mismo conversation_id: el perdedor no
  // inserta nada (el UNIQUE lo frena) y cae aquí a buscar la fila ganadora.
  // Sin conversation_id no puede haber conflicto: si no hay fila, es un
  // fallo real y se devuelve un error controlado, no una búsqueda con null.
  if (!fila) {
    if (!conversationId) {
      throw new Error("No se pudo registrar la llamada de voz");
    }
    const ganadora = await db
      .select({ id: schema.voiceCall.id })
      .from(schema.voiceCall)
      .where(
        scoped(
          schema.voiceCall.organizationId,
          organizationId,
          eq(schema.voiceCall.conversationId, conversationId),
        ),
      )
      .limit(1);
    const id = ganadora[0]?.id;
    if (!id) throw new Error("No se pudo registrar la llamada de voz");
    return { duplicate: true, id };
  }
  return { duplicate: false, id: fila.id };
}

export type ListarLlamadasOptions = {
  limit?: number;
  offset?: number;
};

/** Límite de página: lo que pide la UI, con tope de seguridad. */
export const VOICE_CALLS_PAGE_MAX = 100;

/**
 * Historial de la organización, fecha desc. Paginado con `limit`/`offset`
 * (tope 100): la UI pide de 50 en 50 y avanza con "Cargar más".
 * `hasMore` se resuelve pidiendo una fila de más, sin un COUNT aparte.
 */
export async function listarLlamadasVoz(
  organizationId: string,
  options: ListarLlamadasOptions = {},
): Promise<{ calls: VoiceCallRow[]; hasMore: boolean }> {
  const limit = Math.min(
    Math.max(Math.floor(options.limit ?? 50), 1),
    VOICE_CALLS_PAGE_MAX,
  );
  const offset = Math.max(Math.floor(options.offset ?? 0), 0);
  const filas = await getDb()
    .select()
    .from(schema.voiceCall)
    .where(scoped(schema.voiceCall.organizationId, organizationId))
    .orderBy(desc(schema.voiceCall.createdAt))
    .limit(limit + 1)
    .offset(offset);
  return {
    calls: filas.slice(0, limit),
    hasMore: filas.length > limit,
  };
}

/** Lo que `GET /api/voice/calls` devuelve por llamada (JSON plano). */
export function serializarLlamadaVoz(fila: VoiceCallRow) {
  return {
    id: fila.id,
    agentId: fila.agentId,
    conversationId: fila.conversationId,
    phone: fila.phone,
    callerName: fila.callerName,
    direction: fila.direction,
    durationSec: fila.durationSec,
    summary: fila.summary,
    transcript: fila.transcript,
    recordingUrl: fila.recordingUrl,
    createdAt: fila.createdAt.toISOString(),
  };
}

export type LlamadaVozSerializada = ReturnType<typeof serializarLlamadaVoz>;
