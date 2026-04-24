import { Injectable } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  BudgetProgressRow,
  BudgetRealSpendAnalytics,
  BudgetRealSpendCategoryRow,
  BudgetRepositoryPort,
  BudgetRow,
} from '../../domain/ports/budget-repository.port';

@Injectable()
export class SupabaseBudgetRepository implements BudgetRepositoryPort {
  private readonly client: SupabaseClient;
  private readonly userId: string;

  constructor() {
    const url = process.env.SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url || !key) {
      throw new Error(
        'Definí SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el entorno del servidor.',
      );
    }
    this.userId = process.env.APP_USER_ID?.trim() ?? '';
    if (!this.userId) {
      throw new Error('Definí APP_USER_ID (uuid de auth.users) en el entorno del servidor.');
    }
    this.client = createClient(url, key);
  }

  async listActive(month?: string): Promise<BudgetRow[]> {
    const monthStart = normalizeMonthStart(month ?? todayIso());
    let query = this.client
      .from('budgets')
      .select('id, category_id, currency, amount, active_from, active_to, created_at')
      .eq('user_id', this.userId)
      .lte('active_from', monthStart)
      .or(`active_to.is.null,active_to.gte.${monthStart}`)
      .order('created_at', { ascending: false });
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const categories = await this.fetchCategoryNames();
    return (data ?? []).map((row) => ({
      id: row.id as string,
      category_id: row.category_id as string,
      category_name: categories.get(String(row.category_id)) ?? 'Sin categoría',
      currency: String(row.currency),
      amount: Number(row.amount),
      active_from: String(row.active_from),
      active_to: row.active_to ? String(row.active_to) : null,
      created_at: String(row.created_at),
    }));
  }

  async upsertMonthly(input: {
    category_id: string;
    currency: string;
    amount: number;
    month: string;
  }): Promise<BudgetRow> {
    const monthStart = normalizeMonthStart(input.month);
    const { error: closeError } = await this.client
      .from('budgets')
      .update({ active_to: monthStart })
      .eq('user_id', this.userId)
      .eq('category_id', input.category_id)
      .is('active_to', null);
    if (closeError) throw new Error(closeError.message);

    const { data, error } = await this.client
      .from('budgets')
      .insert({
        user_id: this.userId,
        category_id: input.category_id,
        currency: input.currency.trim().toUpperCase(),
        amount: input.amount,
        active_from: monthStart,
      })
      .select('id, category_id, currency, amount, active_from, active_to, created_at')
      .single();
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Supabase no devolvió fila');
    const categories = await this.fetchCategoryNames();
    return {
      id: String(data.id),
      category_id: String(data.category_id),
      category_name: categories.get(String(data.category_id)) ?? 'Sin categoría',
      currency: String(data.currency),
      amount: Number(data.amount),
      active_from: String(data.active_from),
      active_to: data.active_to ? String(data.active_to) : null,
      created_at: String(data.created_at),
    };
  }

  async closeActiveById(id: string): Promise<boolean> {
    const { data, error } = await this.client
      .from('budgets')
      .update({ active_to: todayIso() })
      .eq('id', id)
      .eq('user_id', this.userId)
      .is('active_to', null)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    return Boolean(data?.id);
  }

  async getProgress(month: string): Promise<BudgetProgressRow[]> {
    const monthStart = normalizeMonthStart(month);
    const monthEnd = nextMonthStart(monthStart);
    const budgets = await this.listActive(monthStart);
    if (!budgets.length) return [];
    const spends = await this.loadSpentByCategory(monthStart, monthEnd);
    return budgets.map((b) => {
      const spent = spends.get(`${b.category_id}|${b.currency}`) ?? 0;
      const remaining = b.amount - spent;
      const usedPercent = b.amount > 0 ? (spent / b.amount) * 100 : 0;
      return {
        category_id: b.category_id,
        category_name: b.category_name,
        currency: b.currency,
        budget_amount: round2(b.amount),
        spent_amount: round2(spent),
        remaining_amount: round2(remaining),
        used_percent: round2(usedPercent),
      };
    });
  }

  async getCategoryMonthlyProgress(input: {
    category_id: string;
    currency: string;
    month: string;
  }): Promise<BudgetProgressRow | null> {
    const all = await this.getProgress(input.month);
    return (
      all.find(
        (row) =>
          row.category_id === input.category_id &&
          row.currency.toUpperCase() === input.currency.toUpperCase(),
      ) ?? null
    );
  }

  async getRealSpendAnalytics(from: string, to: string): Promise<BudgetRealSpendAnalytics> {
    const fromNorm = normalizeRangeDate(from);
    const toNorm = normalizeRangeDate(to);
    if (!fromNorm || !toNorm || fromNorm > toNorm) {
      throw new Error('Rango de fechas inválido.');
    }
    const rangeStart = monthStartContaining(fromNorm);
    const rangeEnd = monthStartContaining(toNorm);
    const monthKeys = listMonthStartsInclusive(rangeStart, rangeEnd);
    if (monthKeys.length > 6) {
      throw new Error('El rango no puede superar 6 meses calendario.');
    }

    const { data, error } = await this.client
      .from('movements')
      .select('category_id, currency, amount, movement_date')
      .eq('user_id', this.userId)
      .eq('status', 'active')
      .eq('direction', 'gasto')
      .gte('movement_date', fromNorm)
      .lte('movement_date', toNorm);
    if (error) throw new Error(error.message);

    const categoryNames = await this.fetchCategoryNames();
    type Agg = {
      category_id: string | null;
      currency: string;
      total: number;
      byMonth: Map<string, number>;
    };
    const aggs = new Map<string, Agg>();

    for (const row of data ?? []) {
      const amount = Number(row.amount ?? 0);
      if (!Number.isFinite(amount)) continue;
      const currency = String(row.currency ?? 'ARS').toUpperCase();
      const cid = row.category_id != null ? String(row.category_id) : null;
      const key = `${cid ?? ''}|${currency}`;
      const md = String(row.movement_date).slice(0, 10);
      const monthKey = md.slice(0, 7);

      let a = aggs.get(key);
      if (!a) {
        a = { category_id: cid, currency, total: 0, byMonth: new Map() };
        aggs.set(key, a);
      }
      a.total += amount;
      a.byMonth.set(monthKey, (a.byMonth.get(monthKey) ?? 0) + amount);
    }

    const lastMonthKey = rangeEnd.slice(0, 7);
    const monthsInRange = monthKeys.length;

    const categories: BudgetRealSpendCategoryRow[] = [];
    for (const agg of aggs.values()) {
      const avgMonthly = monthsInRange > 0 ? agg.total / monthsInRange : 0;
      const lastMonthAmount = agg.byMonth.get(lastMonthKey) ?? 0;
      const deltaVsAvgPercent =
        avgMonthly > 0 ? round2(((lastMonthAmount - avgMonthly) / avgMonthly) * 100) : null;
      const categoryName =
        agg.category_id ? (categoryNames.get(agg.category_id) ?? 'Sin categoría') : 'Sin categoría';
      categories.push({
        category_id: agg.category_id,
        category_name: categoryName,
        currency: agg.currency,
        total: round2(agg.total),
        avg_monthly: round2(avgMonthly),
        last_month_amount: round2(lastMonthAmount),
        delta_vs_avg_percent: deltaVsAvgPercent,
      });
    }

    categories.sort((a, b) => b.total - a.total);

    return {
      from: fromNorm,
      to: toNorm,
      months_in_range: monthsInRange,
      categories,
    };
  }

  private async fetchCategoryNames(): Promise<Map<string, string>> {
    const { data, error } = await this.client
      .from('categories')
      .select('id, name')
      .eq('user_id', this.userId);
    if (error) throw new Error(error.message);
    return new Map((data ?? []).map((c) => [String(c.id), String(c.name)]));
  }

  private async loadSpentByCategory(
    monthStart: string,
    monthEndExclusive: string,
  ): Promise<Map<string, number>> {
    const { data, error } = await this.client
      .from('movements')
      .select('category_id, currency, amount')
      .eq('user_id', this.userId)
      .eq('status', 'active')
      .eq('direction', 'gasto')
      .gte('movement_date', monthStart)
      .lt('movement_date', monthEndExclusive);
    if (error) throw new Error(error.message);
    const acc = new Map<string, number>();
    for (const row of data ?? []) {
      const categoryId = row.category_id;
      if (!categoryId) continue;
      const currency = String(row.currency ?? 'ARS').toUpperCase();
      const key = `${String(categoryId)}|${currency}`;
      acc.set(key, (acc.get(key) ?? 0) + Number(row.amount ?? 0));
    }
    return acc;
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function normalizeMonthStart(value: string): string {
  const d = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new Error('Mes inválido');
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function nextMonthStart(monthStartIso: string): string {
  const d = new Date(`${monthStartIso}T12:00:00.000Z`);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const n = new Date(Date.UTC(y, m + 1, 1));
  return n.toISOString().slice(0, 10);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function normalizeRangeDate(value: string): string | null {
  const t = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const d = Date.parse(`${t}T12:00:00.000Z`);
  return Number.isNaN(d) ? null : t;
}

/** Primer día del mes calendario que contiene la fecha YYYY-MM-DD. */
function monthStartContaining(isoYmd: string): string {
  const d = new Date(`${isoYmd}T12:00:00.000Z`);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

/** Lista YYYY-MM-01 de cada mes desde rangeStart hasta rangeEnd inclusive (ambos primer día de mes). */
function listMonthStartsInclusive(rangeStart: string, rangeEnd: string): string[] {
  const out: string[] = [];
  let y = Number(rangeStart.slice(0, 4));
  let m = Number(rangeStart.slice(5, 7));
  const endY = Number(rangeEnd.slice(0, 4));
  const endM = Number(rangeEnd.slice(5, 7));
  for (;;) {
    const key = `${y}-${String(m).padStart(2, '0')}-01`;
    out.push(key);
    if (y === endY && m === endM) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}
