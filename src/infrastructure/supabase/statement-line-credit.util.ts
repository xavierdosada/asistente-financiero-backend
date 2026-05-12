/**
 * Créditos en resumen de tarjeta: deben restar del total y mostrarse con signo negativo
 * aunque el movimiento esté mal clasificado o el detalle no lleve prefijo "Reintegro".
 */

export function statementLineTreatsMovementAsCredit(params: {
  direction: string | null | undefined;
  detail: string | null | undefined;
  rawMessage: string | null | undefined;
}): boolean {
  const dir = String(params.direction ?? '').trim().toLowerCase();
  const detail = String(params.detail ?? '').trim();
  const raw = typeof params.rawMessage === 'string' ? params.rawMessage : '';

  if (dir === 'ingreso') return true;
  if (/^reintegro\b/i.test(detail)) return true;
  if (/^anulaci[oó]n\b/i.test(detail)) return true;
  if (/^devoluci[oó]n\b/i.test(detail)) return true;
  if (/^reembolso\b/i.test(detail)) return true;
  /** Resumen Visa/Banco Provincia: importe negativo en el PDF y monto positivo en DB como `gasto`. */
  if (dir === 'gasto' && /\bImporte\s+-\s*\$/i.test(raw)) return true;
  return false;
}

export type StatementLineMovementMeta = { direction: string; raw_message: string | null };

/**
 * Contribución firmada de una línea al total del resumen (ARS/USD).
 * - Cuotas (sin movement_id): se suma el monto tal cual (cargos).
 * - Créditos (ingreso tarjeta, detalle tipo reintegro/anulación, o comprobante con Importe -$): −|monto|.
 * - Gastos con monto negativo (ajustes ya negativos): se suma el negativo.
 */
export function signedStatementLineAmountForTotals(
  line: { amount: number | string; movement_id?: string | null; detail?: string | null },
  movementMetaById: Map<string, StatementLineMovementMeta>,
): number | null {
  const amt = Number(line.amount);
  if (!Number.isFinite(amt) || amt === 0) return null;
  const mid = line.movement_id;
  if (typeof mid !== 'string' || mid.trim().length === 0) {
    return amt;
  }
  const meta = movementMetaById.get(mid) ?? { direction: 'gasto', raw_message: null };
  if (
    statementLineTreatsMovementAsCredit({
      direction: meta.direction,
      detail: line.detail,
      rawMessage: meta.raw_message,
    })
  ) {
    return -Math.abs(amt);
  }
  return amt;
}
