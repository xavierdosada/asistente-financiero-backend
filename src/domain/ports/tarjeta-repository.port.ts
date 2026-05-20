import type { EntryScope } from './entry-mode.port';

export const TYPE_CARD_VALUES = ['credito', 'debito', 'prepaga'] as const;
export type TypeCard = (typeof TYPE_CARD_VALUES)[number];

export type TarjetaRow = {
  id: string;
  name: string;
  bank: string;
  type_card: TypeCard;
  payment_card: string;
  credit_limit: number | null;
  closing_day?: number | null;
  due_day?: number | null;
};

export type TarjetaUsageSummary = {
  card_id: string;
  month_current: string;
  month_next: string;
  spent_current: number;
  spent_next: number;
  /** Gastos del mes calendario en USD (sin convertir a ARS). */
  spent_current_usd?: number;
  /** Gastos del mes siguiente en USD. */
  spent_next_usd?: number;
  /** Suma de `outstanding_amount` de resúmenes con `due_date` en el mes calendario actual (tarjeta crédito). */
  pending_month_debt: number;
  /** Suma de `outstanding_amount_usd` en esos mismos resúmenes. */
  pending_month_debt_usd?: number;
  /** Pagos de tarjeta sin imputar a ningún resumen (saldo a favor). */
  pending_month_credit: number;
  /** Saldo a favor en USD (pagos USD no asignados). */
  pending_month_credit_usd?: number;
  /** Consumo del ciclo abierto (1 pago + cuotas del período de cierre actual). */
  next_month_debt: number;
  /** Consumo del ciclo abierto en USD. */
  next_month_debt_usd?: number;
  credit_limit: number | null;
  available_current: number | null;
  available_next: number | null;
  /** Ventana del ciclo actual (opened_at..closed_at reales o por día de cierre). */
  current_cycle: { from: string; to: string };
  /** Ventana del ciclo siguiente. */
  next_cycle: { from: string; to: string };
};

export type TarjetaDebtInstallmentRow = {
  id: string;
  installment_number: number;
  due_date: string;
  amount: number;
  paid_amount: number;
  status: 'pendiente' | 'pagada' | 'vencida';
  paid_at: string | null;
};

export type TarjetaDebtRow = {
  id: string;
  card_id: string;
  description: string;
  currency: string;
  principal_amount: number;
  outstanding_amount: number;
  total_installments: number;
  installments_paid: number;
  installments_remaining: number;
  first_due_date: string;
  status: 'abierta' | 'pagada' | 'cancelada' | 'mora';
  installments: TarjetaDebtInstallmentRow[];
};

export type CardStatementRow = {
  id: string;
  card_id: string;
  period_year: number;
  period_month: number;
  opened_at: string;
  closed_at: string;
  due_date: string;
  total_amount: number;
  paid_amount: number;
  outstanding_amount: number;
  total_amount_usd: number;
  paid_amount_usd: number;
  outstanding_amount_usd: number;
  /** Deuda/saldo inicial del período (deuda-inicial); se suma al total al recalcular desde líneas. */
  opening_carry_amount: number;
  opening_carry_amount_usd: number;
  status: 'abierto' | 'cerrado' | 'pagado' | 'vencido';
};

export type CardPayableStatementRow = {
  id: string;
  card_id: string;
  period_year: number;
  period_month: number;
  due_date: string;
  minimum_payment: number;
  outstanding_amount: number;
  outstanding_amount_usd: number;
  status: CardStatementRow['status'];
};

export type CardStatementLineRow = {
  id: string;
  source_type: 'movement' | 'installment' | 'payment';
  movement_id: string | null;
  installment_id: string | null;
  payment_id?: string | null;
  detail: string;
  amount: number;
  currency: 'ARS' | 'USD';
  fx_ars_per_usd?: number | null;
  movement_date?: string | null;
  installment_number?: number;
  total_installments?: number;
};

export type CardStatementDetail = CardStatementRow & {
  lines: CardStatementLineRow[];
};

export type CardPendingInstallmentRow = {
  debt_id: string;
  debt_description: string;
  /** Total de cuotas del plan (para mostrar "cuota N de M"). */
  debt_total_installments: number;
  installment_id: string;
  installment_number: number;
  due_date: string;
  amount: number;
  /** Monto de la cuota mientras sigue fuera de un resumen ya cerrado (luego el adeudo pasa al resumen de la tarjeta). */
  remaining_amount: number;
  /** Solo calendario: vencimiento proyectado ya pasó (no implica imputación de pago a esta cuota). */
  due_overdue: boolean;
};

