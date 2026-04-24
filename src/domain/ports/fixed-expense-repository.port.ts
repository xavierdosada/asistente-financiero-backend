export type FixedExpenseRow = {
  id: string;
  name: string;
  aliases: string[];
  amount: number;
  currency: string;
  category_id: string;
  category_name: string;
  payment_method: 'efectivo' | 'tarjeta';
  card_id: string | null;
  due_day: number;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
};

export type FixedExpenseInstanceRow = {
  id: string;
  fixed_expense_id: string;
  fixed_expense_name: string;
  period_month: string;
  due_date: string;
  expected_amount: number;
  status: 'pendiente' | 'pagado' | 'omitido';
  movement_id: string | null;
  paid_at: string | null;
};

export type FixedExpenseMatch = {
  fixed_expense_id: string;
  name: string;
  amount: number;
  currency: string;
  category_id: string;
  payment_method: 'efectivo' | 'tarjeta';
  card_id: string | null;
};

export interface FixedExpenseRepositoryPort {
  list(): Promise<FixedExpenseRow[]>;
  findById(id: string): Promise<FixedExpenseRow | null>;
  create(input: {
    name: string;
    aliases: string[];
    amount: number;
    currency: string;
    category_id: string;
    payment_method: 'efectivo' | 'tarjeta';
    card_id: string | null;
    due_day: number;
  }): Promise<FixedExpenseRow>;
  update(
    id: string,
    patch: Partial<{
      name: string;
      aliases: string[];
      amount: number;
      currency: string;
      category_id: string;
      payment_method: 'efectivo' | 'tarjeta';
      card_id: string | null;
      due_day: number;
      is_active: boolean;
    }>,
  ): Promise<FixedExpenseRow | null>;
  generateInstancesForMonth(month: string): Promise<number>;
  listInstances(month: string): Promise<FixedExpenseInstanceRow[]>;
  findInstanceById(id: string): Promise<FixedExpenseInstanceRow | null>;
  markInstancePaid(instanceId: string, movementId: string): Promise<boolean>;
  findBestMatch(message: string): Promise<FixedExpenseMatch | null>;
}

export const FIXED_EXPENSE_REPOSITORY = Symbol('FIXED_EXPENSE_REPOSITORY');
