import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  FixedExpenseInstanceRow,
  FixedExpenseMatch,
  FixedExpenseRepositoryPort,
  FixedExpenseRow,
} from '../../domain/ports/fixed-expense-repository.port';
import type { AuthenticatedRequest } from '../../auth/auth.types';
import { getAuthenticatedUserId } from '../../auth/request-user.util';

@Injectable({ scope: Scope.REQUEST })
export class SupabaseFixedExpenseRepository implements FixedExpenseRepositoryPort {
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

  async list(): Promise<FixedExpenseRow[]> {
    const { data, error } = await this.client
      .from('fixed_expenses')
      .select(
        'id, name, aliases, amount, currency, category_id, payment_method, card_id, due_day, start_month, accrual_day, is_active, created_at, updated_at',
      )
      .eq('user_id', this.userId)
      .order('name', { ascending: true });
    if (error) throw new Error(error.message);
    const categories = await this.fetchCategoryNames();
    return (data ?? []).map((row) => toFixedExpenseRow(row, categories));
  }

  async findById(id: string): Promise<FixedExpenseRow | null> {
    const { data, error } = await this.client
      .from('fixed_expenses')
      .select(
        'id, name, aliases, amount, currency, category_id, payment_method, card_id, due_day, start_month, accrual_day, is_active, created_at, updated_at',
      )
      .eq('id', id)
      .eq('user_id', this.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const categories = await this.fetchCategoryNames();
    return toFixedExpenseRow(data, categories);
  }

  async create(input: {
    name: string;
    aliases: string[];
    amount: number;
    currency: string;
    category_id: string;
    payment_method: 'efectivo' | 'tarjeta';
    card_id: string | null;
    due_day: number;
    start_month: string | null;
    accrual_day: number | null;
  }): Promise<FixedExpenseRow> {
    const payload = {
      user_id: this.userId,
      name: input.name.trim(),
      aliases: normalizeAliases(input.aliases),
      amount: input.amount,
      currency: input.currency.trim().toUpperCase(),
      category_id: input.category_id,
      payment_method: input.payment_method,
      card_id: input.payment_method === 'tarjeta' ? input.card_id : null,
      due_day: input.due_day,
      start_month: input.payment_method === 'tarjeta' ? input.start_month : null,
      accrual_day: input.payment_method === 'tarjeta' ? input.accrual_day : null,
    };
    const { data, error } = await this.client
      .from('fixed_expenses')
      .insert(payload)
      .select(
        'id, name, aliases, amount, currency, category_id, payment_method, card_id, due_day, start_month, accrual_day, is_active, created_at, updated_at',
      )
      .single();
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Supabase no devolvió fila');
    const categories = await this.fetchCategoryNames();
    return toFixedExpenseRow(data, categories);
  }

  async update(
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
      start_month: string | null;
      accrual_day: number | null;
      is_active: boolean;
    }>,
  ): Promise<FixedExpenseRow | null> {
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.name !== undefined) updates.name = patch.name.trim();
    if (patch.aliases !== undefined) updates.aliases = normalizeAliases(patch.aliases);
    if (patch.amount !== undefined) updates.amount = patch.amount;
    if (patch.currency !== undefined) updates.currency = patch.currency.trim().toUpperCase();
    if (patch.category_id !== undefined) updates.category_id = patch.category_id;
    if (patch.payment_method !== undefined) updates.payment_method = patch.payment_method;
    if (patch.card_id !== undefined) updates.card_id = patch.card_id;
    if (patch.due_day !== undefined) updates.due_day = patch.due_day;
    if (patch.start_month !== undefined) updates.start_month = patch.start_month;
    if (patch.accrual_day !== undefined) updates.accrual_day = patch.accrual_day;
    if (patch.is_active !== undefined) updates.is_active = patch.is_active;
    if (patch.payment_method === 'efectivo') {
      updates.card_id = null;
      updates.start_month = null;
      updates.accrual_day = null;
    }

