import { desc, eq, gte, lt } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { sumable } from "@/lib/money";
import type { ResolvedPeriod } from "@/server/analytics/period";
import { localDateExpr, notLabContact } from "@/server/analytics/shared";

/**
 * 042 — Descarga del cierre del período en Resultados.
 *
 * Población EXACTAMENTE la de Ventas (`sales.ts`): los leads cuyo
 * desenlace en el período es `won` (último movimiento del lead en el
 * rango, DISTINCT ON sobre `leadStageEvent`), sin contactos del
 * Laboratorio, con `scoped()` sobre la organización de la sesión. La
 * fecha de cada fila es la fecha del evento de cierre en la zona del
 * negocio, no la fecha de creación del lead: un pedido creado ayer y
 * entregado hoy cierra hoy.
 *
 * El armado del CSV vive separado de la consulta, puro y testeable sin
 * BD, igual que `clasificarCierres` en `sales.ts`. Los pedidos viejos
 * con monto NULL aparecen con total vacío y no suman: el cierre real
 * aplica desde el despliegue en adelante, sin backfill.
 */

/** Una fila del archivo, antes de formatearse a CSV. */
export type FilaCierre = {
  /** Fecha del cierre, `AAAA-MM-DD` en la zona del negocio. */
  fecha: string;
  cliente: string;
  /** Identificador del pedido del menú («Mesa 4», «Para llevar P-9202»); vacío en chat. */
  mesaOCodigo: string;
  /** Monto del lead en centavos; NULL = nadie lo capturó (pedido viejo). */
  totalCents: number | null;
  currency: string | null;
  /** Nombre de la etapa de cierre (en la soda, «Entregado»). */
  etapa: string;
};

export const ENCABEZADO_CIERRE = "Fecha;Cliente;Mesa o código;Total (₡);Etapa";

/**
 * Mesa o código a partir del nombre del contacto. Es un derivado del
 * nombre, NO una columna nueva (contrato 038: «Mesa 4 · Andrea»,
 * «Para llevar P-9202 · Andrea»). Solo los contactos de pedidos del
 * menú (`menu:<orderId>`) llevan identificador: en chat el campo queda
 * vacío aunque el nombre contenga un separador. Sin nombre de cliente
 * («Mesa 4» a secas), el identificador es el nombre entero.
 */
export function mesaOCodigoDeContacto(
  nombre: string,
  esPedidoMenu: boolean
): string {
  if (!esPedidoMenu) return "";
  const indice = nombre.indexOf(" · ");
  return indice === -1 ? nombre : nombre.slice(0, indice);
}

/** Centavos → colones con coma decimal y 2 decimales (`430000` → `4300,00`). */
export function formatearColones(cents: number): string {
  const signo = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const enteros = Math.floor(abs / 100);
  const decimales = String(abs % 100).padStart(2, "0");
  return `${signo}${enteros},${decimales}`;
}

/**
 * Escape CSV estándar: un campo que contenga `;`, comillas o salto de
 * línea va entre comillas dobles, y cada comilla doble dentro se duplica.
 */
export function escaparCampoCsv(campo: string): string {
  if (/[;"\r\n]/.test(campo)) {
    return `"${campo.replace(/"/g, '""')}"`;
  }
  return campo;
}

/**
 * Arma el archivo completo: BOM UTF-8 (para que Excel en español no
 * rompa los acentos al abrir con doble clic), delimitador `;` (la coma
 * es separador decimal), saltos CRLF y números con coma decimal.
 *
 * Orden de filas: fecha ascendente, luego cliente. La fila final
 * `TOTAL` suma SOLO las filas con monto en la moneda del negocio
 * (misma regla `sumable` que Ventas: jamás se convierte moneda). Sin
 * filas, el archivo trae encabezado + `TOTAL;;;0,00;`: nunca vacío.
 */
export function armarCsvCierre(
  filas: FilaCierre[],
  businessCurrency: string
): string {
  const ordenadas = [...filas].sort((a, b) => {
    if (a.fecha !== b.fecha) return a.fecha < b.fecha ? -1 : 1;
    if (a.cliente !== b.cliente) return a.cliente < b.cliente ? -1 : 1;
    return 0;
  });

  let totalCents = 0;
  const lineas = ordenadas.map((f) => {
    const conMonto = sumable(
      { amountCents: f.totalCents, currency: f.currency },
      businessCurrency
    );
    if (conMonto) totalCents += f.totalCents!;
    return [
      f.fecha,
      f.cliente,
      f.mesaOCodigo,
      conMonto ? formatearColones(f.totalCents!) : "",
      f.etapa,
    ]
      .map(escaparCampoCsv)
      .join(";");
  });

  lineas.push(
    ["TOTAL", "", "", formatearColones(totalCents), ""].join(";")
  );

  return `\uFEFF${[ENCABEZADO_CIERRE, ...lineas].join("\r\n")}\r\n`;
}

/**
 * Filas del cierre: último movimiento de cada lead en el período, y de
 * ahí solo los ganados. Es el mismo DISTINCT ON que
 * `desenlacesDelPeriodo` en `sales.ts`, más el nombre del contacto y
 * su identidad (para distinguir pedidos del menú de pedidos por chat).
 */
export async function filasCierre(
  organizationId: string,
  period: ResolvedPeriod
): Promise<FilaCierre[]> {
  const desenlaces = await getDb()
    .selectDistinctOn([schema.leadStageEvent.leadId], {
      kind: schema.leadStageEvent.toStageKind,
      fecha: localDateExpr(schema.leadStageEvent.occurredAt, period.timezone, false),
      etapa: schema.leadStageEvent.toStageName,
      cliente: schema.contact.name,
      identidad: schema.contact.waIdentity,
      totalCents: schema.lead.amountCents,
      currency: schema.lead.currency,
    })
    .from(schema.leadStageEvent)
    .innerJoin(schema.lead, eq(schema.lead.id, schema.leadStageEvent.leadId))
    .innerJoin(schema.contact, eq(schema.contact.id, schema.leadStageEvent.contactId))
    .where(
      scoped(
        schema.leadStageEvent.organizationId,
        organizationId,
        gte(schema.leadStageEvent.occurredAt, period.start),
        lt(schema.leadStageEvent.occurredAt, period.end),
        notLabContact(schema.leadStageEvent.contactId)
      )
    )
    .orderBy(
      schema.leadStageEvent.leadId,
      desc(schema.leadStageEvent.occurredAt),
      desc(schema.leadStageEvent.createdAt)
    );

  return desenlaces
    .filter((d) => d.kind === "won")
    .map((d) => ({
      fecha: d.fecha,
      cliente: d.cliente,
      mesaOCodigo: mesaOCodigoDeContacto(
        d.cliente,
        d.identidad.startsWith("menu:")
      ),
      totalCents: d.totalCents,
      currency: d.currency,
      etapa: d.etapa,
    }));
}

/** El archivo completo del período, listo para descargar. */
export async function construirCsvCierre(
  organizationId: string,
  period: ResolvedPeriod,
  businessCurrency: string
): Promise<string> {
  const filas = await filasCierre(organizationId, period);
  return armarCsvCierre(filas, businessCurrency);
}
