import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  CreditCardsTotalDebtSummary,
  CardPayableStatementRow,
  CardStatementDetail,
  CardStatementLineRow,
  CardStatementRow,
  CardPendingInstallmentRow,
  CardPendingInstallmentsResult,
  CardSpendRangeSummary,
  CreateTarjetaInput,
  SetInitialCardDebtInput,
  StatementSyncReport,
  StatementWindowInput,
  TarjetaDebtInstallmentRow,
  TarjetaDebtRow,
  TarjetaRepositoryPort,
  TarjetaRow,
  TarjetaUsageSummary,
  UpdateStatementWindowResult,
  UpdateTarjetaInput,
  defaultCardName,
  isTypeCard,
} from '../../domain/ports/tarjeta-repository.port';
import type { EntryScope } from '../../domain/ports/entry-mode.port';
import type { AuthenticatedRequest } from '../../auth/auth.types';
import { getAuthenticatedUserId } from '../../auth/request-user.util';
import {
  signedStatementLineAmountForTotals,
  statementLineTreatsMovementAsCredit,
  type StatementLineMovementMeta,
} from './statement-line-credit.util';

type MoneyBucket = { ars: number; usd: number };

function emptyBucket(): MoneyBucket {
  return { ars: 0, usd: 0 };
}

export function normalizeMovementCurrency(c: string | null | undefined): 'ARS' | 'USD' {
  const u = String(c ?? 'ARS').trim().toUpperCase();
  return u === 'USD' ? 'USD' : 'ARS';
}

/** Campos de `card_statements` para lectura consistente (ARS + USD). */
const CARD_STATEMENT_SELECT_FIELDS =
  'id, card_id, period_year, period_month, opened_at, closed_at, due_date, total_amount, total_amount_usd, paid_amount, paid_amount_usd, outstanding_amount, outstanding_amount_usd, opening_carry_amount, opening_carry_amount_usd, status';

export function movementLinePayload(row: {
  amount: number | string;
  currency?: string | null;
  fx_ars_per_usd?: number | string | null;
}): { amount: number; currency: 'ARS' | 'USD'; fx_ars_per_usd: number | null } {
  const n = Number(row.amount);
  const currency = normalizeMovementCurrency(row.currency);
  const fxRaw = row.fx_ars_per_usd;
  const fxNum = fxRaw === null || fxRaw === undefined || fxRaw === '' ? NaN : Number(fxRaw);
  return {
    amount: Number.isFinite(n) ? n : 0,
    currency,
    fx_ars_per_usd: Number.isFinite(fxNum) ? fxNum : null,
  };
}

@Injectable({ scope: Scope.REQUEST })
export class SupabaseTarjetaRepository implements TarjetaRepositoryPort {
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