/** Respuesta de GET /tarjetas/:id/cuotas-pendientes */
export type CardPendingInstallmentsResult = {
  /** Máxima cantidad de cuotas pendientes por deuda; las deudas corren en paralelo. */
  pending_count: number;
  /** Suma de `remaining_amount` de la próxima cuota elegible por cada deuda (no acumula todas las cuotas futuras). */
  total_remaining_amount: number;
  installments: CardPendingInstallmentRow[];
};

export type CardSpendByMonth = {
  month: string;
  amount: number;
};

export type CardSpendRangeSummary = {
  card_id: string;
  from: string;
  to: string;
  scope: EntryScope;
  /** Gastos en ARS (sin convertir USD). */
  total_spent: number;
  /** Gastos en USD en el rango. */
  total_spent_usd?: number;
  movements_count: number;
  by_month: CardSpendByMonth[];
  /** Gastos USD por mes calendario (YYYY-MM). */
  by_month_usd?: CardSpendByMonth[];
};

export type CreditCardsTotalDebtSummary = {
  cards_count: number;
  debts_count: number;
  total_outstanding_amount: number;
};

export type SetInitialCardDebtInput = {
  year: number;
  month: number;
  outstanding_amount: number;
  due_date?: string;
};

export type StatementWindowInput = {
  opened_at?: string;
  closed_at?: string;
  due_date?: string;
};

export type StatementSyncReport = {
  added_movements: number;
  removed_movements: number;
  added_installments: number;
  removed_installments: number;
  previous_total: number;
  new_total: number;
};

export type UpdateStatementWindowResult = {
  statement: CardStatementDetail;
  sync: StatementSyncReport;
};

export type CreateTarjetaInput = {
  bank: string;
  type_card: TypeCard;
  payment_card: string;
  closing_day: number;
  due_day?: number | null;
  credit_limit?: number | null;
};

export type UpdateTarjetaInput = Partial<{
  bank: string;
  type_card: TypeCard;
  payment_card: string;
  closing_day: number;
  due_day: number | null;
  apply_due_day_to_current: boolean;
  credit_limit: number | null;
}>;

/** Columna `name`: etiqueta para listados y matching del chat. */
export function defaultCardName(
  paymentCard: string,
  bank: string,
  typeCard: TypeCard,
): string {
  return `${paymentCard.trim()} ${bank.trim()} (${typeCard})`;
}

export interface TarjetaRepositoryPort {
  list(): Promise<TarjetaRow[]>;
  findById(id: string): Promise<TarjetaRow | null>;
  create(input: CreateTarjetaInput): Promise<TarjetaRow>;
  update(id: string, input: UpdateTarjetaInput): Promise<TarjetaRow | null>;
  deleteById(id: string): Promise<void>;
  usageSummaryById(
    id: string,
    today?: Date,
    scope?: EntryScope,
  ): Promise<TarjetaUsageSummary | null>;
  listStatementsByCardId(id: string): Promise<CardStatementRow[] | null>;
  getStatementById(cardId: string, statementId: string): Promise<CardStatementDetail | null>;
  payableStatementByCardId(id: string): Promise<CardPayableStatementRow | null>;
  generateMonthlyStatement(
    cardId: string,
    year: number,
    month: number,
    windowOverride?: StatementWindowInput,
  ): Promise<CardStatementDetail | null>;
  updateStatementWindow(
    cardId: string,
    statementId: string,
    input: StatementWindowInput,
  ): Promise<UpdateStatementWindowResult | null>;
  spendByRange(
    cardId: string,
    from: string,
    to: string,
    scope?: EntryScope,
  ): Promise<CardSpendRangeSummary | null>;
  pendingInstallmentsByCardId(id: string): Promise<CardPendingInstallmentsResult | null>;
  setInitialDebt(cardId: string, input: SetInitialCardDebtInput): Promise<CardStatementRow | null>;
  debtsByCardId(id: string): Promise<TarjetaDebtRow[] | null>;
  totalDebtAllCreditCards(): Promise<CreditCardsTotalDebtSummary>;
}

export const TARJETA_REPOSITORY = Symbol('TARJETA_REPOSITORY');

export function isTypeCard(v: string): v is TypeCard {
  return (TYPE_CARD_VALUES as readonly string[]).includes(v);
}
