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
  pending_month_debt: number;
  pending_month_credit: number;
  next_month_debt: number;
  credit_limit: number | null;
  available_current: number | null;
  available_next: number | null;
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
  status: 'abierto' | 'cerrado' | 'pagado' | 'vencido';
};

export type CardStatementLineRow = {
  id: string;
  source_type: 'movement' | 'installment';
  movement_id: string | null;
  installment_id: string | null;
  detail: string;
  amount: number;
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
  paid_amount: number;
  remaining_amount: number;
  status: 'pendiente' | 'pagada' | 'vencida';
};

/** Respuesta de GET /tarjetas/:id/cuotas-pendientes */
export type CardPendingInstallmentsResult = {
  /** Cantidad de cuotas con saldo pendiente (filas en la tabla). */
  pending_count: number;
  /** Suma de saldos restantes de esas cuotas. */
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
  total_spent: number;
  movements_count: number;
  by_month: CardSpendByMonth[];
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
  generateMonthlyStatement(cardId: string, year: number, month: number): Promise<CardStatementDetail | null>;
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