  async list(): Promise<TarjetaRow[]> {
    const { data, error } = await this.client
      .from('cards')
      .select('id, name, bank, card_type, network, credit_limit, closing_day, due_day')
      .eq('user_id', this.userId)
      .order('bank', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map(mapCardRow);
  }

  async findById(id: string): Promise<TarjetaRow | null> {
    const { data, error } = await this.client
      .from('cards')
      .select('id, name, bank, card_type, network, credit_limit, closing_day, due_day')
      .eq('id', id)
      .eq('user_id', this.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? mapCardRow(data) : null;
  }

  async create(input: CreateTarjetaInput): Promise<TarjetaRow> {
    const bank = input.bank.trim();
    const payment_card = input.payment_card.trim();
    if (!bank) throw new Error('bank cannot be empty');
    if (!payment_card) throw new Error('payment_card cannot be empty');
    if (!isTypeCard(input.type_card)) {
      throw new Error('type_card must be credito, debito or prepaga');
    }
    if (!Number.isInteger(input.closing_day) || input.closing_day < 1 || input.closing_day > 31) {
      throw new Error('closing_day must be an integer between 1 and 31');
    }
    const dueDay = normalizeDueDay(input.due_day, 10);
    const creditLimit =
      input.credit_limit === undefined ? null : normalizePositiveNumber(input.credit_limit);
    const name = defaultCardName(payment_card, bank, input.type_card);
    const { data, error } = await this.client
      .from('cards')
      .insert({
        user_id: this.userId,
        name,
        bank,
        card_type: input.type_card,
        network: payment_card,
        closing_day: input.closing_day,
        due_day: dueDay,
        credit_limit: creditLimit,
      })
      .select('id, name, bank, card_type, network, credit_limit, closing_day, due_day')
      .single();
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Supabase returned no row');
    return mapCardRow(data);
  }

  async update(id: string, input: UpdateTarjetaInput): Promise<TarjetaRow | null> {
    const current = await this.findById(id);
    if (!current) return null;

    const bank = input.bank !== undefined ? input.bank.trim() : current.bank;
    const payment_card =
      input.payment_card !== undefined ? input.payment_card.trim() : current.payment_card;
    const type_card =
      input.type_card !== undefined ? input.type_card : current.type_card;
    const closing_day =
      input.closing_day !== undefined ? input.closing_day : current.closing_day ?? null;
    const closingDayChanged =
      input.closing_day !== undefined && current.closing_day !== null && input.closing_day !== current.closing_day;
    const due_day = normalizeDueDay(input.due_day, current.due_day ?? 10);

    if (!bank) throw new Error('bank cannot be empty');
    if (!payment_card) throw new Error('payment_card cannot be empty');
    if (!isTypeCard(type_card)) {
      throw new Error('type_card must be credito, debito or prepaga');
    }
    if (
      closing_day !== null &&
      (!Number.isInteger(closing_day) || closing_day < 1 || closing_day > 31)
    ) {
      throw new Error('closing_day must be an integer between 1 and 31');
    }

    const credit_limit =
      input.credit_limit === undefined ? current.credit_limit : normalizePositiveNumber(input.credit_limit);

    const name = defaultCardName(payment_card, bank, type_card);

    const { data, error } = await this.client
      .from('cards')
      .update({
        name,
        bank,
        card_type: type_card,
        network: payment_card,
        closing_day,
        due_day,
        credit_limit,
      })
      .eq('id', id)
      .eq('user_id', this.userId)
      .select('id, name, bank, card_type, network, credit_limit, closing_day, due_day')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (
      input.apply_due_day_to_current === true &&
      input.due_day !== undefined &&
      typeof due_day === 'number'
    ) {
      await this.applyDueDayToCurrentStatement(id, due_day);
    }
    if (closingDayChanged && typeof closing_day === 'number') {
      await this.reconcileStatementWindowsForClosingDayChange(id, closing_day);
    }
    return data ? mapCardRow(data) : null;
  }

  async deleteById(id: string): Promise<void> {
    const { error } = await this.client
      .from('cards')
      .delete()
      .eq('id', id)
      .eq('user_id', this.userId);
    if (error) throw new Error(error.message);
  }

  async usageSummaryById(
    id: string,
    today: Date = new Date(),
    scope: EntryScope = 'operativo',
  ): Promise<TarjetaUsageSummary | null> {
    const card = await this.findById(id);
    if (!card) {
      return null;
    }

    const current = monthRange(today, 0);
    const next = monthRange(today, 1);

    if (card.type_card !== 'credito') {
      const [spentCurrent, spentNext, cycleWindows] = await Promise.all([
        this.sumCardSpendByPeriodBuckets(id, current.from, current.to, scope),
        this.sumCardSpendByPeriodBuckets(id, next.from, next.to, scope),
        this.resolveCycleWindows(card, today),
      ]);
      const creditLimit = card.credit_limit;
      return {
        card_id: card.id,
        month_current: current.label,
        month_next: next.label,
        spent_current: spentCurrent.ars,
        spent_next: spentNext.ars,
        spent_current_usd: spentCurrent.usd,
        spent_next_usd: spentNext.usd,
        pending_month_debt: 0,
        pending_month_credit: 0,
        next_month_debt: 0,
        credit_limit: creditLimit,
        available_current: creditLimit === null ? null : round2(creditLimit - spentCurrent.ars),
        available_next: creditLimit === null ? null : round2(creditLimit - spentNext.ars),
        current_cycle: cycleWindows.current,
        next_cycle: cycleWindows.next,
      };
    }

    await this.ensureDueStatementsForCalendarMonth(id, card, current.from, current.to, today);

    const [spentCurrent, spentNext, cycleWindows, pendingBucket, unallocatedBucket] =
      await Promise.all([
        this.sumCardSpendByPeriodBuckets(id, current.from, current.to, scope),
        this.sumCardSpendByPeriodBuckets(id, next.from, next.to, scope),
        this.resolveCycleWindows(card, today),
        this.sumOutstandingStatementsDueBuckets(id, current.to),
        this.sumUnallocatedCreditsByCurrency(id),
      ]);

    const closingIso = cycleWindows.current.to;
    const billingYear = Number(closingIso.slice(0, 4));
    const billingMonth = Number(closingIso.slice(5, 7));
    const [currentCycleSinglePay, currentCycleInstallments, pendingSnap] = await Promise.all([
      this.sumCardSinglePaySpendByPeriodBuckets(id, cycleWindows.current.from, cycleWindows.current.to, scope),
      this.sumCardInstallmentsForBillingPeriodBuckets(id, billingYear, billingMonth, scope, card),
      this.pendingInstallmentsByCardId(id),
    ]);
    const countedInstallmentIds =
      currentCycleInstallments.countedInstallmentIds ?? new Set<string>();
    const nextPerDebt = pickNextPendingInstallmentPerDebt(pendingSnap?.installments ?? []);
    let pendingExtraArs = 0;
    let pendingExtraUsd = 0;
    for (const row of nextPerDebt) {
      if (countedInstallmentIds.has(row.installment_id)) continue;
      const n = row.remaining_amount;
      if (!Number.isFinite(n) || n <= 0) continue;
      pendingExtraArs += n;
    }
    const nextMonthDebt = round2(
      currentCycleSinglePay.ars + currentCycleInstallments.ars + pendingExtraArs,
    );
    const nextMonthDebtUsd = round2(
      currentCycleSinglePay.usd + currentCycleInstallments.usd + pendingExtraUsd,
    );

    const creditLimit = card.credit_limit;
    return {
      card_id: card.id,
      month_current: current.label,
      month_next: next.label,
      spent_current: spentCurrent.ars,
      spent_next: spentNext.ars,
      spent_current_usd: spentCurrent.usd,
      spent_next_usd: spentNext.usd,
      pending_month_debt: pendingBucket.ars,
      pending_month_debt_usd: pendingBucket.usd,
      pending_month_credit: unallocatedBucket.ars,
      pending_month_credit_usd: unallocatedBucket.usd,
      next_month_debt: nextMonthDebt,
      next_month_debt_usd: nextMonthDebtUsd,
      credit_limit: creditLimit,
      available_current: creditLimit === null ? null : round2(creditLimit - spentCurrent.ars),
      available_next: creditLimit === null ? null : round2(creditLimit - spentNext.ars),
      current_cycle: cycleWindows.current,
      next_cycle: cycleWindows.next,
    };
  }

  private async ensureDueStatementsForCalendarMonth(
    cardId: string,
    card: TarjetaRow,
    dueFrom: string,
    dueTo: string,
    today: Date,
  ): Promise<void> {
    const cy = today.getUTCFullYear();
    const cm = today.getUTCMonth() + 1;
    const keys = collectPeriodKeysWithDueInCalendarMonth(card, dueFrom, dueTo, cy, cm);
    for (const { year, month } of keys) {
      const { data: existing, error } = await this.client
        .from('card_statements')
        .select('id')
        .eq('user_id', this.userId)
        .eq('card_id', cardId)
        .eq('period_year', year)
        .eq('period_month', month)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (existing) continue;
      await this.generateMonthlyStatement(cardId, year, month);
    }
  }

  private async sumOutstandingStatementsDueBuckets(
    cardId: string,
    toDue: string,
  ): Promise<MoneyBucket> {
    const { data, error } = await this.client
      .from('card_statements')
      .select('outstanding_amount, outstanding_amount_usd')
      .eq('user_id', this.userId)
      .eq('card_id', cardId)
      .lte('due_date', toDue);
    if (error) throw new Error(error.message);
    let ars = 0;
    let usd = 0;
    for (const row of data ?? []) {
      const r = row as { outstanding_amount: number | string; outstanding_amount_usd?: number | string };
      const a = Number(r.outstanding_amount);
      const u = Number(r.outstanding_amount_usd ?? 0);
      if (Number.isFinite(a)) ars += Math.max(a, 0);
      if (Number.isFinite(u)) usd += Math.max(u, 0);
    }
    return { ars: round2(ars), usd: round2(usd) };
  }

  private async sumUnallocatedCreditsByCurrency(cardId: string): Promise<MoneyBucket> {
    const { data: payments, error: pErr } = await this.client
      .from('card_statement_payments')
      .select('id, amount, currency')
      .eq('user_id', this.userId)
      .eq('card_id', cardId);
    if (pErr) throw new Error(pErr.message);
    const ids = (payments ?? []).map((p: { id: string }) => p.id);
    if (ids.length === 0) return emptyBucket();

    const { data: allocs, error: aErr } = await this.client
      .from('card_statement_payment_allocations')
      .select('payment_id, applied_amount')
      .in('payment_id', ids);
    if (aErr) throw new Error(aErr.message);

    const allocatedByPayment = new Map<string, number>();
    for (const row of allocs ?? []) {
      const r = row as { payment_id: string; applied_amount: number | string };
      const amt = Number(r.applied_amount);
      if (!Number.isFinite(amt)) continue;
      allocatedByPayment.set(r.payment_id, (allocatedByPayment.get(r.payment_id) ?? 0) + amt);
    }

    let ars = 0;
    let usd = 0;
    for (const p of payments ?? []) {
      const row = p as { id: string; amount: number | string; currency?: string | null };
      const paid = Number(row.amount);
      const allocated = round2(allocatedByPayment.get(row.id) ?? 0);
      if (!Number.isFinite(paid)) continue;
      const rem = Math.max(round2(paid - allocated), 0);
      if (rem <= 0) continue;
      if (normalizeMovementCurrency(row.currency) === 'USD') usd += rem;
      else ars += rem;
    }
    return { ars: round2(ars), usd: round2(usd) };
  }

  private async applyUnallocatedForOneCurrency(
    cardId: string,
    statementId: string,
    currency: 'ARS' | 'USD',
    totalForCurrency: number,
  ): Promise<void> {
    const { data: existingAllocs, error: e0 } = await this.client
      .from('card_statement_payment_allocations')
      .select('applied_amount, currency')
      .eq('statement_id', statementId);
    if (e0) throw new Error(e0.message);
    let paidSoFar = round2(
      (existingAllocs ?? []).reduce((acc, r: { applied_amount: number | string; currency?: string | null }) => {
        if (normalizeMovementCurrency(r.currency) !== currency) return acc;
        const n = Number(r.applied_amount);
        return Number.isFinite(n) ? acc + n : acc;
      }, 0),
    );
    let outstanding = round2(Math.max(totalForCurrency - paidSoFar, 0));
    if (outstanding <= 0) return;

    const { data: payments, error } = await this.client
      .from('card_statement_payments')
      .select('id, amount, payment_date, created_at, currency')
      .eq('user_id', this.userId)
      .eq('card_id', cardId)
      .eq('currency', currency)
      .order('payment_date', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);

    const paymentIds = (payments ?? []).map((p: { id: string }) => p.id);
    if (paymentIds.length === 0) return;

    const { data: allAllocs, error: e2 } = await this.client
      .from('card_statement_payment_allocations')
      .select('payment_id, applied_amount')
      .in('payment_id', paymentIds);
    if (e2) throw new Error(e2.message);

    const allocatedByPayment = new Map<string, number>();
    for (const row of allAllocs ?? []) {
      const r = row as { payment_id: string; applied_amount: number | string };
      const amt = Number(r.applied_amount);
      if (!Number.isFinite(amt)) continue;
      allocatedByPayment.set(r.payment_id, (allocatedByPayment.get(r.payment_id) ?? 0) + amt);
    }

    for (const p of payments ?? []) {
      if (outstanding <= 0) break;
      const row = p as { id: string; amount: number | string };
      const paymentAmount = Number(row.amount);
      const allocated = round2(allocatedByPayment.get(row.id) ?? 0);
      if (!Number.isFinite(paymentAmount)) continue;
      const remainder = round2(Math.max(paymentAmount - allocated, 0));
      if (remainder <= 0) continue;
      const applyAmt = round2(Math.min(remainder, outstanding));
      if (applyAmt <= 0) continue;

      const { error: insErr } = await this.client.from('card_statement_payment_allocations').insert({
        payment_id: row.id,
        statement_id: statementId,
        applied_amount: applyAmt,
        currency,
      });
      if (insErr) throw new Error(insErr.message);

      allocatedByPayment.set(row.id, round2((allocatedByPayment.get(row.id) ?? 0) + applyAmt));
      paidSoFar = round2(paidSoFar + applyAmt);
      outstanding = round2(Math.max(totalForCurrency - paidSoFar, 0));
    }
  }

  private async applyUnallocatedCreditToStatement(
    cardId: string,
    statementId: string,
    totalArs: number,
    totalUsd: number,
  ): Promise<void> {
    await this.applyUnallocatedForOneCurrency(cardId, statementId, 'ARS', totalArs);
    await this.applyUnallocatedForOneCurrency(cardId, statementId, 'USD', totalUsd);
  }

  private async getStatementOpeningCarryBuckets(statementId: string): Promise<{ ars: number; usd: number }> {
    const { data, error } = await this.client
      .from('card_statements')
      .select('opening_carry_amount, opening_carry_amount_usd')
      .eq('id', statementId)
      .eq('user_id', this.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const row = data as { opening_carry_amount?: unknown; opening_carry_amount_usd?: unknown } | null;
    const ars = Number(row?.opening_carry_amount ?? 0);
    const usd = Number(row?.opening_carry_amount_usd ?? 0);
    const out = {
      ars: round2(Number.isFinite(ars) ? ars : 0),
      usd: round2(Number.isFinite(usd) ? usd : 0),
    };
    return out;
  }

  private async syncStatementTotalsFromLinesAndAllocations(
    statementId: string,
    statusWhenOutstanding: 'cerrado' | 'vencido' | 'abierto' = 'cerrado',
  ): Promise<void> {
    const { data: lines, error: le } = await this.client
      .from('card_statement_lines')
      .select('amount, currency, movement_id, detail')
      .eq('statement_id', statementId);
    if (le) throw new Error(le.message);

    const movementIds = Array.from(
      new Set(
        (lines ?? [])
          .map((r: { movement_id?: string | null }) => r.movement_id ?? null)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    );
    const movementMetaById = new Map<string, StatementLineMovementMeta>();
    if (movementIds.length > 0) {
      const { data: movementRows, error: movementErr } = await this.client
        .from('movements')
        .select('id, direction, raw_message')
        .eq('user_id', this.userId)
        .in('id', movementIds);
      if (movementErr) throw new Error(movementErr.message);
      for (const row of (movementRows ?? []) as Array<{
        id: string;
        direction?: string | null;
        raw_message?: string | null;
      }>) {
        movementMetaById.set(row.id, {
          direction: String(row.direction ?? 'gasto'),
          raw_message: typeof row.raw_message === 'string' ? row.raw_message : null,
        });
      }
    }

    let totalArs = 0;
    let totalUsd = 0;
    for (const row of lines ?? []) {
      const r = row as {
        amount: number | string;
        currency?: string | null;
        movement_id?: string | null;
        detail?: string | null;
      };
      const signedAmt = signedStatementLineAmountForTotals(r, movementMetaById);
      if (signedAmt === null) continue;
      if (normalizeMovementCurrency(r.currency) === 'USD') totalUsd += signedAmt;
      else totalArs += signedAmt;
    }
    totalArs = round2(totalArs);
    totalUsd = round2(totalUsd);
    const carryBuckets = await this.getStatementOpeningCarryBuckets(statementId);
    totalArs = round2(totalArs + carryBuckets.ars);
    totalUsd = round2(totalUsd + carryBuckets.usd);

    const { data: allocs, error: ae } = await this.client
      .from('card_statement_payment_allocations')
      .select('applied_amount, currency')
      .eq('statement_id', statementId);
    if (ae) throw new Error(ae.message);

    let paidArs = 0;
    let paidUsd = 0;
    for (const row of allocs ?? []) {
      const r = row as { applied_amount: number | string; currency?: string | null };
      const amt = Number(r.applied_amount);
      if (!Number.isFinite(amt)) continue;
      if (normalizeMovementCurrency(r.currency) === 'USD') paidUsd += amt;
      else paidArs += amt;
    }
    paidArs = round2(paidArs);
    paidUsd = round2(paidUsd);

    const outstandingArs = round2(Math.max(totalArs - paidArs, 0));
    const outstandingUsd = round2(Math.max(totalUsd - paidUsd, 0));
    const fullyPaid = outstandingArs <= 0 && outstandingUsd <= 0;
    const status =
      fullyPaid ? 'pagado'
      : statusWhenOutstanding === 'vencido' ? 'vencido'
      : statusWhenOutstanding === 'abierto' ? 'abierto'
      : 'cerrado';

    const { error: upErr } = await this.client
      .from('card_statements')
      .update({
        total_amount: totalArs,
        total_amount_usd: totalUsd,
        paid_amount: paidArs,
        paid_amount_usd: paidUsd,
        outstanding_amount: outstandingArs,
        outstanding_amount_usd: outstandingUsd,
        status,
      })
      .eq('id', statementId)
      .eq('user_id', this.userId);
    if (upErr) throw new Error(upErr.message);
  }

  async generateMonthlyStatement(
    cardId: string,
    year: number,
    month: number,
    windowOverride?: StatementWindowInput,
  ): Promise<CardStatementDetail | null> {
    const card = await this.findById(cardId);
    if (!card) return null;
    if (month < 1 || month > 12) throw new Error('month debe estar entre 1 y 12');

    const period = resolveStatementPeriodForGenerate(card, year, month, windowOverride);

    let statement = await this.findOrCreateStatement(
      cardId,
      year,
      month,
      period.from,
      period.to,
      period.due,
    );

    const { data: movements, error: movementsError } = await this.client
      .from('movements')
      .select('id, detail, amount, currency, fx_ars_per_usd, installments_total, direction, movement_date, entry_mode')
      .eq('user_id', this.userId)
      .eq('status', 'active')
      .eq('card_id', cardId)
      .eq('payment_method', 'tarjeta')
      .eq('entry_mode', 'operativo')
      .or('direction.eq.gasto,and(direction.eq.ingreso,settled_card_id.is.null)')
      .or('installments_total.is.null,installments_total.lte.1')
      .gte('movement_date', period.from)
      .lte('movement_date', period.to);
    if (movementsError) throw new Error(movementsError.message);
    const movementRows = (movements ?? []) as Array<{
      id: string;
      detail: string | null;
      movement_date?: string | null;
      entry_mode?: string | null;
      installments_total?: number | null;
      direction?: string | null;
    }>;

    for (const movement of movementRows as Array<{
      id: string;
      detail: string;
      amount: number | string;
      currency?: string | null;
      fx_ars_per_usd?: number | string | null;
      movement_date?: string | null;
      direction?: string | null;
    }>) {
      const { data: existingLine, error: existingLineError } = await this.client
        .from('card_statement_lines')
        .select('id, statement_id')
        .eq('movement_id', movement.id)
        .maybeSingle();
      if (existingLineError) throw new Error(existingLineError.message);
      if (existingLine) continue;

      const linePayload = movementLinePayload(movement);
      const { error: lineError } = await this.client.from('card_statement_lines').insert({
        statement_id: statement.id,
        source_type: 'movement',
        movement_id: movement.id,
        installment_id: null,
        detail: movement.detail || 'Consumo tarjeta',
        amount: linePayload.amount,
        currency: linePayload.currency,
        fx_ars_per_usd: linePayload.fx_ars_per_usd,
      });
      if (lineError) throw new Error(lineError.message);
    }

    const installmentSelect =
      'id, debt_id, installment_number, amount, due_date, statement_id, billing_period_year, billing_period_month, card_installment_debts!inner(description, card_id, user_id, currency)';

    const { data: installmentsByDue, error: instDueErr } = await this.client
      .from('card_debt_installments')
      .select(installmentSelect)
      .is('statement_id', null)
      .neq('status', 'pagada')
      .gte('due_date', period.from)
      .lte('due_date', period.to);
    if (instDueErr) throw new Error(instDueErr.message);

    const { data: installmentsByBilling, error: instBillErr } = await this.client
      .from('card_debt_installments')
      .select(installmentSelect)
      .is('statement_id', null)
      .neq('status', 'pagada')
      .eq('billing_period_year', year)
      .eq('billing_period_month', month);
    if (instBillErr) throw new Error(instBillErr.message);

    const bridgeDueUpper = addMonthsIso(period.due, 1);
    const { data: installmentsBridge, error: instBridgeErr } = await this.client
      .from('card_debt_installments')
      .select(installmentSelect)
      .is('statement_id', null)
      .neq('status', 'pagada')
      .gt('due_date', period.to)
      .lte('due_date', bridgeDueUpper);
    if (instBridgeErr) throw new Error(instBridgeErr.message);

    const installmentById = new Map<
      string,
      {
        id: string;
        debt_id: string;
        installment_number: number;
        amount: number | string;
        due_date: string;
        statement_id: string | null;
        card_installment_debts:
          | { description: string; card_id: string; user_id: string; currency?: string | null }
          | Array<{ description: string; card_id: string; user_id: string; currency?: string | null }>;
      }
    >();
    for (const row of [
      ...(installmentsByDue ?? []),
      ...(installmentsByBilling ?? []),
      ...(installmentsBridge ?? []),
    ]) {
      const r = row as {
        id: string;
        debt_id: string;
        installment_number: number;
        amount: number | string;
        due_date: string;
        statement_id: string | null;
        card_installment_debts:
          | { description: string; card_id: string; user_id: string; currency?: string | null }
          | Array<{ description: string; card_id: string; user_id: string; currency?: string | null }>;
      };
      installmentById.set(r.id, r);
    }
    const installments = [...installmentById.values()];

    for (const installment of installments as Array<{
      id: string;
      debt_id: string;
      installment_number: number;
      amount: number | string;
      due_date: string;
      statement_id: string | null;
      card_installment_debts:
        | { description: string; card_id: string; user_id: string; currency?: string | null }
        | Array<{ description: string; card_id: string; user_id: string; currency?: string | null }>;
    }>) {
      const debtRef =
        Array.isArray(installment.card_installment_debts) ?
          installment.card_installment_debts[0]
        : installment.card_installment_debts;
      if (!debtRef) continue;
      if (debtRef.user_id !== this.userId) continue;
      if (debtRef.card_id !== cardId) continue;

      const { data: existingInstLine, error: existingInstLineErr } = await this.client
        .from('card_statement_lines')
        .select('id')
        .eq('statement_id', statement.id)
        .eq('installment_id', installment.id)
        .maybeSingle();
      if (existingInstLineErr) throw new Error(existingInstLineErr.message);
      if (existingInstLine) continue;

      const instCurrency = normalizeMovementCurrency(debtRef.currency);
      const { error: lineError } = await this.client.from('card_statement_lines').insert({
        statement_id: statement.id,
        source_type: 'installment',
        movement_id: null,
        installment_id: installment.id,
        detail: `${debtRef.description} - cuota ${installment.installment_number}`,
        amount: Number(installment.amount),
        currency: instCurrency,
        fx_ars_per_usd: null,
      });
      if (lineError) throw new Error(lineError.message);

      const { error: updateInstallmentError } = await this.client
        .from('card_debt_installments')
        .update({
          statement_id: statement.id,
          included_at: new Date().toISOString(),
          billing_period_year: year,
          billing_period_month: month,
        })
        .eq('id', installment.id);
      if (updateInstallmentError) throw new Error(updateInstallmentError.message);
    }

    const { data: lines, error: linesError } = await this.client
      .from('card_statement_lines')
      .select('amount, currency, movement_id, detail')
      .eq('statement_id', statement.id);
    if (linesError) throw new Error(linesError.message);

    const movementIds = Array.from(
      new Set(
        (lines ?? [])
          .map((r: { movement_id?: string | null }) => r.movement_id ?? null)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    );
    const movementMetaById = new Map<string, StatementLineMovementMeta>();
    if (movementIds.length > 0) {
      const { data: movementRows, error: movementErr } = await this.client
        .from('movements')
        .select('id, direction, raw_message')
        .eq('user_id', this.userId)
        .in('id', movementIds);
      if (movementErr) throw new Error(movementErr.message);
      for (const row of (movementRows ?? []) as Array<{
        id: string;
        direction?: string | null;
        raw_message?: string | null;
      }>) {
        movementMetaById.set(row.id, {
          direction: String(row.direction ?? 'gasto'),
          raw_message: typeof row.raw_message === 'string' ? row.raw_message : null,
        });
      }
    }

    let totalArs = 0;
    let totalUsd = 0;
    for (const row of lines ?? []) {
      const r = row as {
        amount: number | string;
        currency?: string | null;
        movement_id?: string | null;
        detail?: string | null;
      };
      const signedAmt = signedStatementLineAmountForTotals(r, movementMetaById);
      if (signedAmt === null) continue;
      if (normalizeMovementCurrency(r.currency) === 'USD') totalUsd += signedAmt;
      else totalArs += signedAmt;
    }
    totalArs = round2(totalArs);
    totalUsd = round2(totalUsd);
    const carryForStatement = await this.getStatementOpeningCarryBuckets(statement.id);
    totalArs = round2(totalArs + carryForStatement.ars);
    totalUsd = round2(totalUsd + carryForStatement.usd);

    await this.applyUnallocatedCreditToStatement(cardId, statement.id, totalArs, totalUsd);
    await this.syncStatementTotalsFromLinesAndAllocations(statement.id);

    const { data: updated, error: updateStatementError } = await this.client
      .from('card_statements')
      .select(CARD_STATEMENT_SELECT_FIELDS)
      .eq('id', statement.id)
      .eq('user_id', this.userId)
      .single();
    if (updateStatementError) throw new Error(updateStatementError.message);

    statement = mapStatementRow(updated);
    const detail = await this.getStatementById(cardId, statement.id);
    if (!detail) throw new Error('No se pudo reconstruir el resumen generado');
    return detail;
  }

  async listStatementsByCardId(id: string): Promise<CardStatementRow[] | null> {
    const card = await this.findById(id);
    if (!card) return null;

    const { data, error } = await this.client
      .from('card_statements')
      .select(CARD_STATEMENT_SELECT_FIELDS)
      .eq('user_id', this.userId)
      .eq('card_id', id)
      .order('period_year', { ascending: false })
      .order('period_month', { ascending: false });
    if (error) throw new Error(error.message);

    return (data ?? []).map(mapStatementRow);
  }

  async payableStatementByCardId(id: string): Promise<CardPayableStatementRow | null> {
    const card = await this.findById(id);
    if (!card) return null;

    const selectFields =
      'id, card_id, period_year, period_month, due_date, minimum_payment, outstanding_amount, outstanding_amount_usd, status';
    const findWithStatuses = async (
      statuses: Array<CardStatementRow['status']>,
      ascendingDueDate: boolean,
    ): Promise<CardPayableStatementRow | null> => {
      const { data, error } = await this.client
        .from('card_statements')
        .select(selectFields)
        .eq('user_id', this.userId)
        .eq('card_id', id)
        .in('status', statuses)
        .or('outstanding_amount.gt.0,outstanding_amount_usd.gt.0')
        .order('due_date', { ascending: ascendingDueDate })
        .limit(1);
      if (error) throw new Error(error.message);
      const row = (data ?? [])[0];
      return row ? mapPayableStatementRow(row) : null;
    };

    return (
      (await findWithStatuses(['cerrado', 'vencido'], true)) ??
      (await findWithStatuses(['abierto', 'cerrado', 'vencido'], false))
    );
  }

  async spendByRange(
    cardId: string,
    from: string,
    to: string,
    scope: EntryScope = 'operativo',
  ): Promise<CardSpendRangeSummary | null> {
    const card = await this.findById(cardId);
    if (!card) return null;
    if (!isIsoDate(from) || !isIsoDate(to)) {
      throw new Error('from/to inválidos (YYYY-MM-DD)');
    }
    if (from > to) {
      throw new Error('from no puede ser mayor que to');
    }

    let query = this.client
      .from('movements')
      .select('amount, currency, fx_ars_per_usd, movement_date')
      .eq('user_id', this.userId)
      .eq('status', 'active')
      .eq('card_id', cardId)
      .eq('direction', 'gasto')
      .eq('payment_method', 'tarjeta')
      .gte('movement_date', from)
      .lte('movement_date', to)
      .order('movement_date', { ascending: true });

    if (scope === 'operativo' || scope === 'historico') {
      query = query.eq('entry_mode', scope);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const byMonthArs = new Map<string, number>();
    const byMonthUsd = new Map<string, number>();
    let totalArs = 0;
    let totalUsd = 0;
    for (const row of (data ?? []) as Array<{
      amount: number | string;
      currency?: string | null;
      fx_ars_per_usd?: number | string | null;
      movement_date: string;
    }>) {
      const n = Number(row.amount);
      if (!Number.isFinite(n)) continue;
      const month = String(row.movement_date).slice(0, 7);
      if (normalizeMovementCurrency(row.currency) === 'USD') {
        totalUsd += n;
        byMonthUsd.set(month, round2((byMonthUsd.get(month) ?? 0) + n));
      } else {
        totalArs += n;
        byMonthArs.set(month, round2((byMonthArs.get(month) ?? 0) + n));
      }
    }

    const by_month = Array.from(byMonthArs.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([month, amount]) => ({ month, amount }));
    const by_month_usd = Array.from(byMonthUsd.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([month, amount]) => ({ month, amount }));

    return {
      card_id: cardId,
      from,
      to,
      scope,
      total_spent: round2(totalArs),
      total_spent_usd: round2(totalUsd),
      movements_count: (data ?? []).length,
      by_month,
      by_month_usd,
    };
  }

  async pendingInstallmentsByCardId(
    id: string,
  ): Promise<CardPendingInstallmentsResult | null> {
    const card = await this.findById(id);
    if (!card) return null;

    const { data, error } = await this.client
      .from('card_debt_installments')
      .select(
        'id, debt_id, installment_number, due_date, amount, statement_id, card_installment_debts!inner(description, card_id, user_id, status, total_installments, source_movement_id)',
      )
      .eq('card_installment_debts.card_id', id)
      .eq('card_installment_debts.user_id', this.userId)
      .order('due_date', { ascending: true })
      .order('installment_number', { ascending: true });
    if (error) throw new Error(error.message);

    const rowsRaw = data ?? [];
    const rowsList = Array.isArray(rowsRaw) ? rowsRaw : [];

    const parsedRows = rowsList as Array<{
      id: string;
      debt_id: string;
      installment_number: number;
      due_date: string;
      amount: number | string;
      statement_id: string | null;
      card_installment_debts:
        | {
            description: string;
            card_id: string;
            user_id: string;
            status: string;
            total_installments: number;
            source_movement_id?: string | null;
          }
        | Array<{
            description: string;
            card_id: string;
            user_id: string;
            status: string;
            total_installments: number;
            source_movement_id?: string | null;
          }>;
    }>;

    const sourceMovementIds = new Set<string>();
    for (const row of parsedRows) {
      const dr =
        Array.isArray(row.card_installment_debts) ?
          row.card_installment_debts[0]
        : row.card_installment_debts;
      const sid = dr?.source_movement_id;
      if (typeof sid === 'string' && sid.trim().length > 0) {
        sourceMovementIds.add(sid.trim());
      }
    }

    let activeSourceMovementIds = new Set<string>();
    if (sourceMovementIds.size > 0) {
      const { data: activeRows, error: activeErr } = await this.client
        .from('movements')
        .select('id')
        .eq('user_id', this.userId)
        .eq('status', 'active')
        .in('id', Array.from(sourceMovementIds));
      if (activeErr) throw new Error(activeErr.message);
      activeSourceMovementIds = new Set(
        (activeRows ?? []).map((r: { id: string }) => r.id),
      );
    }

    const statementIds = new Set<string>();
    for (const row of parsedRows) {
      const sid = typeof row.statement_id === 'string' ? row.statement_id.trim() : '';
      if (sid.length > 0) statementIds.add(sid);
    }

    const statementById = new Map<string, { status: string }>();
    if (statementIds.size > 0) {
      const { data: stRows, error: stErr } = await this.client
        .from('card_statements')
        .select('id, status')
        .eq('user_id', this.userId)
        .eq('card_id', id)
        .in('id', Array.from(statementIds));
      if (stErr) throw new Error(stErr.message);
      for (const s of (stRows ?? []) as Array<{ id: string; status: string }>) {
        statementById.set(s.id, { status: String(s.status ?? '') });
      }
    }

    const todayIso = new Date().toISOString().slice(0, 10);

    const installments: CardPendingInstallmentRow[] = [];
    for (const row of parsedRows) {
      const debtRef =
        Array.isArray(row.card_installment_debts) ?
          row.card_installment_debts[0]
        : row.card_installment_debts;
      if (!debtRef) continue;
      if (debtRef.user_id !== this.userId) continue;
      if (debtRef.card_id !== id) continue;
      if (debtRef.status === 'pagada' || debtRef.status === 'cancelada') continue;
      const srcId =
        typeof debtRef.source_movement_id === 'string' ?
          debtRef.source_movement_id.trim()
        : '';
      if (srcId.length > 0 && !activeSourceMovementIds.has(srcId)) {
        continue;
      }

      const stmtId = typeof row.statement_id === 'string' ? row.statement_id.trim() : '';
      if (stmtId.length > 0) {
        const st = statementById.get(stmtId);
        if (st && isInstallmentAbsorbedIntoClosedStatement(st)) {
          continue;
        }
      }

      const amount = Number(row.amount);
      if (!Number.isFinite(amount) || amount <= 0) continue;

      const projectedDueDate = projectPendingInstallmentToNextCardDueDate(card.due_day);
      const dueOverdue = projectedDueDate < todayIso;

      installments.push({
        debt_id: row.debt_id,
        debt_description: debtRef.description,
        debt_total_installments: Number(debtRef.total_installments),
        installment_id: row.id,
        installment_number: Number(row.installment_number),
        due_date: projectedDueDate,
        amount,
        remaining_amount: round2(amount),
        due_overdue: dueOverdue,
      });
    }

    installments.sort((a, b) => {
      if (a.due_date < b.due_date) return -1;
      if (a.due_date > b.due_date) return 1;
      return a.installment_number - b.installment_number;
    });

    const nextPerDebt = pickNextPendingInstallmentPerDebt(installments);
    const total_remaining_amount = round2(
      nextPerDebt.reduce((s, r) => s + r.remaining_amount, 0),
    );
    return {
      pending_count: maxPendingInstallmentCountByDebt(installments),
      total_remaining_amount,
      installments,
    };
  }

  async getStatementById(cardId: string, statementId: string): Promise<CardStatementDetail | null> {
    const card = await this.findById(cardId);
    if (!card) return null;

    const { data: statement, error: statementError } = await this.client
      .from('card_statements')
      .select(CARD_STATEMENT_SELECT_FIELDS)
      .eq('id', statementId)
      .eq('user_id', this.userId)
      .eq('card_id', cardId)
      .maybeSingle();
    if (statementError) throw new Error(statementError.message);
    if (!statement) return null;

    const { data: lines, error: linesError } = await this.client
      .from('card_statement_lines')
      .select('id, source_type, movement_id, installment_id, detail, amount, currency, fx_ars_per_usd')
      .eq('statement_id', statementId)
      .order('created_at', { ascending: true });
    if (linesError) throw new Error(linesError.message);

    const lineRows = (lines ?? []) as Array<{
      id: string;
      source_type: string;
      movement_id: string | null;
      installment_id: string | null;
      detail: string;
      amount: number | string;
      currency?: string | null;
      fx_ars_per_usd?: number | string | null;
    }>;
    const movementIds = Array.from(
      new Set(
        lineRows
          .map((row) => row.movement_id)
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0),
      ),
    );
    const movementDateById = new Map<string, string | null>();
    const movementLineMetaById = new Map<string, StatementLineMovementMeta>();
    if (movementIds.length > 0) {
      const { data: movementRows, error: movementRowsError } = await this.client
        .from('movements')
        .select('id, movement_date, direction, raw_message')
        .eq('user_id', this.userId)
        .in('id', movementIds);
      if (movementRowsError) throw new Error(movementRowsError.message);
      for (const row of (movementRows ?? []) as Array<{
        id: string;
        movement_date?: string | null;
        direction?: string | null;
        raw_message?: string | null;
      }>) {
        const md =
          typeof row.movement_date === 'string' && row.movement_date.trim().length > 0 ?
            row.movement_date
          : null;
        movementDateById.set(row.id, md);
        movementLineMetaById.set(row.id, {
          direction: String(row.direction ?? 'gasto'),
          raw_message: typeof row.raw_message === 'string' ? row.raw_message : null,
        });
      }
    }
    const enrichedLineRows = lineRows.map((row) => ({
      ...row,
      movement_date: row.movement_id ? (movementDateById.get(row.movement_id) ?? null) : null,
    }));
    const installmentIds = Array.from(
      new Set(
        lineRows
          .map((row) => row.installment_id)
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0),
      ),
    );
    const installmentMetaById = new Map<
      string,
      { installment_number: number; total_installments: number }
    >();
    if (installmentIds.length > 0) {
      const { data: installmentMetaRows, error: installmentMetaError } = await this.client
        .from('card_debt_installments')
        .select(
          'id, installment_number, card_installment_debts!inner(total_installments, user_id)',
        )
        .in('id', installmentIds);
      if (installmentMetaError) throw new Error(installmentMetaError.message);
      for (const row of (installmentMetaRows ?? []) as Array<{
        id: string;
        installment_number: number;
        card_installment_debts:
          | { total_installments: number; user_id: string }
          | Array<{ total_installments: number; user_id: string }>;
      }>) {
        const debtRef =
          Array.isArray(row.card_installment_debts) ?
            row.card_installment_debts[0]
          : row.card_installment_debts;
        if (!debtRef || debtRef.user_id !== this.userId) continue;
        installmentMetaById.set(row.id, {
          installment_number: Number(row.installment_number),
          total_installments: Number(debtRef.total_installments),
        });
      }
    }

    const mappedLines = enrichedLineRows.map((line) =>
      mapStatementLineRow(
        line,
        line.installment_id ? installmentMetaById.get(line.installment_id) : undefined,
        line.movement_id ? (movementLineMetaById.get(line.movement_id) ?? null) : null,
      ),
    );

    const { data: allocations, error: allocationsError } = await this.client
      .from('card_statement_payment_allocations')
      .select('id, payment_id, applied_amount, currency, created_at')
      .eq('statement_id', statementId)
      .order('created_at', { ascending: true });
    if (allocationsError) throw new Error(allocationsError.message);

    const allocationRows = (allocations ?? []) as Array<{
      id: string;
      payment_id: string;
      applied_amount: number | string;
      currency?: string | null;
      created_at?: string | null;
    }>;
    const paymentIds = Array.from(
      new Set(
        allocationRows
          .map((row) => row.payment_id)
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0),
      ),
    );
    const paymentsById = new Map<
      string,
      { id: string; movement_id: string | null; payment_date: string | null }
    >();
    if (paymentIds.length > 0) {
      const { data: payments, error: paymentsError } = await this.client
        .from('card_statement_payments')
        .select('id, movement_id, payment_date')
        .eq('user_id', this.userId)
        .in('id', paymentIds);
      if (paymentsError) throw new Error(paymentsError.message);
      for (const row of (payments ?? []) as Array<{
        id: string;
        movement_id?: string | null;
        payment_date?: string | null;
      }>) {
        paymentsById.set(row.id, {
          id: row.id,
          movement_id: row.movement_id ?? null,
          payment_date: row.payment_date ?? null,
        });
      }
    }

    const paymentLines: CardStatementLineRow[] = allocationRows.map((row) => {
      const payment = paymentsById.get(row.payment_id);
      const amount = Number(row.applied_amount);
      return {
        id: row.id,
        source_type: 'payment',
        movement_id: payment?.movement_id ?? null,
        installment_id: null,
        payment_id: row.payment_id,
        detail: 'Pago recibido',
        amount: Number.isFinite(amount) ? -Math.abs(amount) : 0,
        currency: normalizeMovementCurrency(row.currency),
        fx_ars_per_usd: null,
        movement_date: payment?.payment_date ?? null,
      };
    });

    return {
      ...mapStatementRow(statement),
      lines: [...mappedLines, ...paymentLines],
    };
  }

  async setInitialDebt(
    cardId: string,
    input: SetInitialCardDebtInput,
  ): Promise<CardStatementRow | null> {
    const card = await this.findById(cardId);
    if (!card) return null;

    if (input.month < 1 || input.month > 12) {
      throw new Error('month debe estar entre 1 y 12');
    }
    if (!Number.isFinite(input.outstanding_amount) || input.outstanding_amount < 0) {
      throw new Error('outstanding_amount debe ser >= 0');
    }

    const period = monthRangeByYearMonth(input.year, input.month, card.due_day ?? 10);
    const dueDate = input.due_date ?? period.due;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      throw new Error('due_date inválida');
    }

    const rounded = round2(input.outstanding_amount);
    const status = rounded === 0 ? 'pagado' : 'cerrado';

    const rowPayload = {
      opened_at: period.from,
      closed_at: period.to,
      due_date: dueDate,
      total_amount: rounded,
      total_amount_usd: 0,
      paid_amount: 0,
      paid_amount_usd: 0,
      outstanding_amount: rounded,
      outstanding_amount_usd: 0,
      opening_carry_amount: rounded,
      opening_carry_amount_usd: 0,
      minimum_payment: 0,
      interest_amount: 0,
      status,
    };

    const { data: existingByPeriod, error: findErr } = await this.client
      .from('card_statements')
      .select('id')
      .eq('user_id', this.userId)
      .eq('card_id', cardId)
      .eq('period_year', input.year)
      .eq('period_month', input.month)
      .maybeSingle();
    if (findErr) throw new Error(findErr.message);

    let data: Record<string, unknown> | null = null;
    if (existingByPeriod?.id) {
      const { data: updated, error: upErr } = await this.client
        .from('card_statements')
        .update(rowPayload)
        .eq('id', existingByPeriod.id)
        .eq('user_id', this.userId)
        .select(CARD_STATEMENT_SELECT_FIELDS)
        .single();
      if (upErr) throw new Error(upErr.message);
      data = updated as Record<string, unknown> | null;
    } else {
      const { data: inserted, error: insErr } = await this.client
        .from('card_statements')
        .insert({
          user_id: this.userId,
          card_id: cardId,
          period_year: input.year,
          period_month: input.month,
          ...rowPayload,
        })
        .select(CARD_STATEMENT_SELECT_FIELDS)
        .single();
      if (insErr) throw new Error(insErr.message);
      data = inserted as Record<string, unknown> | null;
    }

    if (!data) throw new Error('No se pudo guardar deuda inicial de tarjeta');

    return mapStatementRow(data as never);
  }

  async debtsByCardId(id: string): Promise<TarjetaDebtRow[] | null> {
    const card = await this.findById(id);
    if (!card) return null;

    const { data: debts, error: debtsError } = await this.client
      .from('card_installment_debts')
      .select(
        'id, card_id, description, currency, principal_amount, outstanding_amount, total_installments, installments_paid, first_due_date, status',
      )
      .eq('user_id', this.userId)
      .eq('card_id', id)
      .order('created_at', { ascending: false });
    if (debtsError) throw new Error(debtsError.message);

    const debtRows = (debts ?? []).map((row: {
      id: string;
      card_id: string;
      description: string;
      currency: string;
      principal_amount: number | string;
      outstanding_amount: number | string;
      total_installments: number;
      installments_paid: number;
      first_due_date: string;
      status: string;
    }) => mapTarjetaDebtRow(row));

    if (debtRows.length === 0) return [];

    const debtIds = debtRows.map((d) => d.id);
    const { data: installments, error: installmentsError } = await this.client
      .from('card_debt_installments')
      .select('id, debt_id, installment_number, due_date, amount, paid_amount, status, paid_at')
      .in('debt_id', debtIds)
      .order('installment_number', { ascending: true });
    if (installmentsError) throw new Error(installmentsError.message);

    const byDebt = new Map<string, TarjetaDebtInstallmentRow[]>();
    for (const item of (installments ?? []) as Array<{
      id: string;
      debt_id: string;
      installment_number: number;
      due_date: string;
      amount: number | string;
      paid_amount: number | string;
      status: string;
      paid_at: string | null;
    }>) {
      const list = byDebt.get(item.debt_id) ?? [];
      list.push({
        id: item.id,
        installment_number: Number(item.installment_number),
        due_date: item.due_date,
        amount: Number(item.amount),
        paid_amount: Number(item.paid_amount),
        status: normalizeCardInstallmentStatus(item.status),
        paid_at: item.paid_at,
      });
      byDebt.set(item.debt_id, list);
    }

    return debtRows.map((d) => ({
      ...d,
      installments: byDebt.get(d.id) ?? [],
    }));
  }

  async totalDebtAllCreditCards(): Promise<CreditCardsTotalDebtSummary> {
    const { data, error } = await this.client
      .from('card_installment_debts')
      .select('id, outstanding_amount, cards!inner(id, card_type)')
      .eq('user_id', this.userId)
      .eq('cards.card_type', 'credito')
      .in('status', ['abierta', 'mora']);

    if (error) throw new Error(error.message);

    const rows = (data ?? []) as Array<{
      id: string;
      outstanding_amount: number | string;
      cards: { id: string; card_type: string } | Array<{ id: string; card_type: string }>;
    }>;

    const cardIds = new Set<string>();
    let total = 0;
    for (const row of rows) {
      const cardRef = Array.isArray(row.cards) ? row.cards[0] : row.cards;
      if (!cardRef?.id) continue;
      cardIds.add(cardRef.id);
      const amount = Number(row.outstanding_amount);
      if (Number.isFinite(amount)) total += amount;
    }

    return {
      cards_count: cardIds.size,
      debts_count: rows.length,
      total_outstanding_amount: round2(total),
    };
  }

  private async sumCardSpendByPeriodBuckets(
    cardId: string,
    fromDate: string,
    toDate: string,
    scope: EntryScope,
  ): Promise<MoneyBucket> {
    let query = this.client
      .from('movements')
      .select('amount, currency')
      .eq('user_id', this.userId)
      .eq('status', 'active')
      .eq('card_id', cardId)
      .eq('direction', 'gasto')
      .eq('payment_method', 'tarjeta')
      .gte('movement_date', fromDate)
      .lte('movement_date', toDate);

    if (scope === 'operativo' || scope === 'historico') {
      query = query.eq('entry_mode', scope);
    }

    const { data, error } = await query;

    if (error) throw new Error(error.message);
    const bucket = emptyBucket();
    for (const row of data ?? []) {
      const r = row as { amount: number | string; currency?: string | null };
      const n = Number(r.amount);
      if (!Number.isFinite(n)) continue;
      if (normalizeMovementCurrency(r.currency) === 'USD') bucket.usd += n;
      else bucket.ars += n;
    }
    return { ars: round2(bucket.ars), usd: round2(bucket.usd) };
  }

  /** Gastos en un pago en el período (sin prorratear cuotas): `installments_total` null o 1. */
  private async sumCardSinglePaySpendByPeriodBuckets(
    cardId: string,
    fromDate: string,
    toDate: string,
    scope: EntryScope,
  ): Promise<MoneyBucket> {
    let query = this.client
      .from('movements')
      .select('amount, currency, installments_total')
      .eq('user_id', this.userId)
      .eq('status', 'active')
      .eq('card_id', cardId)
      .eq('direction', 'gasto')
      .eq('payment_method', 'tarjeta')
      .gte('movement_date', fromDate)
      .lte('movement_date', toDate)
      .or('installments_total.is.null,installments_total.eq.1');

    if (scope === 'operativo' || scope === 'historico') {
      query = query.eq('entry_mode', scope);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const bucket = emptyBucket();
    for (const row of data ?? []) {
      const r = row as { amount: number | string; currency?: string | null };
      const n = Number(r.amount);
      if (!Number.isFinite(n)) continue;
      if (normalizeMovementCurrency(r.currency) === 'USD') bucket.usd += n;
      else bucket.ars += n;
    }
    return { ars: round2(bucket.ars), usd: round2(bucket.usd) };
  }

  /** Suma cuotas del período de resumen (misma lógica que `generateMonthlyStatement`) más cuotas ya imputadas a ese resumen. */
  private async sumCardInstallmentsForBillingPeriodBuckets(
    cardId: string,
    year: number,
    month: number,
    _scope: EntryScope,
    card: TarjetaRow,
  ): Promise<{ ars: number; usd: number; countedInstallmentIds: Set<string> }> {
    const period = resolveStatementPeriodForGenerate(card, year, month);
    const bridgeDueUpper = addMonthsIso(period.due, 1);

    const installmentSelect =
      'id, amount, status, statement_id, due_date, billing_period_year, billing_period_month, card_installment_debts!inner(card_id, user_id, status, currency)';

    type InstRow = {
      id: string;
      amount: number | string;
      status: string;
      statement_id: string | null;
      due_date: string;
      billing_period_year: number;
      billing_period_month: number;
      card_installment_debts:
        | { card_id: string; user_id: string; status: string; currency?: string | null }
        | Array<{ card_id: string; user_id: string; status: string; currency?: string | null }>;
    };

    const byId = new Map<string, InstRow>();
    const pushRows = (rows: InstRow[] | null | undefined) => {
      for (const row of rows ?? []) {
        byId.set(row.id, row);
      }
    };

    const { data: stmtHeads, error: stErr } = await this.client
      .from('card_statements')
      .select('id')
      .eq('user_id', this.userId)
      .eq('card_id', cardId)
      .eq('period_year', year)
      .eq('period_month', month);
    if (stErr) throw new Error(stErr.message);
    const stmtIds = (stmtHeads ?? []).map((s: { id: string }) => s.id).filter(Boolean);
    if (stmtIds.length > 0) {
      const { data: linkedInst, error: lx } = await this.client
        .from('card_debt_installments')
        .select(installmentSelect)
        .in('statement_id', stmtIds)
        .neq('status', 'pagada');
      if (lx) throw new Error(lx.message);
      pushRows(linkedInst as InstRow[]);
    }

    const { data: installmentsByDue, error: instDueErr } = await this.client
      .from('card_debt_installments')
      .select(installmentSelect)
      .is('statement_id', null)
      .neq('status', 'pagada')
      .gte('due_date', period.from)
      .lte('due_date', period.to);
    if (instDueErr) throw new Error(instDueErr.message);
    pushRows(installmentsByDue as InstRow[]);

    const { data: installmentsByBilling, error: instBillErr } = await this.client
      .from('card_debt_installments')
      .select(installmentSelect)
      .is('statement_id', null)
      .neq('status', 'pagada')
      .eq('billing_period_year', year)
      .eq('billing_period_month', month);
    if (instBillErr) throw new Error(instBillErr.message);
    pushRows(installmentsByBilling as InstRow[]);

    const { data: installmentsBridge, error: instBridgeErr } = await this.client
      .from('card_debt_installments')
      .select(installmentSelect)
      .is('statement_id', null)
      .neq('status', 'pagada')
      .gt('due_date', period.to)
      .lte('due_date', bridgeDueUpper);
    if (instBridgeErr) throw new Error(instBridgeErr.message);
    pushRows(installmentsBridge as InstRow[]);

    const bucket = emptyBucket();
    for (const row of byId.values()) {
      const debtRef = Array.isArray(row.card_installment_debts) ?
        row.card_installment_debts[0]
      : row.card_installment_debts;
      if (!debtRef || debtRef.card_id !== cardId || debtRef.user_id !== this.userId) continue;
      if (debtRef.status === 'pagada' || debtRef.status === 'cancelada') continue;
      const n = Number(row.amount);
      if (!Number.isFinite(n)) continue;
      if (normalizeMovementCurrency(debtRef.currency) === 'USD') bucket.usd += n;
      else bucket.ars += n;
    }

    const countedInstallmentIds = new Set(byId.keys());

    return {
      ars: round2(bucket.ars),
      usd: round2(bucket.usd),
      countedInstallmentIds,
    };
  }

  private async resolveCycleWindows(
    card: TarjetaRow,
    today: Date,
  ): Promise<{
    previous: { from: string; to: string } | null;
    current: { from: string; to: string };
    next: { from: string; to: string };
  }> {
    const current = monthRange(today, 0);
    const next = monthRange(today, 1);
    const [currentStmt, nextStmt] = await Promise.all([
      this.getStatementPeriodWindow(card.id, current.label),
      this.getStatementPeriodWindow(card.id, next.label),
    ]);

    const cycleByClosingDay =
      typeof card.closing_day === 'number' ?
        cycleWindowsByClosingDay(today, card.closing_day)
      : null;
    const useCurrentStmt =
      currentStmt !== null &&
      (cycleByClosingDay === null || sameWindow(currentStmt, cycleByClosingDay.current));
    const useNextStmt =
      nextStmt !== null &&
      (cycleByClosingDay === null || sameWindow(nextStmt, cycleByClosingDay.next));
    const currentWindow =
      useCurrentStmt ?
        currentStmt
      : cycleByClosingDay?.current ?? { from: current.from, to: current.to };
    const nextWindow =
      useNextStmt ?
        nextStmt
      : {
      from: addDaysIso(currentWindow.to, 1),
      to: cycleByClosingDay?.next.to ?? next.to,
    };
    return {
      previous: cycleByClosingDay?.previous ?? null,
      current: currentWindow,
      next: nextWindow,
    };
  }

  private async getStatementPeriodWindow(
    cardId: string,
    period: string,
  ): Promise<{ from: string; to: string } | null> {
    const parsed = parseYearMonth(period);
    if (!parsed) return null;
    const { data, error } = await this.client
      .from('card_statements')
      .select('opened_at, closed_at')
      .eq('user_id', this.userId)
      .eq('card_id', cardId)
      .eq('period_year', parsed.year)
      .eq('period_month', parsed.month)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data?.opened_at || !data?.closed_at) return null;
    return {
      from: String(data.opened_at),
      to: String(data.closed_at),
    };
  }

  private async findOrCreateStatement(
    cardId: string,
    year: number,
    month: number,
    openedAt: string,
    closedAt: string,
    dueDate: string,
  ): Promise<CardStatementRow> {
    const { data: existing, error: existingError } = await this.client
      .from('card_statements')
      .select(CARD_STATEMENT_SELECT_FIELDS)
      .eq('user_id', this.userId)
      .eq('card_id', cardId)
      .eq('period_year', year)
      .eq('period_month', month)
      .maybeSingle();
    if (existingError) throw new Error(existingError.message);
    if (existing) return mapStatementRow(existing);

    const { data: created, error: createError } = await this.client
      .from('card_statements')
      .insert({
        user_id: this.userId,
        card_id: cardId,
        period_year: year,
        period_month: month,
        opened_at: openedAt,
        closed_at: closedAt,
        due_date: dueDate,
        total_amount: 0,
        total_amount_usd: 0,
        minimum_payment: 0,
        interest_amount: 0,
        paid_amount: 0,
        paid_amount_usd: 0,
        outstanding_amount: 0,
        outstanding_amount_usd: 0,
        status: 'abierto',
      })
      .select(CARD_STATEMENT_SELECT_FIELDS)
      .single();
    if (createError) throw new Error(createError.message);
    if (!created) throw new Error('No se pudo crear resumen mensual de tarjeta');
    return mapStatementRow(created);
  }

  private async applyDueDayToCurrentStatement(cardId: string, dueDay: number): Promise<void> {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const dueDate = dueDateByYearMonth(year, month, dueDay);

    const { data: statement, error: fetchError } = await this.client
      .from('card_statements')
      .select('id, status')
      .eq('user_id', this.userId)
      .eq('card_id', cardId)
      .eq('period_year', year)
      .eq('period_month', month)
      .maybeSingle();
    if (fetchError) throw new Error(fetchError.message);
    if (!statement) return;
    if (statement.status === 'pagado') return;

    const { error: updateError } = await this.client
      .from('card_statements')
      .update({ due_date: dueDate })
      .eq('id', statement.id)
      .eq('user_id', this.userId);
    if (updateError) throw new Error(updateError.message);
  }

  private async reconcileStatementWindowsForClosingDayChange(
    cardId: string,
    closingDay: number,
    today: Date = new Date(),
  ): Promise<void> {
    const windows = cycleWindowsByClosingDay(today, closingDay);
    const targets: Array<{ period: string; from: string; to: string }> = [
      { period: monthRange(today, -1).label, from: windows.previous.from, to: windows.previous.to },
      { period: monthRange(today, 0).label, from: windows.current.from, to: windows.current.to },
      { period: monthRange(today, 1).label, from: windows.next.from, to: windows.next.to },
    ];

    for (const target of targets) {
      const ym = parseYearMonth(target.period);
      if (!ym) continue;
      const { data: statement, error: fetchError } = await this.client
        .from('card_statements')
        .select('id, status, opened_at, closed_at')
        .eq('user_id', this.userId)
        .eq('card_id', cardId)
        .eq('period_year', ym.year)
        .eq('period_month', ym.month)
        .maybeSingle();
      if (fetchError) throw new Error(fetchError.message);
      if (!statement || statement.status === 'pagado') continue;

      const { error: updateError } = await this.client
        .from('card_statements')
        .update({
          opened_at: target.from,
          closed_at: target.to,
        })
        .eq('id', statement.id)
        .eq('user_id', this.userId);
      if (updateError) throw new Error(updateError.message);
    }
  }

  async updateStatementWindow(
    cardId: string,
    statementId: string,
    input: StatementWindowInput,
  ): Promise<UpdateStatementWindowResult | null> {
    const card = await this.findById(cardId);
    if (!card) return null;

    const { data: rawStmt, error: fetchErr } = await this.client
      .from('card_statements')
      .select(
        'id, opened_at, closed_at, due_date, total_amount, period_year, period_month, status',
      )
      .eq('id', statementId)
      .eq('user_id', this.userId)
      .eq('card_id', cardId)
      .maybeSingle();
    if (fetchErr) throw new Error(fetchErr.message);
    if (!rawStmt) return null;

    const opened_at =
      input.opened_at !== undefined ?
        input.opened_at
      : String(rawStmt.opened_at).slice(0, 10);
    const closed_at =
      input.closed_at !== undefined ?
        input.closed_at
      : String(rawStmt.closed_at).slice(0, 10);
    const due_date =
      input.due_date !== undefined ?
        input.due_date
      : String(rawStmt.due_date).slice(0, 10);

    if (!isIsoDate(opened_at) || !isIsoDate(closed_at) || !isIsoDate(due_date)) {
      throw new Error('opened_at, closed_at y due_date deben ser YYYY-MM-DD');
    }
    if (opened_at > closed_at) {
      throw new Error('opened_at no puede ser mayor que closed_at');
    }

    await this.assertStatementWindowNoOverlap(cardId, statementId, opened_at, closed_at);

    const previous_total = round2(Number(rawStmt.total_amount));

    const sync: StatementSyncReport = {
      added_movements: 0,
      removed_movements: 0,
      added_installments: 0,
      removed_installments: 0,
      previous_total,
      new_total: previous_total,
    };

    const { error: updErr } = await this.client
      .from('card_statements')
      .update({ opened_at, closed_at, due_date })
      .eq('id', statementId)
      .eq('user_id', this.userId);
    if (updErr) throw new Error(updErr.message);

    await this.syncMovementLinesForStatementWindow(cardId, statementId, opened_at, closed_at, sync);
    await this.syncInstallmentLinesForStatementWindow(
      cardId,
      statementId,
      opened_at,
      closed_at,
      sync,
      Number(rawStmt.period_year),
      Number(rawStmt.period_month),
    );

    await this.recalculateStatementTotals(statementId);

    const { data: afterStmt } = await this.client
      .from('card_statements')
      .select('total_amount')
      .eq('id', statementId)
      .single();
    sync.new_total = round2(Number(afterStmt?.total_amount ?? 0));

    const detail = await this.getStatementById(cardId, statementId);
    if (!detail) throw new Error('No se pudo cargar el resumen actualizado');
    return { statement: detail, sync };
  }

  private async assertStatementWindowNoOverlap(
    cardId: string,
    exceptStatementId: string,
    from: string,
    to: string,
  ): Promise<void> {
    const { data: rows, error } = await this.client
      .from('card_statements')
      .select('id, opened_at, closed_at, period_year, period_month')
      .eq('user_id', this.userId)
      .eq('card_id', cardId)
      .neq('id', exceptStatementId);
    if (error) throw new Error(error.message);
    for (const r of rows ?? []) {
      const o = String(r.opened_at).slice(0, 10);
      const c = String(r.closed_at).slice(0, 10);
      if (intervalsOverlapInclusive(from, to, o, c)) {
        throw new Error(
          `El rango se solapa con el resumen ${r.period_year}-${String(r.period_month).padStart(2, '0')}`,
        );
      }
    }
  }

  private async recalculateStatementTotals(statementId: string): Promise<void> {
    const { data: stmt, error: sErr } = await this.client
      .from('card_statements')
      .select('status, card_id')
      .eq('id', statementId)
      .eq('user_id', this.userId)
      .maybeSingle();
    if (sErr) throw new Error(sErr.message);
    if (!stmt) return;

    const { data: lines, error: lErr } = await this.client
      .from('card_statement_lines')
      .select('amount, currency, movement_id, detail')
      .eq('statement_id', statementId);
    if (lErr) throw new Error(lErr.message);

    const movementIds = Array.from(
      new Set(
        (lines ?? [])
          .map((r: { movement_id?: string | null }) => r.movement_id ?? null)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    );
    const movementMetaById = new Map<string, StatementLineMovementMeta>();
    if (movementIds.length > 0) {
      const { data: movementRows, error: movementErr } = await this.client
        .from('movements')
        .select('id, direction, raw_message')
        .eq('user_id', this.userId)
        .in('id', movementIds);
      if (movementErr) throw new Error(movementErr.message);
      for (const row of (movementRows ?? []) as Array<{
        id: string;
        direction?: string | null;
        raw_message?: string | null;
      }>) {
        movementMetaById.set(row.id, {
          direction: String(row.direction ?? 'gasto'),
          raw_message: typeof row.raw_message === 'string' ? row.raw_message : null,
        });
      }
    }

    let totalArs = 0;
    let totalUsd = 0;
    for (const row of lines ?? []) {
      const r = row as {
        amount: number | string;
        currency?: string | null;
        movement_id?: string | null;
        detail?: string | null;
      };
      const signedAmt = signedStatementLineAmountForTotals(r, movementMetaById);
      if (signedAmt === null) continue;
      if (normalizeMovementCurrency(r.currency) === 'USD') totalUsd += signedAmt;
      else totalArs += signedAmt;
    }
    totalArs = round2(totalArs);
    totalUsd = round2(totalUsd);
    const carryRecalc = await this.getStatementOpeningCarryBuckets(statementId);
    totalArs = round2(totalArs + carryRecalc.ars);
    totalUsd = round2(totalUsd + carryRecalc.usd);
    const cardId = String((stmt as { card_id: string }).card_id);
    await this.applyUnallocatedCreditToStatement(cardId, statementId, totalArs, totalUsd);
    const prior = String((stmt as { status: string }).status ?? 'cerrado');
    const statusWhenOutstanding =
      prior === 'vencido' ? 'vencido'
      : prior === 'abierto' ? 'abierto'
      : 'cerrado';
    await this.syncStatementTotalsFromLinesAndAllocations(statementId, statusWhenOutstanding);
  }

  private async syncMovementLinesForStatementWindow(
    cardId: string,
    statementId: string,
    from: string,
    to: string,
    sync: StatementSyncReport,
  ): Promise<void> {
    const { data: myLines, error: e1 } = await this.client
      .from('card_statement_lines')
      .select('id, movement_id')
      .eq('statement_id', statementId)
      .eq('source_type', 'movement')
      .not('movement_id', 'is', null);
    if (e1) throw new Error(e1.message);

    const movementIdsOnStmt = (myLines ?? [])
      .map((r: { movement_id: string | null }) => r.movement_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    if (movementIdsOnStmt.length > 0) {
      const { data: movements, error: e2 } = await this.client
        .from('movements')
        .select('id, movement_date, installments_total')
        .in('id', movementIdsOnStmt);
      if (e2) throw new Error(e2.message);
      const byId = new Map(
        (movements ?? []).map((m: { id: string; movement_date: string; installments_total?: number | null }) => [
          m.id,
          {
            movementDate: m.movement_date,
            installmentsTotal:
              typeof m.installments_total === 'number' ? m.installments_total : null,
          },
        ]),
      );
      for (const line of myLines ?? []) {
        const mid = line.movement_id as string | null;
        if (!mid) continue;
        const movement = byId.get(mid);
        const mdStr = movement !== undefined ? String(movement.movementDate).slice(0, 10) : '';
        const isInstallmentMovement =
          movement?.installmentsTotal !== null &&
          movement?.installmentsTotal !== undefined &&
          movement.installmentsTotal > 1;
        if (isInstallmentMovement || !mdStr || mdStr < from || mdStr > to) {
          const { error: delErr } = await this.client
            .from('card_statement_lines')
            .delete()
            .eq('id', line.id);
          if (delErr) throw new Error(delErr.message);
          sync.removed_movements += 1;
        }
      }
    }

    const { data: inRange, error: e3 } = await this.client
      .from('movements')
      .select('id, detail, amount, currency, fx_ars_per_usd, installments_total, direction')
      .eq('user_id', this.userId)
      .eq('status', 'active')
      .eq('card_id', cardId)
      .eq('payment_method', 'tarjeta')
      .eq('entry_mode', 'operativo')
      .or('direction.eq.gasto,and(direction.eq.ingreso,settled_card_id.is.null)')
      .or('installments_total.is.null,installments_total.lte.1')
      .gte('movement_date', from)
      .lte('movement_date', to);
    if (e3) throw new Error(e3.message);

    for (const movement of (inRange ?? []) as Array<{
      id: string;
      detail: string | null;
      amount: number | string;
      currency?: string | null;
      fx_ars_per_usd?: number | string | null;
      direction?: string | null;
    }>) {
      const { data: existingLine, error: e4 } = await this.client
        .from('card_statement_lines')
        .select('id, statement_id')
        .eq('movement_id', movement.id)
        .maybeSingle();
      if (e4) throw new Error(e4.message);

      if (existingLine && existingLine.statement_id === statementId) continue;

      if (existingLine && existingLine.statement_id !== statementId) {
        const otherId = existingLine.statement_id as string;
        const { error: delOtherErr } = await this.client
          .from('card_statement_lines')
          .delete()
          .eq('id', existingLine.id);
        if (delOtherErr) throw new Error(delOtherErr.message);
        await this.recalculateStatementTotals(otherId);
      }

      const linePayload = movementLinePayload(movement);
      const { error: insErr } = await this.client.from('card_statement_lines').insert({
        statement_id: statementId,
        source_type: 'movement',
        movement_id: movement.id,
        installment_id: null,
        detail: movement.detail || 'Consumo tarjeta',
        amount: linePayload.amount,
        currency: linePayload.currency,
        fx_ars_per_usd: linePayload.fx_ars_per_usd,
      });
      if (insErr) throw new Error(insErr.message);
      sync.added_movements += 1;
    }
  }

  private async syncInstallmentLinesForStatementWindow(
    cardId: string,
    statementId: string,
    from: string,
    to: string,
    sync: StatementSyncReport,
    statementPeriodYear: number,
    statementPeriodMonth: number,
  ): Promise<void> {
    const { data: linkedToThis, error: e1 } = await this.client
      .from('card_debt_installments')
      .select('id, due_date, status')
      .eq('statement_id', statementId);
    if (e1) throw new Error(e1.message);

    for (const row of linkedToThis ?? []) {
      const dd = String(row.due_date).slice(0, 10);
      if (row.status === 'pagada' || dd < from || dd > to) {
        const { error: delLineErr } = await this.client
          .from('card_statement_lines')
          .delete()
          .eq('installment_id', row.id)
          .eq('source_type', 'installment');
        if (delLineErr) throw new Error(delLineErr.message);
        const { error: updInstErr } = await this.client
          .from('card_debt_installments')
          .update({ statement_id: null, included_at: null })
          .eq('id', row.id);
        if (updInstErr) throw new Error(updInstErr.message);
        sync.removed_installments += 1;
      }
    }

    const { data: inRangeInst, error: e2 } = await this.client
      .from('card_debt_installments')
      .select(
        'id, debt_id, installment_number, amount, due_date, statement_id, card_installment_debts!inner(description, card_id, user_id, currency)',
      )
      .eq('card_installment_debts.user_id', this.userId)
      .eq('card_installment_debts.card_id', cardId)
      .neq('status', 'pagada')
      .gte('due_date', from)
      .lte('due_date', to);
    if (e2) throw new Error(e2.message);

    for (const installment of (inRangeInst ?? []) as Array<{
      id: string;
      debt_id: string;
      installment_number: number;
      amount: number | string;
      due_date: string;
      statement_id: string | null;
      card_installment_debts:
        | { description: string; card_id: string; user_id: string; currency?: string | null }
        | Array<{ description: string; card_id: string; user_id: string; currency?: string | null }>;
    }>) {
      const debtRef =
        Array.isArray(installment.card_installment_debts) ?
          installment.card_installment_debts[0]
        : installment.card_installment_debts;
      if (!debtRef || debtRef.card_id !== cardId) continue;

      if (installment.statement_id === statementId) continue;

      const { data: existingLine, error: e3 } = await this.client
        .from('card_statement_lines')
        .select('id, statement_id')
        .eq('installment_id', installment.id)
        .maybeSingle();
      if (e3) throw new Error(e3.message);

      if (existingLine) {
        const otherId = existingLine.statement_id as string;
        const { error: dErr } = await this.client.from('card_statement_lines').delete().eq('id', existingLine.id);
        if (dErr) throw new Error(dErr.message);
        await this.recalculateStatementTotals(otherId);
      }

      const { error: nullErr } = await this.client
        .from('card_debt_installments')
        .update({ statement_id: null, included_at: null })
        .eq('id', installment.id);
      if (nullErr) throw new Error(nullErr.message);

      const instCurrency = normalizeMovementCurrency(debtRef.currency);
      const { error: lineErr } = await this.client.from('card_statement_lines').insert({
        statement_id: statementId,
        source_type: 'installment',
        movement_id: null,
        installment_id: installment.id,
        detail: `${debtRef.description} - cuota ${installment.installment_number}`,
        amount: Number(installment.amount),
        currency: instCurrency,
        fx_ars_per_usd: null,
      });
      if (lineErr) throw new Error(lineErr.message);

      const { error: upErr } = await this.client
        .from('card_debt_installments')
        .update({
          statement_id: statementId,
          included_at: new Date().toISOString(),
          billing_period_year: statementPeriodYear,
          billing_period_month: statementPeriodMonth,
        })
        .eq('id', installment.id);
      if (upErr) throw new Error(upErr.message);

      sync.added_installments += 1;
    }
  }
}

function mapCardRow(row: {
  id: string;
  name: string;
  bank: string;
  card_type: string;
  network: string;
  credit_limit: number | string | null;
  closing_day?: number | null;
  due_day?: number | null;
}): TarjetaRow {
  return {
    id: row.id,
    name: row.name,
    bank: row.bank,
    type_card: row.card_type as TarjetaRow['type_card'],
    payment_card: row.network,
    credit_limit: row.credit_limit === null ? null : Number(row.credit_limit),
    closing_day:
      typeof row.closing_day === 'number' ? row.closing_day
      : typeof row.closing_day === 'string' ? Number(row.closing_day)
      : null,
    due_day:
      typeof row.due_day === 'number' ? row.due_day
      : typeof row.due_day === 'string' ? Number(row.due_day)
      : null,
  };
}

function mapStatementRow(row: {
  id: string;
  card_id: string;
  period_year: number;
  period_month: number;
  opened_at: string;
  closed_at: string;
  due_date: string;
  total_amount: number | string;
  total_amount_usd?: number | string | null;
  paid_amount: number | string;
  paid_amount_usd?: number | string | null;
  outstanding_amount: number | string;
  outstanding_amount_usd?: number | string | null;
  opening_carry_amount?: number | string | null;
  opening_carry_amount_usd?: number | string | null;
  status: string;
}): CardStatementRow {
  const tusd = Number(row.total_amount_usd ?? 0);
  const pusd = Number(row.paid_amount_usd ?? 0);
  const ousd = Number(row.outstanding_amount_usd ?? 0);
  const oca = Number(row.opening_carry_amount ?? 0);
  const ocu = Number(row.opening_carry_amount_usd ?? 0);
  return {
    id: row.id,
    card_id: row.card_id,
    period_year: Number(row.period_year),
    period_month: Number(row.period_month),
    opened_at: row.opened_at,
    closed_at: row.closed_at,
    due_date: row.due_date,
    total_amount: Number(row.total_amount),
    total_amount_usd: Number.isFinite(tusd) ? tusd : 0,
    paid_amount: Number(row.paid_amount),
    paid_amount_usd: Number.isFinite(pusd) ? pusd : 0,
    outstanding_amount: Number(row.outstanding_amount),
    outstanding_amount_usd: Number.isFinite(ousd) ? ousd : 0,
    opening_carry_amount: Number.isFinite(oca) ? oca : 0,
    opening_carry_amount_usd: Number.isFinite(ocu) ? ocu : 0,
    status: normalizeStatementStatus(row.status),
  };
}

function mapPayableStatementRow(row: {
  id: string;
  card_id: string;
  period_year: number;
  period_month: number;
  due_date: string;
  minimum_payment?: number | string | null;
  outstanding_amount: number | string;
  outstanding_amount_usd?: number | string | null;
  status: string;
}): CardPayableStatementRow {
  const min = Number(row.minimum_payment ?? 0);
  const outstandingArs = Number(row.outstanding_amount);
  const outstandingUsd = Number(row.outstanding_amount_usd ?? 0);
  return {
    id: row.id,
    card_id: row.card_id,
    period_year: Number(row.period_year),
    period_month: Number(row.period_month),
    due_date: row.due_date,
    minimum_payment: Number.isFinite(min) ? min : 0,
    outstanding_amount: Number.isFinite(outstandingArs) ? outstandingArs : 0,
    outstanding_amount_usd: Number.isFinite(outstandingUsd) ? outstandingUsd : 0,
    status: normalizeStatementStatus(row.status),
  };
}

function mapStatementLineRow(row: {
  id: string;
  source_type: string;
  movement_id: string | null;
  installment_id: string | null;
  detail: string;
  amount: number | string;
  currency?: string | null;
  fx_ars_per_usd?: number | string | null;
  movement_date?: string | null;
}, installmentMeta?: {
  installment_number: number;
  total_installments: number;
}, movementLineMeta?: StatementLineMovementMeta | null): CardStatementLineRow {
  const cur = normalizeMovementCurrency(row.currency) as CardStatementLineRow['currency'];
  const fxRaw = row.fx_ars_per_usd;
  const fx = fxRaw === null || fxRaw === undefined || fxRaw === '' ? null : Number(fxRaw);
  const rawAmt = Number(row.amount);
  const meta = movementLineMeta ?? { direction: 'gasto', raw_message: null };
  const treatAsCredit =
    row.source_type === 'installment' ? false
    : statementLineTreatsMovementAsCredit({
        direction: meta.direction,
        detail: row.detail,
        rawMessage: meta.raw_message,
      });
  const signedAmount =
    treatAsCredit && Number.isFinite(rawAmt) ? -Math.abs(rawAmt)
    : Number.isFinite(rawAmt) ? rawAmt
    : 0;
  return {
    id: row.id,
    source_type: row.source_type === 'installment' ? 'installment' : 'movement',
    movement_id: row.movement_id,
    installment_id: row.installment_id,
    detail: row.detail,
    amount: signedAmount,
    currency: cur,
    fx_ars_per_usd: fx !== null && Number.isFinite(fx) ? fx : null,
    movement_date:
      typeof row.movement_date === 'string' && row.movement_date.trim().length > 0 ?
        row.movement_date
      : null,
    installment_number: installmentMeta?.installment_number,
    total_installments: installmentMeta?.total_installments,
  };
}

function normalizeStatementStatus(v: string): CardStatementRow['status'] {
  if (v === 'abierto' || v === 'pagado' || v === 'vencido') return v;
  return 'cerrado';
}

function normalizePositiveNumber(v: number | null): number | null {
  if (v === null) return null;
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error('credit_limit must be greater than 0');
  }
  return round2(v);
}

function monthRange(base: Date, offsetMonths: number): {
  from: string;
  to: string;
  label: string;
} {
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth() + offsetMonths;
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 0));
  return {
    from: toIsoDate(start),
    to: toIsoDate(end),
    label: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
  };
}

function monthRangeByYearMonth(year: number, month: number, dueDay: number): {
  from: string;
  to: string;
  due: string;
} {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  const due = dateWithClampedDayUTC(year, month, dueDay);
  return {
    from: toIsoDate(start),
    to: toIsoDate(end),
    due: toIsoDate(due),
  };
}

function dueDateByYearMonth(year: number, month: number, dueDay: number): string {
  return toIsoDate(dateWithClampedDayUTC(year, month, dueDay));
}

function normalizeDueDay(value: number | null | undefined, fallback: number): number {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > 31) {
    throw new Error('due_day must be an integer between 1 and 31');
  }
  return candidate;
}

