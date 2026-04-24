import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  AccountRepositoryPort,
  AccountRow,
  MonthlyCashAdjustment,
  MonthlyCashHistory,
  MonthlyCashOpening,
  MonthlyCashSummary,
} from '../../domain/ports/account-repository.port';
import type { EntryScope } from '../../domain/ports/entry-mode.port';
import type { AuthenticatedRequest } from '../../auth/auth.types';
import { getAuthenticatedUserId } from '../../auth/request-user.util';

@Injectable({ scope: Scope.REQUEST })
export class SupabaseAccountRepository implements AccountRepositoryPort {
  private readonly client: SupabaseClient;
  private readonly userId: string;

  constructor(@Inject(REQUEST) request: AuthenticatedRequest) {
    const url = process.env.SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url || !key) {
      throw new Error(
        'Definí SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el entorno del servidor.',
      );
    }
    this.userId = getAuthenticatedUserId(request);
    this.client = createClient(url, key);
  }

  async getOrCreateCashAccount(currency: string = 'ARS'): Promise<AccountRow> {
    const ccy = normalizeCurrency(currency);
    const { data, error } = await this.client
      .from('accounts')
      .select('id, name, account_type, currency')
      .eq('user_id', this.userId)
      .eq('account_type', 'efectivo')
      .eq('currency', ccy)
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(1);

    if (error) throw new Error(error.message);
    const existing = data?.[0];
    if (existing) {
      return mapAccount(existing);
    }

    const { data: created, error: createError } = await this.client
      .from('accounts')
      .insert({
        user_id: this.userId,
        name: `Caja ${ccy}`,
        account_type: 'efectivo',
        currency: ccy,
      })
      .select('id, name, account_type, currency')
      .single();

    if (createError) throw new Error(createError.message);
    if (!created) throw new Error('No se pudo crear la cuenta de caja');
    return mapAccount(created);
  }

  async monthlyCashSummary(
    year: number,
    month: number,
    scope: EntryScope = 'operativo',
    currency: string = 'ARS',
  ): Promise<MonthlyCashSummary> {
    if (month < 1 || month > 12) {
      throw new Error('month debe estar entre 1 y 12');
    }

    const ccy = normalizeCurrency(currency);
    const cash = await this.getOrCreateCashAccount(ccy);
    const range = monthRange(year, month);
    const openingBalance = await this.getMonthlyOpeningBalance(cash.id, year, month);
    const adjustments = await this.getMonthlyAdjustments(cash.id, year, month);
    const adjustmentsTotal = round2(
      adjustments.reduce((acc, adjustment) => acc + adjustment.adjustment_amount, 0),
    );

    let query = this.client
      .from('movements')
      .select('direction, amount')
      .eq('user_id', this.userId)
      .eq('status', 'active')
      .eq('account_id', cash.id)
      .eq('currency', ccy)
      .gte('movement_date', range.from)
      .lte('movement_date', range.to);

    if (scope === 'operativo' || scope === 'historico') {
      query = query.eq('entry_mode', scope);
    }

    const { data, error } = await query;

    if (error) throw new Error(error.message);

    const ingresos = round2(
      (data ?? []).reduce((acc, row: { direction: string; amount: number | string }) => {
        if (row.direction !== 'ingreso') return acc;
        const n = Number(row.amount);
        return Number.isFinite(n) ? acc + n : acc;
      }, 0),
    );

    const gastos = round2(
      (data ?? []).reduce((acc, row: { direction: string; amount: number | string }) => {
        if (row.direction !== 'gasto') return acc;
        const n = Number(row.amount);
        return Number.isFinite(n) ? acc + n : acc;
      }, 0),
    );

    return {
      year,
      month,
      currency: ccy,
      account_id: cash.id,
      account_name: cash.name,
      opening_balance: openingBalance,
      ajustes: adjustmentsTotal,
      ingresos,
      gastos,
      neto_movimientos: round2(ingresos - gastos),
      saldo: round2(openingBalance + adjustmentsTotal + ingresos - gastos),
    };
  }

  async setMonthlyOpening(
    year: number,
    month: number,
    openingBalance: number,
    currency: string = 'ARS',
  ): Promise<MonthlyCashOpening> {
    if (month < 1 || month > 12) {
      throw new Error('month debe estar entre 1 y 12');
    }
    if (!Number.isFinite(openingBalance) || openingBalance < 0) {
      throw new Error('opening_balance debe ser un número >= 0');
    }

    const ccy = normalizeCurrency(currency);
    const cash = await this.getOrCreateCashAccount(ccy);

    const { data, error } = await this.client
      .from('cash_monthly_openings')
      .insert({
        user_id: this.userId,
        account_id: cash.id,
        period_year: year,
        period_month: month,
        opening_balance: round2(openingBalance),
        updated_at: new Date().toISOString(),
      })
      .select('period_year, period_month, opening_balance')
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new Error('La apertura mensual ya existe. Usá Ajuste de caja para corregir caja.');
      }
      throw new Error(error.message);
    }
    if (!data) throw new Error('No se pudo guardar la apertura mensual de caja');

    return {
      year: data.period_year,
      month: data.period_month,
      currency: ccy,
      account_id: cash.id,
      account_name: cash.name,
      opening_balance: Number(data.opening_balance),
    };
  }

  async adjustMonthlyOpening(
    year: number,
    month: number,
    newBalance: number,
    reason: string,
    currency: string = 'ARS',
  ): Promise<MonthlyCashAdjustment> {
    if (month < 1 || month > 12) {
      throw new Error('month debe estar entre 1 y 12');
    }
    if (!Number.isFinite(newBalance) || newBalance < 0) {
      throw new Error('new_balance debe ser un número >= 0');
    }

    const reasonValue = (reason ?? '').trim();
    if (!reasonValue) {
      throw new Error('reason es obligatorio para auditar el ajuste');
    }

    const ccy = normalizeCurrency(currency);
    const cash = await this.getOrCreateCashAccount(ccy);
    const history = await this.monthlyCashHistory(year, month, ccy);
    const previousBalance = history.current_opening_balance;
    const adjustmentAmount = round2(newBalance - previousBalance);

    const { data, error } = await this.client
      .from('cash_monthly_adjustments')
      .insert({
        user_id: this.userId,
        account_id: cash.id,
        period_year: year,
        period_month: month,
        previous_balance: previousBalance,
        new_balance: round2(newBalance),
        adjustment_amount: adjustmentAmount,
        reason: reasonValue,
      })
      .select(
        'id, period_year, period_month, previous_balance, new_balance, adjustment_amount, reason, created_at',
      )
      .single();

    if (error) throw new Error(error.message);
    if (!data) throw new Error('No se pudo registrar el ajuste mensual de caja');

    return {
      id: data.id,
      year: data.period_year,
      month: data.period_month,
      currency: ccy,
      account_id: cash.id,
      account_name: cash.name,
      previous_balance: round2(Number(data.previous_balance)),
      new_balance: round2(Number(data.new_balance)),
      adjustment_amount: round2(Number(data.adjustment_amount)),
      reason: data.reason,
      created_at: data.created_at,
    };
  }

  async monthlyCashHistory(
    year: number,
    month: number,
    currency: string = 'ARS',
  ): Promise<MonthlyCashHistory> {
    if (month < 1 || month > 12) {
      throw new Error('month debe estar entre 1 y 12');
    }

    const ccy = normalizeCurrency(currency);
    const cash = await this.getOrCreateCashAccount(ccy);
    const openingBalance = await this.getMonthlyOpeningBalance(cash.id, year, month);
    const adjustmentRows = await this.getMonthlyAdjustments(cash.id, year, month);
    const currentOpeningBalance = round2(
      openingBalance + adjustmentRows.reduce((acc, row) => acc + row.adjustment_amount, 0),
    );
    const adjustments: MonthlyCashAdjustment[] = adjustmentRows.map((row) => ({
      id: row.id,
      year: row.period_year,
      month: row.period_month,
      currency: ccy,
      account_id: cash.id,
      account_name: cash.name,
      previous_balance: row.previous_balance,
      new_balance: row.new_balance,
      adjustment_amount: row.adjustment_amount,
      reason: row.reason,
      created_at: row.created_at,
    }));

    return {
      year,
      month,
      currency: ccy,
      account_id: cash.id,
      account_name: cash.name,
      opening_balance: openingBalance,
      current_opening_balance: currentOpeningBalance,
      adjustments,
    };
  }

  private async getMonthlyOpeningBalance(
    accountId: string,
    year: number,
    month: number,
  ): Promise<number> {
    const { data, error } = await this.client
      .from('cash_monthly_openings')
      .select('opening_balance')
      .eq('user_id', this.userId)
      .eq('account_id', accountId)
      .eq('period_year', year)
      .eq('period_month', month)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) return 0;
    return round2(Number(data.opening_balance));
  }

  private async getMonthlyAdjustments(
    accountId: string,
    year: number,
    month: number,
  ): Promise<
    Array<{
      id: string;
      period_year: number;
      period_month: number;
      previous_balance: number;
      new_balance: number;
      adjustment_amount: number;
      reason: string;
      created_at: string;
    }>
  > {
    const { data, error } = await this.client
      .from('cash_monthly_adjustments')
      .select(
        'id, period_year, period_month, previous_balance, new_balance, adjustment_amount, reason, created_at',
      )
      .eq('user_id', this.userId)
      .eq('account_id', accountId)
      .eq('period_year', year)
      .eq('period_month', month)
      .order('created_at', { ascending: true });

    if (error) throw new Error(error.message);

    return (data ?? []).map((row) => ({
      id: row.id as string,
      period_year: row.period_year as number,
      period_month: row.period_month as number,
      previous_balance: round2(Number(row.previous_balance)),
      new_balance: round2(Number(row.new_balance)),
      adjustment_amount: round2(Number(row.adjustment_amount)),
      reason: row.reason as string,
      created_at: row.created_at as string,
    }));
  }
}

function mapAccount(row: {
  id: string;
  name: string;
  account_type: string;
  currency: string;
}): AccountRow {
  return {
    id: row.id,
    name: row.name,
    account_type: row.account_type as AccountRow['account_type'],
    currency: row.currency,
  };
}

function monthRange(year: number, month: number): { from: string; to: string } {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const last = new Date(Date.UTC(year, month, 0));
  return {
    from: toIsoDate(first),
    to: toIsoDate(last),
  };
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function normalizeCurrency(c: string): string {
  const value = (c || 'ARS').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(value)) {
    throw new Error('currency inválida: use código ISO de 3 letras');
  }
  if (value !== 'ARS' && value !== 'USD') {
    throw new Error('currency no soportada: use ARS o USD');
  }
  return value;
}
