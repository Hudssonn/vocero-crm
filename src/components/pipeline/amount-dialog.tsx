"use client";

import { useState } from "react";
import { formatMoneyCents, parseMoneyToCents } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Monto de un trato: el dato que el dueño ajusta desde el tablero sin
 * abrir nada más.
 *
 * Acepta lo que el dueño escriba —"12,500", "$12 500.50"— porque nadie teclea
 * centavos, y guarda centavos enteros. Vacío BORRA el monto: un trato sin
 * número no vale cero, simplemente no se sabe, y esa diferencia se nota en el
 * total de la columna.
 */
export function AmountDialog({
  leadName,
  currency,
  amountCents,
  onCancel,
  onSave,
}: {
  leadName: string;
  currency: string;
  amountCents: number | null;
  onCancel: () => void;
  onSave: (cents: number | null) => void;
}) {
  const [texto, setTexto] = useState(
    amountCents === null ? "" : (amountCents / 100).toFixed(2)
  );
  const parsed = texto.trim() ? parseMoneyToCents(texto) : null;
  const invalido = texto.trim().length > 0 && parsed === null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Monto"
    >
      <div className="w-full max-w-sm rounded-lg border bg-popover p-4 shadow-pop">
        <h3 className="font-semibold">Monto</h3>
        <p className="mt-0.5 text-xs text-text-3">{leadName}</p>

        <label className="mt-3 block text-xs font-medium" htmlFor="monto">
          Cuánto vale este trato ({currency})
        </label>
        <Input
          id="monto"
          value={texto}
          inputMode="decimal"
          autoFocus
          onChange={(e) => setTexto(e.target.value)}
          placeholder="12,500.00"
          className="mt-1"
        />
        {invalido ? (
          <p className="mt-1 text-xs text-danger-text">
            No reconozco ese número. Escríbelo como 12500 o 12,500.00
          </p>
        ) : (
          <p className="mt-1 text-xs text-text-3">
            {parsed === null
              ? "Déjalo vacío para quitar el monto."
              : `Se guardará como ${formatMoneyCents(parsed, currency)}`}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancelar
          </Button>
          <Button disabled={invalido} onClick={() => onSave(parsed)}>
            Guardar
          </Button>
        </div>
      </div>
    </div>
  );
}