function mapTarjetaDebtRow(row: {
  id: string;
  card_id: string;
  description: string;
  currency: string;
  principal_amount: number | string;
  outstanding_amount: number | string;
  total_installments: number;
  installments_paid: number;
  first_due_date: string;
  status: string;
}): Omit<TarjetaDebtRow, 'installments'> {
  const total = Number(row.total_installments);
  const paid = Number(row.installments_paid);
  return {
    id: row.id,
    card_id: row.card_id,
    description: row.description,
    currency: row.currency,
    principal_amount: Number(row.principal_amount),
    outstanding_amount: Number(row.outstanding_amount),
    total_installments: total,
    installments_paid: paid,
    installments_remaining: Math.max(total - paid, 0),
    first_due_date: row.first_due_date,
    status: normalizeCardDebtStatus(row.status),
  };
}

function normalizeCardDebtStatus(v: string): TarjetaDebtRow['status'] {
  if (v === 'pagada' || v === 'cancelada' || v === 'mora') return v;
  return 'abierta';
}

function normalizeCardInstallmentStatus(v: string): TarjetaDebtInstallmentRow['status'] {
  if (v === 'pagada' || v === 'vencida') return v;
  return 'pendiente';
}

/**
 * Cuotas ya incluidas en un resumen cerrado (o vencido/pagado) dejan de listarse como cuotas:
 * el saldo pendiente vive en el resumen de la tarjeta, no como cuotas sueltas.
 */
