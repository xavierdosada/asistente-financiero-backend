import type { EntryMode } from '../ports/entry-mode.port';
export type MovimientoTipo = 'ingreso' | 'gasto';
export type MedioPago = 'efectivo' | 'tarjeta';

/**
 * Registro de ingreso o egreso derivado del mensaje del usuario.
 * Tabla: public.ingresos_egresos
 */
export class IngresoEgreso {
  constructor(
    public readonly currency: string,
    public readonly amount: number,
    public readonly type: MovimientoTipo,
    public readonly detail: string,
    /** FK public.categorias */
    public readonly categoriaId: string,
    public readonly medioPago: MedioPago,
    /** Solo si medioPago === 'tarjeta'; null si no hubo match en catálogo */
    public readonly tarjetaId: string | null,
    /** Si el gasto fue en cuotas, cantidad total de cuotas */
    public readonly installmentsTotal: number | null,
    /** Número de cuota asociada a este movimiento (alta inicial = 1) */
    public readonly installmentNumber: number | null,
    /** Si el movimiento es pago de préstamo, referencia a loans.id */
    public readonly loanId: string | null,
    /** Si el movimiento es pago de resumen de tarjeta, referencia a cards.id */
    public readonly settledCardId: string | null,
    /** Fecha del movimiento (solo día), formato YYYY-MM-DD */
    public readonly movementDate: string,
    /** Cuenta origen para impacto de caja (ej. accounts tipo efectivo) */
    public readonly sourceAccountId: string | null,
    /** Carril operativo/histórico para separar impacto transaccional vs analítico. */
    public readonly entryMode: EntryMode,
    public readonly rawMessage: string,
    /** ARS por 1 USD al registrar; obligatorio para gasto+tarjeta+USD. */
    public readonly fxArsPerUsd: number | null = null,
  ) {}
}
