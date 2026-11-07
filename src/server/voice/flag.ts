/**
 * 050 — Si esta instancia tiene agentes de voz o no.
 *
 * Mismo patrón que la agenda (015, `src/server/agenda/flag.ts`) y los
 * canales opcionales (ADR-001): el código viaja siempre en main, y lo que
 * decide si EXISTE para el usuario es una variable de despliegue (`VOZ`).
 * Una instancia normal (sin `VOZ`) no ve la voz por ningún lado: ni pestaña
 * de "Agentes de voz", ni rutas, ni historial.
 *
 * La migración se aplica siempre: unas tablas vacías son inertes, y a cambio
 * todas las instancias comparten la misma estructura.
 *
 * No hay mecanismo por organización: una instancia = un negocio, así que la
 * bandera de despliegue equivale a condicionar por organización en el
 * despliegue real.
 */

/** Valores que cuentan como "encendida". Cualquier otra cosa, apagada. */
const ON_VALUES = new Set(["on", "1", "true", "si", "sí", "yes"]);

export function parseVozFlag(raw: string | undefined): boolean {
  return ON_VALUES.has((raw ?? "").trim().toLowerCase());
}

/**
 * Se lee de `process.env` directo, no por `getEnv()`, igual que
 * `agendaEnabled()`: preguntar si una feature existe no puede depender de
 * que TODO el entorno valide.
 *
 * `VOZ` sí está declarada en el esquema de `lib/env.ts`: ahí vive su
 * documentación y su tipo. Lo que no pasa por el validador es esta consulta.
 */
export function vozEnabled(): boolean {
  return parseVozFlag(process.env.VOZ);
}

/**
 * Respuesta para una superficie de voz apagada. 404 y no 403 a propósito:
 * si la voz no está encendida, ese endpoint no existe en esta instancia —
 * no hay nada que revelar sobre él (ADR-001).
 */
export function vozDisabledResponse(): Response {
  return new Response(null, { status: 404 });
}