function isInstallmentAbsorbedIntoClosedStatement(st: { status: string }): boolean {
  const s = st.status.trim().toLowerCase();
  return s === 'cerrado' || s === 'vencido' || s === 'pagado';
}

function pickNextPendingInstallmentPerDebt(rows: CardPendingInstallmentRow[]): CardPendingInstallmentRow[] {
  const byDebt = new Map<string, CardPendingInstallmentRow[]>();
  for (const r of rows) {
    if (r.remaining_amount <= 0) continue;
    const debtId = r.debt_id?.trim();
    if (!debtId) continue;
    const list = byDebt.get(debtId) ?? [];
    list.push(r);
    byDebt.set(debtId, list);
  }
  const picked: CardPendingInstallmentRow[] = [];
  for (const group of byDebt.values()) {
    let best = group[0];
    for (const r of group) {
      if (r.installment_number < best.installment_number) best = r;
    }
    picked.push(best);
  }
  return picked.sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));
}

function maxPendingInstallmentCountByDebt(rows: CardPendingInstallmentRow[]): number {
  const countsByDebt = new Map<string, number>();
  for (const row of rows) {
    if (row.remaining_amount <= 0) continue;
    const debtId = row.debt_id?.trim();
    if (!debtId) continue;
    countsByDebt.set(debtId, (countsByDebt.get(debtId) ?? 0) + 1);
  }
  return Array.from(countsByDebt.values()).reduce((max, count) => Math.max(max, count), 0);
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function addDaysIso(isoDate: string, days: number): string {
  const t = Date.parse(`${isoDate}T12:00:00.000Z`);
  if (Number.isNaN(t)) return isoDate;
  const d = new Date(t);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

/** Suma meses calendario en UTC (misma lógica que en `supabase-transaction.repository`). */
function addMonthsIso(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const targetMonthIndex = m - 1 + months;
  const targetYear = y + Math.floor(targetMonthIndex / 12);
  const monthInYear = ((targetMonthIndex % 12) + 12) % 12;
  const daysInTargetMonth = new Date(Date.UTC(targetYear, monthInYear + 1, 0)).getUTCDate();
  const day = Math.min(d, daysInTargetMonth);
  const dt = new Date(Date.UTC(targetYear, monthInYear, day));
  return dt.toISOString().slice(0, 10);
}

function parseYearMonth(value: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  return { year, month };
}

function sameWindow(
  a: { from: string; to: string },
  b: { from: string; to: string },
): boolean {
  return a.from === b.from && a.to === b.to;
}

function cycleWindowsByClosingDay(
  reference: Date,
  closingDay: number,
): {
  previous: { from: string; to: string };
  current: { from: string; to: string };
  next: { from: string; to: string };
} {
  const day = reference.getUTCDate();
  const year = reference.getUTCFullYear();
  const month = reference.getUTCMonth(); // 0-based

  const currentClosing =
    day <= closingDay ?
      dateWithClampedDayUTC(year, month, closingDay)
    : dateWithClampedDayUTC(year, month + 1, closingDay);
  const previousClosing =
    day <= closingDay ?
      dateWithClampedDayUTC(year, month - 1, closingDay)
    : dateWithClampedDayUTC(year, month, closingDay);
  const prePreviousClosing = dateWithClampedDayUTC(
    previousClosing.getUTCFullYear(),
    previousClosing.getUTCMonth() - 1,
    closingDay,
  );
  const nextClosing = dateWithClampedDayUTC(
    currentClosing.getUTCFullYear(),
    currentClosing.getUTCMonth() + 1,
    closingDay,
  );

  return {
    previous: {
      from: toIsoDate(addDaysUTC(prePreviousClosing, 1)),
      to: toIsoDate(previousClosing),
    },
    current: {
      from: toIsoDate(addDaysUTC(previousClosing, 1)),
      to: toIsoDate(currentClosing),
    },
    next: {
      from: toIsoDate(addDaysUTC(currentClosing, 1)),
      to: toIsoDate(nextClosing),
    },
  };
}

function intervalsOverlapInclusive(a1: string, a2: string, b1: string, b2: string): boolean {
  return a1 <= b2 && b1 <= a2;
}

function dueDateInMonthAfterClose(closedAtIso: string, dueDay: number): string {
  const t = Date.parse(`${closedAtIso}T12:00:00.000Z`);
  if (Number.isNaN(t)) throw new Error('closed_at inválida');
  const d = new Date(t);
  return toIsoDate(dateWithClampedDayUTC(d.getUTCFullYear(), d.getUTCMonth() + 1, dueDay));
}

function resolveStatementPeriodForGenerate(
  card: TarjetaRow,
  year: number,
  month: number,
  override?: StatementWindowInput,
): { from: string; to: string; due: string } {
  const hasPart =
    override !== undefined &&
    (override.opened_at !== undefined ||
      override.closed_at !== undefined ||
      override.due_date !== undefined);
  if (hasPart) {
    if (!override?.opened_at || !override?.closed_at) {
      throw new Error('Para override de ventana, enviá opened_at y closed_at');
    }
    if (override.opened_at > override.closed_at) {
      throw new Error('opened_at no puede ser mayor que closed_at');
    }
    const due =
      override.due_date !== undefined ?
        override.due_date
      : dueDateInMonthAfterClose(override.closed_at, normalizeDueDay(card.due_day, 10));
    if (!isIsoDate(due)) throw new Error('due_date inválida');
    return { from: override.opened_at, to: override.closed_at, due };
  }
  if (typeof card.closing_day === 'number') {
    const ref = new Date(Date.UTC(year, month - 1, 15));
    const w = cycleWindowsByClosingDay(ref, card.closing_day);
    const due = dueDateInMonthAfterClose(w.current.to, normalizeDueDay(card.due_day, 10));
    return { from: w.current.from, to: w.current.to, due };
  }
  return monthRangeByYearMonth(year, month, card.due_day ?? 10);
}

/** Periodos (año/mes de resumen) cuyo `due_date` teórico cae en [dueFrom, dueTo] (YYYY-MM-DD). */
export function collectPeriodKeysWithDueInCalendarMonth(
  card: TarjetaRow,
  dueFrom: string,
  dueTo: string,
  anchorYear: number,
  anchorMonth: number,
): Array<{ year: number; month: number }> {
  const out: Array<{ year: number; month: number }> = [];
  const seen = new Set<string>();
  for (let offset = -6; offset <= 6; offset++) {
    const d = new Date(Date.UTC(anchorYear, anchorMonth - 1 + offset, 15));
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const key = `${year}-${month}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const period = resolveStatementPeriodForGenerate(card, year, month);
    if (period.due >= dueFrom && period.due <= dueTo) {
      out.push({ year, month });
    }
  }
  return out;
}

type DebtBucketsInput = {
  carryOverBase: number;
  paidUntilCurrentClosing: number;
  spentUntilCurrentClosing: number;
  spentUntilNextClosing: number;
  cycleOpen: boolean;
};

export function computeDebtBuckets(input: DebtBucketsInput): {
  pendingMonthDebt: number;
  pendingMonthCredit: number;
  nextMonthDebt: number;
} {
  const carryOverDebt = round2(Math.max(input.carryOverBase - input.paidUntilCurrentClosing, 0));
  const pendingMonthCredit = round2(Math.max(input.paidUntilCurrentClosing - input.carryOverBase, 0));

  // When the cycle is still open, "A pagar" should already include
  // charges accumulated up to the current closing date.
  // "Ya llevas gastado" must reflect current-cycle spend to date.
  if (input.cycleOpen) {
    const result = {
      pendingMonthDebt: carryOverDebt,
      pendingMonthCredit,
      nextMonthDebt: round2(Math.max(input.spentUntilCurrentClosing, 0)),
    };
    return result;
  }

  const result = {
    pendingMonthDebt: carryOverDebt,
    pendingMonthCredit,
    nextMonthDebt: round2(
      Math.max(carryOverDebt + input.spentUntilCurrentClosing - pendingMonthCredit, 0),
    ),
  };
  return result;
}

function dateWithClampedDayUTC(year: number, monthIndex: number, day: number): Date {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const lastDay = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, lastDay)),
  );
}

function addDaysUTC(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T12:00:00.000Z`);
  return !Number.isNaN(t);
}

function projectPendingInstallmentToNextCardDueDate(
  dueDay: number | null | undefined,
  reference: Date = new Date(),
): string {
  const dueDaySafe =
    Number.isInteger(dueDay) && Number(dueDay) >= 1 && Number(dueDay) <= 31 ? Number(dueDay) : 10;
  const year = reference.getUTCFullYear();
  const month = reference.getUTCMonth();
  const thisMonthDue = dateWithClampedDayUTC(year, month, dueDaySafe);
  const referenceDayStart = Date.UTC(
    reference.getUTCFullYear(),
    reference.getUTCMonth(),
    reference.getUTCDate(),
  );
  const thisMonthDueStart = Date.UTC(
    thisMonthDue.getUTCFullYear(),
    thisMonthDue.getUTCMonth(),
    thisMonthDue.getUTCDate(),
  );
  const effectiveDue =
    referenceDayStart <= thisMonthDueStart ?
      thisMonthDue
    : dateWithClampedDayUTC(year, month + 1, dueDaySafe);
  return toIsoDate(effectiveDue);
}
