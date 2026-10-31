import { and, count, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { newId } from "@/lib/db/ids";
import { isTemplateLanguage } from "@/lib/template-languages";

/**
 * 048 — Campañas por WhatsApp: CRUD, destinatarios y transiciones de estado.
 *
 * La lógica vive aquí para que las rutas (`src/app/api/campaigns/**`) sean
 * solo handlers y el worker (`worker.ts`) reuse las transiciones. Todo input
 * externo entra validado con Zod; toda consulta de dominio pasa por
 * `scoped()`. Los destinatarios no llevan `organization_id` propio: se
 * alcanzan siempre a través de su campaña (verificada con scope), y el
 * teléfono se congela en dígitos al agregar.
 */

export type FilaCampana = typeof schema.campaign.$inferSelect;
export type FilaDestinatario = typeof schema.campaignRecipient.$inferSelect;

export type EstadoCampana = FilaCampana["status"];
export type EstadoDestinatario = FilaDestinatario["status"];

/** Error de dominio de campañas: el código decide el status HTTP. */
export class CampaignError extends Error {
  readonly code:
    | "not_found"
    | "estado_invalido"
    | "sin_destinatarios"
    | "sin_plantilla"
    | "sin_telefono";
  constructor(
    code: CampaignError["code"],
    message: string
  ) {
    super(message);
    this.name = "CampaignError";
    this.code = code;
  }
}

export function campaignErrorStatus(err: CampaignError): number {
  switch (err.code) {
    case "not_found":
      return 404;
    case "estado_invalido":
      return 409;
    case "sin_destinatarios":
    case "sin_plantilla":
    case "sin_telefono":
      return 422;
  }
}

// ---------------------------------------------------------------------------
// Validación (pura; también la usan los tests sin BD)
// ---------------------------------------------------------------------------

/** Nombre de plantilla de Meta: minúsculas, dígitos y guion bajo. */
export const NOMBRE_PLANTILLA_RE = /^[a-z0-9_]{1,512}$/;

const variablesSchema = z.record(z.string().max(500)).refine(
  (v) => Object.keys(v).length <= 20,
  "Máximo 20 variables por plantilla"
);

export const crearCampanaSchema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio").max(120),
  templateName: z
    .string()
    .trim()
    .regex(
      NOMBRE_PLANTILLA_RE,
      "El nombre de la plantilla solo admite minúsculas, dígitos y _"
    ),
  // Solo los idiomas que Meta acepta: uno fuera de la lista es rechazo seguro.
  templateLanguage: z
    .string()
    .trim()
    .refine(isTemplateLanguage, "Meta no acepta plantillas en ese idioma")
    .default("es_CR"),
  variables: variablesSchema.optional(),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
});

export type CrearCampanaInput = z.input<typeof crearCampanaSchema>;

export const actualizarCampanaSchema = crearCampanaSchema.partial();
export type ActualizarCampanaInput = z.infer<typeof actualizarCampanaSchema>;

export const loteDestinatariosSchema = z.object({
  recipients: z
    .array(
      z.object({
        phone: z.string().min(1, "El teléfono es obligatorio").max(30),
        contactId: z.string().trim().min(1).max(60).optional(),
        variables: variablesSchema.optional(),
      })
    )
    .min(1, "El lote no puede venir vacío")
    .max(2000, "Máximo 2000 destinatarios por lote"),
});

export type LoteDestinatariosInput = z.infer<typeof loteDestinatariosSchema>;

/**
 * Normaliza un teléfono a dígitos (sin `+`), 7–15 (misma regla que 046/D5).
 * Pura, para tests sin BD.
 */
export function normalizarTelefonoCampana(
  raw: string
): { ok: true; phone: string } | { ok: false; reason: string } {
  const phone = raw.replace(/\D/g, "");
  if (!phone) return { ok: false, reason: "sin_telefono" };
  if (phone.length < 7 || phone.length > 15)
    return { ok: false, reason: "telefono_invalido" };
  return { ok: true, phone };
}

/**
 * Fusiona las variables globales de la campaña con las propias del
 * destinatario: las del destinatario mandan. Pura, para el worker y tests.
 */
