import type { EntryScope } from './entry-mode.port';

export type AccountType = 'efectivo' | 'banco' | 'virtual';

export type AccountRow = {
  id: string;
  name: string;
  account_type: AccountType;
  currency: string;
};

export type MonthlyCashSummary = {
  year: number;
  month: number;
  currency: string;
  account_id: string;
  account_name: string;
  opening_balance: number;
  ajustes: number;
  ingresos: number;
  gastos: number;
  neto_movimientos: number;
  saldo: number;
};

export type MonthlyCashOpening = {
  year: number;
  month: number;
  currency: string;
  account_id: string;
  account_name: string;
  opening_balance: number;
};

export type MonthlyCashAdjustment = {
  id: string;
  year: number;
  month: number;
  currency: string;
  account_id: string;
  account_name: string;
  previous_balance: number;
  new_balance: number;
  adjustment_amount: number;
  reason: string;
  created_at: string;
};

export type MonthlyCashHistory = {
  year: number;
  month: number;
  currency: string;
  account_id: string;
  account_name: string;
  opening_balance: number;
  current_opening_balance: number;
  adjustments: MonthlyCashAdjustment[];
};

export interface AccountRepositoryPort {
  getOrCreateCashAccount(currency?: string): Promise<AccountRow>;
  setMonthlyOpening(
    year: number,
    month: number,
    openingBalance: number,
    currency?: string,
  ): Promise<MonthlyCashOpening>;
  adjustMonthlyOpening(
    year: number,
    month: number,
    newBalance: number,
    reason: string,
    currency?: string,
  ): Promise<MonthlyCashAdjustment>;
  monthlyCashHistory(
    year: number,
    month: number,
    currency?: string,
  ): Promise<MonthlyCashHistory>;
  monthlyCashSummary(
    year: number,
    month: number,
    scope?: EntryScope,
    currency?: string,
  ): Promise<MonthlyCashSummary>;
}

export const ACCOUNT_REPOSITORY = Symbol('ACCOUNT_REPOSITORY');