    const { data, error } = await this.client
      .from('fixed_expenses')
      .update(updates)
      .eq('id', id)
      .eq('user_id', this.userId)
      .select(
        'id, name, aliases, amount, currency, category_id, payment_method, card_id, due_day, start_month, accrual_day, is_active, created_at, updated_at',
      )
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    await this.syncPendingInstancesFromDefinition(id, {
      amount: patch.amount,
      due_day: patch.due_day,
      payment_method: patch.payment_method,
      card_id: patch.card_id,
    });
    const categories = await this.fetchCategoryNames();
    return toFixedExpenseRow(data, categories);
  }

  async generateInstancesForMonth(month: string): Promise<number> {
    const monthStart = normalizeMonthStart(month);
    const { data: definitions, error: definitionsError } = await this.client
      .from('fixed_expenses')
      .select('id, amount, due_day, start_month, payment_method, card_id, cards(due_day)')
      .eq('user_id', this.userId)
      .eq('is_active', true);
    if (definitionsError) throw new Error(definitionsError.message);

    const { data: existingInstances, error: existingError } = await this.client
      .from('fixed_expense_instances')
      .select('fixed_expense_id')
      .eq('user_id', this.userId)
      .eq('period_month', monthStart);
    if (existingError) throw new Error(existingError.message);

    const existingIds = new Set((existingInstances ?? []).map((row) => String(row.fixed_expense_id)));
    const missingDefinitions = (definitions ?? []).filter((row) => {
      if (existingIds.has(String(row.id))) return false;
      const startMonth = normalizeOptionalMonthStart((row as { start_month?: string | null }).start_month);
      return !startMonth || startMonth <= monthStart;
    });
    if (!missingDefinitions.length) {
      await this.syncCardDueDatesForMonth(monthStart);
      return 0;
    }

    const payload = missingDefinitions.map((row) => {
      const dueDay = dueDayFromDefinition(row);
      return {
        user_id: this.userId,
        fixed_expense_id: String(row.id),
        period_month: monthStart,
        due_date: dueDateForMonth(monthStart, dueDay),
        expected_amount: Number(row.amount),
        status: 'pendiente',
      };
    });

    const { error: insertError } = await this.client.from('fixed_expense_instances').insert(payload);
    if (insertError) throw new Error(insertError.message);
    await this.syncCardDueDatesForMonth(monthStart);
    return payload.length;
  }

  async listInstances(month: string): Promise<FixedExpenseInstanceRow[]> {
    const monthStart = normalizeMonthStart(month);
    const { data, error } = await this.client
      .from('fixed_expense_instances')
      .select(
        'id, fixed_expense_id, period_month, due_date, expected_amount, status, movement_id, paid_at, fixed_expenses(name)',
      )
      .eq('user_id', this.userId)
      .eq('period_month', monthStart)
      .order('due_date', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map((row) => ({
      id: String(row.id),
      fixed_expense_id: String(row.fixed_expense_id),
      fixed_expense_name: String((row as { fixed_expenses?: { name?: string } }).fixed_expenses?.name ?? ''),
      period_month: String(row.period_month),
      due_date: String(row.due_date),
      expected_amount: Number(row.expected_amount),
      status: row.status as 'pendiente' | 'pagado' | 'omitido',
      movement_id: row.movement_id ? String(row.movement_id) : null,
      paid_at: row.paid_at ? String(row.paid_at) : null,
    }));
  }

  async findInstanceById(id: string): Promise<FixedExpenseInstanceRow | null> {
    const { data, error } = await this.client
      .from('fixed_expense_instances')
      .select(
        'id, fixed_expense_id, period_month, due_date, expected_amount, status, movement_id, paid_at, fixed_expenses(name)',
      )
      .eq('id', id)
      .eq('user_id', this.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return {
      id: String(data.id),
      fixed_expense_id: String(data.fixed_expense_id),
      fixed_expense_name: String((data as { fixed_expenses?: { name?: string } }).fixed_expenses?.name ?? ''),
      period_month: String(data.period_month),
      due_date: String(data.due_date),
      expected_amount: Number(data.expected_amount),
      status: data.status as 'pendiente' | 'pagado' | 'omitido',
      movement_id: data.movement_id ? String(data.movement_id) : null,
      paid_at: data.paid_at ? String(data.paid_at) : null,
    };
  }

  async markInstancePaid(instanceId: string, movementId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from('fixed_expense_instances')
      .update({
        status: 'pagado',
        movement_id: movementId,
        paid_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', instanceId)
      .eq('user_id', this.userId)
      .eq('status', 'pendiente')
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    return Boolean(data?.id);
  }

  async findBestMatch(message: string): Promise<FixedExpenseMatch | null> {
    const text = norm(message);
    if (!text) return null;
    const all = await this.list();
    const active = all.filter((f) => f.is_active);
    let best: { score: number; row: FixedExpenseRow } | null = null;
    for (const row of active) {
      let score = 0;
      const keys = [row.name, ...row.aliases].map(norm).filter(Boolean);
      for (const key of keys) {
        if (text === key) score = Math.max(score, 100);
        else if (text.includes(key)) score = Math.max(score, 20 + key.length);
      }
      if (!best || score > best.score) best = { score, row };
    }
    if (!best || best.score < 20) return null;
    return {
      fixed_expense_id: best.row.id,
      name: best.row.name,
      amount: best.row.amount,
      currency: best.row.currency,
      category_id: best.row.category_id,
      payment_method: best.row.payment_method,
      card_id: best.row.card_id,
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

  private async syncPendingInstancesFromDefinition(
    fixedExpenseId: string,
    patch: {
      amount?: number;
      due_day?: number;
      payment_method?: 'efectivo' | 'tarjeta';
      card_id?: string | null;
    },
  ): Promise<void> {
    const shouldSyncDueDate =
      patch.due_day !== undefined || patch.payment_method !== undefined || patch.card_id !== undefined;
    if (patch.amount === undefined && !shouldSyncDueDate) return;

    let resolvedDueDay: number | null = null;
    if (shouldSyncDueDate) {
      const definition = await this.loadFixedExpenseDueConfig(fixedExpenseId);
      if (!definition) return;
      resolvedDueDay = definition.payment_method === 'tarjeta' ? definition.card_due_day : definition.due_day;
    }

    const { data, error } = await this.client
      .from('fixed_expense_instances')
      .select('id, period_month, due_date, expected_amount, status')
      .eq('user_id', this.userId)
      .eq('fixed_expense_id', fixedExpenseId)
      .eq('status', 'pendiente');
    if (error) throw new Error(error.message);

    const instances = (data ?? []) as Array<{
      id: string;
      period_month: string;
      due_date: string;
      expected_amount: number | string;
      status: string;
    }>;

    for (const instance of instances) {
      const nextDueDate =
        resolvedDueDay !== null ? dueDateForMonth(instance.period_month, resolvedDueDay) : instance.due_date;
      const nextExpectedAmount =
        patch.amount !== undefined ? patch.amount : Number(instance.expected_amount);

      const { error: updateError } = await this.client
        .from('fixed_expense_instances')
        .update({
          due_date: nextDueDate,
          expected_amount: nextExpectedAmount,
          updated_at: new Date().toISOString(),
        })
        .eq('id', instance.id)
        .eq('user_id', this.userId);
      if (updateError) throw new Error(updateError.message);
    }
  }

  private async syncCardDueDatesForMonth(periodMonth: string): Promise<void> {
    const { data, error } = await this.client
      .from('fixed_expense_instances')
      .select('id, period_month, due_date, fixed_expenses(payment_method, due_day, card_id, cards(due_day))')
      .eq('user_id', this.userId)
      .eq('period_month', periodMonth)
      .eq('status', 'pendiente');
    if (error) throw new Error(error.message);

    const instances = (data ?? []) as Array<{
      id: string;
      period_month: string;
      due_date: string;
      fixed_expenses?: {
        payment_method?: string;
        due_day?: number;
        card_id?: string | null;
        cards?: { due_day?: number | null } | Array<{ due_day?: number | null }> | null;
      };
    }>;

    for (const instance of instances) {
      const definition = instance.fixed_expenses;
      if (!definition) continue;
      const dueDay = dueDayFromDefinition(definition as unknown as Record<string, unknown>);
      const nextDueDate = dueDateForMonth(instance.period_month, dueDay);
      if (nextDueDate === instance.due_date) continue;

      const { error: updateError } = await this.client
        .from('fixed_expense_instances')
        .update({
          due_date: nextDueDate,
          updated_at: new Date().toISOString(),
        })
        .eq('id', instance.id)
        .eq('user_id', this.userId);
      if (updateError) throw new Error(updateError.message);
    }
  }

  private async loadFixedExpenseDueConfig(fixedExpenseId: string): Promise<{
    payment_method: 'efectivo' | 'tarjeta';
    due_day: number;
    card_due_day: number;
  } | null> {
    const { data, error } = await this.client
      .from('fixed_expenses')
      .select('id, payment_method, due_day, card_id, cards(due_day)')
      .eq('id', fixedExpenseId)
      .eq('user_id', this.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;

    return {
      payment_method: String(data.payment_method) === 'tarjeta' ? 'tarjeta' : 'efectivo',
      due_day: safeDueDay(Number(data.due_day)),
      card_due_day: dueDayFromCardRelation(data.cards, Number(data.due_day)),
    };
  }
}

function normalizeMonthStart(value: string): string {
  const d = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new Error('Mes inválido');
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function normalizeAliases(aliases: string[]): string[] {
  return aliases
    .map((a) => a.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function toFixedExpenseRow(
  row: Record<string, unknown>,
  categories: Map<string, string>,
): FixedExpenseRow {
  const categoryId = String(row.category_id);
  return {
    id: String(row.id),
    name: String(row.name),
    aliases: Array.isArray(row.aliases) ? row.aliases.map((a) => String(a)) : [],
    amount: Number(row.amount),
    currency: String(row.currency),
    category_id: categoryId,
    category_name: categories.get(categoryId) ?? 'Sin categoría',
    payment_method: String(row.payment_method) === 'tarjeta' ? 'tarjeta' : 'efectivo',
    card_id: row.card_id ? String(row.card_id) : null,
    due_day: Number(row.due_day),
    start_month: row.start_month ? String(row.start_month) : null,
    accrual_day: row.accrual_day === null || row.accrual_day === undefined ? null : Number(row.accrual_day),
    is_active: Boolean(row.is_active),
    created_at: row.created_at ? String(row.created_at) : undefined,
    updated_at: row.updated_at ? String(row.updated_at) : undefined,
  };
}

function norm(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

function dueDateForMonth(periodMonth: string, dueDay: number): string {
  const base = new Date(`${periodMonth}T12:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return periodMonth;
  const year = base.getUTCFullYear();
  const monthIndex = base.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const safeDay = Math.min(Math.max(dueDay, 1), lastDay);
  return new Date(Date.UTC(year, monthIndex, safeDay)).toISOString().slice(0, 10);
}

function dueDayFromDefinition(row: Record<string, unknown>): number {
  const fallbackDueDay = safeDueDay(Number(row.due_day));
  const paymentMethod = String(row.payment_method) === 'tarjeta' ? 'tarjeta' : 'efectivo';
  if (paymentMethod !== 'tarjeta') return fallbackDueDay;
  return dueDayFromCardRelation(row.cards, fallbackDueDay);
}

function dueDayFromCardRelation(cardsValue: unknown, fallbackDueDay: number): number {
  if (Array.isArray(cardsValue)) {
    const first = cardsValue[0] as { due_day?: unknown } | undefined;
    const due = Number(first?.due_day);
    return Number.isFinite(due) ? safeDueDay(due) : fallbackDueDay;
  }
  if (cardsValue && typeof cardsValue === 'object') {
    const due = Number((cardsValue as { due_day?: unknown }).due_day);
    return Number.isFinite(due) ? safeDueDay(due) : fallbackDueDay;
  }
  return fallbackDueDay;
}

function safeDueDay(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const normalized = Math.trunc(value);
  return Math.min(Math.max(normalized, 1), 31);
}

function normalizeOptionalMonthStart(value: string | null | undefined): string | null {
  if (!value) return null;
  return normalizeMonthStart(value);
}