export function fusionarVariables(
  globales: Record<string, string> | null | undefined,
  propias: Record<string, string> | null | undefined
): Record<string, string> {
  return { ...(globales ?? {}), ...(propias ?? {}) };
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

async function campanaDeLaOrg(
  organizationId: string,
  id: string
): Promise<FilaCampana | null> {
  const [fila] = await getDb()
    .select()
    .from(schema.campaign)
    .where(scoped(schema.campaign.organizationId, organizationId, eq(schema.campaign.id, id)))
    .limit(1);
  return fila ?? null;
}

export async function obtenerCampana(
  organizationId: string,
  id: string
): Promise<FilaCampana> {
  const campana = await campanaDeLaOrg(organizationId, id);
  if (!campana) throw new CampaignError("not_found", "Campaña no encontrada");
  return campana;
}

export type CampanaConConteos = {
  campana: FilaCampana;
  total: number;
  enviados: number;
  fallidos: number;
};

/** Lista las campañas de la org con conteos básicos de destinatarios. */
export async function listarCampanas(
  organizationId: string
): Promise<CampanaConConteos[]> {
  const enviados = sql<number>`count(*) filter (where ${schema.campaignRecipient.status} = 'enviado')`.mapWith(
    Number
  );
  const fallidos = sql<number>`count(*) filter (where ${schema.campaignRecipient.status} = 'fallido')`.mapWith(
    Number
  );
  const filas = await getDb()
    .select({
      campana: schema.campaign,
      total: count(schema.campaignRecipient.id),
      enviados,
      fallidos,
    })
    .from(schema.campaign)
    .leftJoin(
      schema.campaignRecipient,
      eq(schema.campaign.id, schema.campaignRecipient.campaignId)
    )
    .where(scoped(schema.campaign.organizationId, organizationId))
    .groupBy(schema.campaign.id)
    .orderBy(desc(schema.campaign.createdAt));
  return filas;
}

export type ReporteCampana = {
  campana: FilaCampana;
  conteos: Record<EstadoDestinatario | "total", number>;
};

/** Conteos por estado de destinatario para el reporte de la campaña. */
export async function reporteCampana(
  organizationId: string,
  id: string
): Promise<ReporteCampana> {
  const campana = await obtenerCampana(organizationId, id);
  const filas = await getDb()
    .select({
      status: schema.campaignRecipient.status,
      n: count(schema.campaignRecipient.id),
    })
    .from(schema.campaignRecipient)
    .where(eq(schema.campaignRecipient.campaignId, campana.id))
    .groupBy(schema.campaignRecipient.status);
  const conteos: ReporteCampana["conteos"] = {
    pendiente: 0,
    enviado: 0,
    entregado: 0,
    leido: 0,
    fallido: 0,
    total: 0,
  };
  for (const f of filas) {
    conteos[f.status] = f.n;
    conteos.total += f.n;
  }
  return { campana, conteos };
}

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------

function estadoInicialPara(scheduledAt?: string): EstadoCampana {
  // Con fecha futura nace programada; sin fecha (o ya vencida), borrador.
  if (scheduledAt && new Date(scheduledAt).getTime() > Date.now())
    return "programada";
  return "borrador";
}

export async function crearCampana(
  organizationId: string,
  input: CrearCampanaInput
): Promise<FilaCampana> {
  const [fila] = await getDb()
    .insert(schema.campaign)
    .values({
      id: newId("campaign"),
      organizationId,
      name: input.name,
      templateName: input.templateName,
      // El default de Zod no sobrevive al .refine() en el tipo inferido:
      // se aplica aquí.
      templateLanguage: input.templateLanguage ?? "es_CR",
      variables: input.variables ?? null,
      status: estadoInicialPara(input.scheduledAt),
      scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
    })
    .returning();
  if (!fila) throw new Error("crearCampana: el insert no devolvió la fila");
  return fila;
}

const EDITABLES_EN_PROGRAMADA = ["scheduledAt"] as const;

export async function actualizarCampana(
  organizationId: string,
  id: string,
  input: ActualizarCampanaInput
): Promise<FilaCampana> {
  const campana = await obtenerCampana(organizationId, id);
  if (campana.status !== "borrador" && campana.status !== "programada") {
    throw new CampaignError(
      "estado_invalido",
      `La campaña en estado "${campana.status}" ya no se puede editar`
    );
  }
  if (campana.status === "programada") {
    const prohibidas = Object.keys(input).filter(
      (k) => !(EDITABLES_EN_PROGRAMADA as readonly string[]).includes(k)
    );
    if (prohibidas.length > 0) {
      throw new CampaignError(
        "estado_invalido",
        `En una campaña programada solo se puede cambiar la fecha (scheduledAt)`
      );
    }
  }
  const cambios: Partial<FilaCampana> = { updatedAt: new Date() };
  if (input.name !== undefined) cambios.name = input.name;
  if (input.templateName !== undefined) cambios.templateName = input.templateName;
  if (input.templateLanguage !== undefined)
    cambios.templateLanguage = input.templateLanguage;
  if (input.variables !== undefined) cambios.variables = input.variables;
  if (input.scheduledAt !== undefined) {
    cambios.scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
    // Si estaba en borrador y le ponen fecha futura, pasa a programada; si
    // estaba programada y le quitan la fecha, vuelve a borrador.
    if (campana.status === "borrador") {
      cambios.status = estadoInicialPara(input.scheduledAt);
    } else if (!input.scheduledAt) {
      cambios.status = "borrador";
    }
  }
  const [fila] = await getDb()
    .update(schema.campaign)
    .set(cambios)
    .where(
      scoped(
        schema.campaign.organizationId,
        organizationId,
        eq(schema.campaign.id, id)
      )
    )
    .returning();
  if (!fila) throw new CampaignError("not_found", "Campaña no encontrada");
  return fila;
}

export async function eliminarCampana(
  organizationId: string,
  id: string
): Promise<void> {
  const campana = await obtenerCampana(organizationId, id);
  if (campana.status === "enviando") {
    throw new CampaignError(
      "estado_invalido",
      "Pausa la campaña antes de eliminarla"
    );
  }
  await getDb()
    .delete(schema.campaign)
    .where(
      scoped(
        schema.campaign.organizationId,
        organizationId,
        eq(schema.campaign.id, id)
      )
    );
}

export type ResultadoLote = {
  agregados: number;
  duplicados: number;
  invalidos: { phone: string; reason: string }[];
};

const TAMANO_INSERCION = 500;

/**
 * Agrega destinatarios en lote. 048/D1: agregar = opt-in explícito.
 * El teléfono se normaliza a dígitos y se congela; el duplicado
 * (campaña+teléfono, índice único) se ignora y se reporta, no falla el lote.
 */
export async function agregarDestinatarios(
  organizationId: string,
  campaignId: string,
  input: LoteDestinatariosInput
): Promise<ResultadoLote> {
  const campana = await obtenerCampana(organizationId, campaignId);
  if (campana.status === "completada" || campana.status === "cancelada") {
    throw new CampaignError(
      "estado_invalido",
      `La campaña en estado "${campana.status}" ya no acepta destinatarios`
    );
  }

  const resultado: ResultadoLote = { agregados: 0, duplicados: 0, invalidos: [] };

  // Los contactId se validan en una sola consulta: solo valen los de la org.
  const idsPedidos = [
    ...new Set(
      input.recipients
        .map((r) => r.contactId)
        .filter((c): c is string => !!c)
    ),
  ];
  const contactosValidos = new Set<string>();
  if (idsPedidos.length > 0) {
    const filas = await getDb()
      .select({ id: schema.contact.id })
      .from(schema.contact)
      .where(
        scoped(
          schema.contact.organizationId,
          organizationId,
          inArray(schema.contact.id, idsPedidos)
        )
      );
    for (const f of filas) contactosValidos.add(f.id);
  }

  const validos: {
    phone: string;
    contactId: string | null;
    variables: Record<string, string> | null;
  }[] = [];
  for (const r of input.recipients) {
    const tel = normalizarTelefonoCampana(r.phone);
    if (!tel.ok) {
      resultado.invalidos.push({ phone: r.phone, reason: tel.reason });
      continue;
    }
    if (r.contactId && !contactosValidos.has(r.contactId)) {
      resultado.invalidos.push({
        phone: r.phone,
        reason: "contacto_desconocido",
      });
      continue;
    }
    validos.push({
      phone: tel.phone,
      contactId: r.contactId ?? null,
      variables: r.variables ?? null,
    });
  }

  // Inserción por tramos: el índice único (campaign_id, phone) hace el
  // dedupe — `onConflictDoNothing` ignora el duplicado sin fallar.
  for (let i = 0; i < validos.length; i += TAMANO_INSERCION) {
    const tramo = validos.slice(i, i + TAMANO_INSERCION);
    const insertados = await getDb()
      .insert(schema.campaignRecipient)
      .values(
        tramo.map((v) => ({
          id: newId("campaignRecipient"),
          campaignId: campana.id,
          contactId: v.contactId,
          phone: v.phone,
          variables: v.variables,
        }))
      )
      .onConflictDoNothing({
        target: [
          schema.campaignRecipient.campaignId,
          schema.campaignRecipient.phone,
        ],
      })
      .returning({ id: schema.campaignRecipient.id });
    resultado.agregados += insertados.length;
  }
  resultado.duplicados = validos.length - resultado.agregados;
  return resultado;
}

async function contarPendientes(campaignId: string): Promise<number> {
  const [fila] = await getDb()
    .select({ n: count(schema.campaignRecipient.id) })
    .from(schema.campaignRecipient)
    .where(
      and(
        eq(schema.campaignRecipient.campaignId, campaignId),
        eq(schema.campaignRecipient.status, "pendiente")
      )
    );
  return fila?.n ?? 0;
}

export async function iniciarCampana(
  organizationId: string,
  id: string
): Promise<FilaCampana> {
  const campana = await obtenerCampana(organizationId, id);
  if (
    campana.status !== "borrador" &&
    campana.status !== "programada" &&
    campana.status !== "pausada"
  ) {
    throw new CampaignError(
      "estado_invalido",
      `La campaña en estado "${campana.status}" no se puede iniciar`
    );
  }
  if (!campana.templateName) {
    throw new CampaignError("sin_plantilla", "La campaña no tiene plantilla");
  }
  const pendientes = await contarPendientes(campana.id);
  if (pendientes === 0) {
    throw new CampaignError(
      "sin_destinatarios",
      "La campaña no tiene destinatarios pendientes"
    );
  }
  const [fila] = await getDb()
    .update(schema.campaign)
    .set({
      status: "enviando",
      startedAt: new Date(),
      completedAt: null,
      updatedAt: new Date(),
    })
    .where(
      scoped(
        schema.campaign.organizationId,
        organizationId,
        eq(schema.campaign.id, id)
      )
    )
    .returning();
  if (!fila) throw new CampaignError("not_found", "Campaña no encontrada");
  return fila;
}

export async function pausarCampana(
  organizationId: string,
  id: string
): Promise<FilaCampana> {
  const campana = await obtenerCampana(organizationId, id);
  if (campana.status !== "enviando" && campana.status !== "programada") {
    throw new CampaignError(
      "estado_invalido",
      `La campaña en estado "${campana.status}" no se puede pausar`
    );
  }
  const [fila] = await getDb()
    .update(schema.campaign)
    .set({ status: "pausada", updatedAt: new Date() })
    .where(
      scoped(
        schema.campaign.organizationId,
        organizationId,
        eq(schema.campaign.id, id)
      )
    )
    .returning();
  if (!fila) throw new CampaignError("not_found", "Campaña no encontrada");
  return fila;
}

// ---------------------------------------------------------------------------
// Lo que usa el worker (transiciones internas, sin validación de negocio)
// ---------------------------------------------------------------------------

/** Promueve las programadas con fecha vencida a `enviando`. */
export async function promoverProgramadasVencidas(
  ahora: Date = new Date()
): Promise<number> {
  const filas = await getDb()
    .update(schema.campaign)
    .set({ status: "enviando", startedAt: ahora, updatedAt: ahora })
    .where(
      and(
        eq(schema.campaign.status, "programada"),
        lte(schema.campaign.scheduledAt, ahora)
      )
    )
    .returning({ id: schema.campaign.id });
  return filas.length;
}

/** Toma campañas en `enviando` para una pasada del worker. */
export async function tomarCampanasEnviando(
  limite: number
): Promise<FilaCampana[]> {
  return getDb()
    .select()
    .from(schema.campaign)
    .where(eq(schema.campaign.status, "enviando"))
    .orderBy(schema.campaign.startedAt)
    .limit(limite);
}

/** Toma destinatarios pendientes de una campaña (los más viejos primero). */
export async function tomarDestinatariosPendientes(
  campaignId: string,
  limite: number
): Promise<FilaDestinatario[]> {
  return getDb()
    .select()
    .from(schema.campaignRecipient)
    .where(
      and(
        eq(schema.campaignRecipient.campaignId, campaignId),
        eq(schema.campaignRecipient.status, "pendiente")
      )
    )
    .orderBy(schema.campaignRecipient.id)
    .limit(limite);
}

export async function marcarDestinatarioEnviado(
  campaignId: string,
  recipientId: string,
  platformMessageId: string
): Promise<void> {
  await getDb()
    .update(schema.campaignRecipient)
    .set({
      status: "enviado",
      platformMessageId,
      sentAt: new Date(),
      lastError: null,
    })
    .where(
      and(
        eq(schema.campaignRecipient.id, recipientId),
        eq(schema.campaignRecipient.campaignId, campaignId)
      )
    );
}

export async function marcarDestinatarioFallido(
  campaignId: string,
  recipientId: string,
  lastError: string
): Promise<void> {
  await getDb()
    .update(schema.campaignRecipient)
    .set({
      status: "fallido",
      lastError: lastError.slice(0, 500),
    })
    .where(
      and(
        eq(schema.campaignRecipient.id, recipientId),
        eq(schema.campaignRecipient.campaignId, campaignId)
      )
    );
}

/** Sin más pendientes: la campaña se da por completada. */
export async function completarCampanaSiNoQuedanPendientes(
  campaignId: string,
  ahora: Date = new Date()
): Promise<boolean> {
  const pendientes = await contarPendientes(campaignId);
  if (pendientes > 0) return false;
  await getDb()
    .update(schema.campaign)
    .set({ status: "completada", completedAt: ahora, updatedAt: ahora })
    .where(eq(schema.campaign.id, campaignId));
  return true;
}
