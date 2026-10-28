/**
 * 040 — Orden de las tarjetas del tablero: la nueva arriba.
 *
 * Los leads nacen con `maxPos + 1` (la posición más alta), así que
 * ordenar por posición DESCENDENTE deja al más nuevo primero, sin
 * migración ni reescritura de posiciones en BD. Las dos funciones de
 * aquí son las que el cliente y el arrastre comparten, y por eso son
 * puras y probadas: el componente no tiene tests (como en 038/039)
 * y la lógica de orden no puede quedar solo en su JSX.
 */

/** Comparador para `Array.sort`: posición mayor primero. */
export function comparePositionDesc(
  a: { position: number },
  b: { position: number },
): number {
  return b.position - a.position;
}

/**
 * Posición que recibe una tarjeta soltada en una columna.
 *
 * El arrastre de hoy es POR COLUMNA, no por hueco: el destino
 * (`useDroppable`) es la columna entera y `onDragEnd` solo sabe a
 * qué etapa cayó, nunca entre qué dos tarjetas. Por eso no hay
 * "soltar en medio" ni "soltar abajo" como gestos distintos: toda
 * tarjeta soltada aterriza en UN extremo de la columna destino, y
 * ese extremo es el de arriba, coherente con "lo nuevo arriba".
 *
 * `max + 1` (y 0 si la columna está vacía) garantiza tres cosas
 * que el cálculo viejo (`cantidad de tarjetas en la columna`) no
 * garantizaba con el orden nuevo:
 * - Es MAYOR que la del actual primero, así que con sort
 *   descendente la tarjeta soltada queda arriba, sin empate.
 * - No empata con nadie aunque haya huecos (si las posiciones
 *   son 0 y 2, la cantidad es 2 y empataría con la que ya tiene
 *   2; `max + 1` da 3).
 * - Nunca es negativa, que es lo que exige el PATCH del lead
 *   (`position: z.number().int().min(0)`).
 *
 * Reordenar dentro de la misma columna NO existe hoy: `onDragEnd`
 * ignora el arrastre si la etapa destino es la misma que la de
 * origen, así que esta función solo se usa al cambiar de columna.
 */
export function dropPositionAtTop(positionsInDestination: number[]): number {
  if (positionsInDestination.length === 0) return 0;
  return Math.max(...positionsInDestination) + 1;
}
