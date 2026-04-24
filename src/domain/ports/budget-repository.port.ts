export type BudgetRow = {
  id: string;
  category_id: string;
  category_name: string;
  currency: string;
  amount: number;
  active_from: string;
  active_to: string | null;
  created_at?: string;
};

export type BudgetProgressRow = {
  category_id: string;
  category_name: string;
  currency: string;
  budget_amount: number;
  spent_amount: number;
  remaining_amount: number;
  used_percent: number;
};

/** Gasto real agregado por categoría en un rango de fechas (inclusive). */
export type BudgetRealSpendCategoryRow = {
  category_id: string | null;
  category_name: string;
  currency: string;
  total: number;
  avg_monthly: number;
  last_month_amount: number;
  /** (last_month - avg_monthly) / avg_monthly * 100 cuando avg_monthly > 0; si no, null */
  delta_vs_avg_percent: number | null;
};

export type BudgetRealSpendAnalytics = {
  from: string;
  to: string;
  months_in_range: number;
  categories: BudgetRealSpendCategoryRow[];
};

export interface BudgetRepositoryPort {
  listActive(month?: string): Promise<BudgetRow[]>;
  upsertMonthly(input: {
    category_id: string;
    currency: string;
    amount: number;
    month: string;
  }): Promise<BudgetRow>;
  closeActiveById(id: string): Promise<boolean>;
  getProgress(month: string): Promise<BudgetProgressRow[]>;
  getCategoryMonthlyProgress(input: {
    category_id: string;
    currency: string;
    month: string;
  }): Promise<BudgetProgressRow | null>;
  /** Rango inclusive; máximo 6 meses calendario (validación en controller o aquí). */
  getRealSpendAnalytics(from: string, to: string): Promise<BudgetRealSpendAnalytics>;
}

export const BUDGET_REPOSITORY = Symbol('BUDGET_REPOSITORY');
