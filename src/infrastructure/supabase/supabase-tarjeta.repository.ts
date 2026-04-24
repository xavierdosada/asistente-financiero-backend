import { Injectable } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  CreditCardsTotalDebtSummary,
  CardStatementDetail,
  CardStatementLineRow,
  CardStatementRow,
  CardPendingInstallmentRow,
  CardPendingInstallmentsResult,
  CardSpendRangeSummary,
  CreateTarjetaInput,
  SetInitialCardDebtInput,
  TarjetaDebtInstallmentRow,
  TarjetaDebtRow,
  TarjetaRepositoryPort,
  TarjetaRow,
  TarjetaUsageSummary,
  UpdateTarjetaInput,
  defaultCardName,
  isTypeCard,
} from '../../domain/ports/tarjeta-repository.port';
import type { EntryScope } from '../../domain/ports/entry-mode.port';

@Injectable()
export class SupabaseTarjetaRepository implements TarjetaRepositoryPort {
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
    if (!card) return null;

    const current = monthRange(today, 0);
    const next = monthRange(today, 1);

    const [spentCurrent, spentNext, statementDebt, cycleWindows] = await Promise.all([
      this.sumCardSpendByPeriod(id, current.from, current.to, scope),
      this.sumCardSpendByPeriod(id, next.from, next.to, scope),
      this.getStatementDebtDueUntil(id, current.to),
      this.resolveCycleWindows(card, today),
    ]);

    const creditLimit = card.credit_limit;
    // "Deuda próximo mes" debe incluir lo consumido en el ciclo vigente
    // (hasta el cierre inclusive), no el ciclo siguiente.
    const [spentUntilCurrentClosing, paidUntilCurrentClosing, previousCycleDebt] = await Promise.all([
      this.sumCardProjectedDebtByPeriod(id, cycleWindows.current.from, cycleWindows.current.to, scope),
      this.sumCardPaymentsByPeriod(id, cycleWindows.current.from, cycleWindows.current.to, scope),
      !statementDebt.hasDueStatements && cycleWindows.previous ?
        this.sumCardProjectedDebtByPeriod(id, cycleWindows.previous.from, cycleWindows.previous.to, scope)
      : Promise.resolve(0),
    ]);
    const carryOverBase =
      statementDebt.hasDueStatements ? statementDebt.outstandingAmount : previousCycleDebt;
    const carryOverDebt = round2(Math.max(carryOverBase - paidUntilCurrentClosing, 0));
    const pendingMonthCredit = round2(Math.max(paidUntilCurrentClosing - carryOverBase, 0));
    const nextMonthDebt = round2(
      Math.max(carryOverDebt + spentUntilCurrentClosing - pendingMonthCredit, 0),
    );

    return {
      card_id: card.id,
      month_current: current.label,
      month_next: next.label,
      spent_current: spentCurrent,
      spent_next: spentNext,
      pending_month_debt: carryOverDebt,
      pending_month_credit: pendingMonthCredit,
      next_month_debt: nextMonthDebt,
      credit_limit: creditLimit,
      available_current: creditLimit === null ? null : round2(creditLimit - spentCurrent),
      available_next: creditLimit === null ? null : round2(creditLimit - spentNext),
    };
  }

  async generateMonthlyStatement(
    cardId: string,
    year: number,
    month: number,
  ): Promise<CardStatementDetail | null> {
    const card = await this.findById(cardId);
    if (!card) return null;
    if (month < 1 || month > 12) throw new Error('month debe estar entre 1 y 12');

    const period = monthRangeByYearMonth(year, month, card.due_day ?? 10);

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
      .select('id, detail, amount, currency, fx_ars_per_usd')
      .eq('user_id', this.userId)
      .eq('status', 'active')
      .eq('card_id', cardId)
      .eq('direction', 'gasto')
      .eq('payment_method', 'tarjeta')
      .eq('entry_mode', 'operativo')
      .gte('movement_date', period.from)
      .lte('movement_date', period.to);
    if (movementsError) throw new Error(movementsError.message);

    for (const movement of (movements ?? []) as Array<{
      id: string;
      detail: string;
      amount: number | string;
      currency?: string | null;
      fx_ars_per_usd?: number | string | null;
    }>) {
      const { data: existingLine, error: existingLineError } = await this.client
        .from('card_statement_lines')
        .select('id')
        .eq('movement_id', movement.id)
        .maybeSingle();
      if (existingLineError) throw new Error(existingLineError.message);
      if (existingLine) continue;

      const { error: lineError } = await this.client.from('card_statement_lines').insert({
        statement_id: statement.id,
        source_type: 'movement',
        movement_id: movement.id,
        installment_id: null,
        detail: movement.detail || 'Consumo tarjeta',
        amount: effectiveMovementArsAmount(movement),
      });
      if (lineError) throw new Error(lineError.message);
    }

    const { data: installments, error: installmentsError } = await this.client
      .from('card_debt_installments')
      .select(
        'id, debt_id, installment_number, amount, due_date, statement_id, card_installment_debts!inner(description, card_id, user_id)',
      )
      .is('statement_id', null)
      .gte('due_date', period.from)
      .lte('due_date', period.to);
    if (installmentsError) throw new Error(installmentsError.message);

    for (const installment of (installments ?? []) as Array<{
      id: string;
      debt_id: string;
      installment_number: number;
      amount: number | string;
      due_date: string;
      statement_id: string | null;
      card_installment_debts:
        | { description: string; card_id: string; user_id: string }
        | Array<{ description: string; card_id: string; user_id: string }>;
    }>) {
      const debtRef =
        Array.isArray(installment.card_installment_debts) ?
          installment.card_installment_debts[0]
        : installment.card_installment_debts;
      if (!debtRef) continue;
      if (debtRef.user_id !== this.userId) continue;
      if (debtRef.card_id !== cardId) continue;

      const { error: lineError } = await this.client.from('card_statement_lines').insert({
        statement_id: statement.id,
        source_type: 'installment',
        movement_id: null,
        installment_id: installment.id,
        detail: `${debtRef.description} - cuota ${installment.installment_number}`,
        amount: Number(installment.amount),
      });
      if (lineError) throw new Error(lineError.message);

      const { error: updateInstallmentError } = await this.client
        .from('card_debt_installments')
        .update({ statement_id: statement.id, included_at: new Date().toISOString() })
        .eq('id', installment.id);
      if (updateInstallmentError) throw new Error(updateInstallmentError.message);
    }

    const { data: lines, error: linesError } = await this.client
      .from('card_statement_lines')
      .select('amount')
      .eq('statement_id', statement.id);
    if (linesError) throw new Error(linesError.message);

    const totalAmount = round2(
      (lines ?? []).reduce((acc, row: { amount: number | string }) => acc + Number(row.amount), 0),
    );

    const paidAmount = statement.paid_amount;
    const outstandingAmount = round2(Math.max(totalAmount - paidAmount, 0));
    const status = outstandingAmount === 0 ? 'pagado' : 'cerrado';

    const { data: updated, error: updateStatementError } = await this.client
      .from('card_statements')
      .update({
        total_amount: totalAmount,
        outstanding_amount: outstandingAmount,
        status,
      })
      .eq('id', statement.id)
      .eq('user_id', this.userId)
      .select(
        'id, card_id, period_year, period_month, opened_at, closed_at, due_date, total_amount, paid_amount, outstanding_amount, status',
      )
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
      .select(
        'id, card_id, period_year, period_month, opened_at, closed_at, due_date, total_amount, paid_amount, outstanding_amount, status',
      )
      .eq('user_id', this.userId)
      .eq('card_id', id)
      .order('period_year', { ascending: false })
      .order('period_month', { ascending: false });
    if (error) throw new Error(error.message);

    return (data ?? []).map(mapStatementRow);
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

    const byMonthMap = new Map<string, number>();
    let total = 0;
    for (const row of (data ?? []) as Array<{
      amount: number | string;
      currency?: string | null;
      fx_ars_per_usd?: number | string | null;
      movement_date: string;
    }>) {
      const amount = effectiveMovementArsAmount(row);
      if (!Number.isFinite(amount)) continue;
      total += amount;
      const month = String(row.movement_date).slice(0, 7);
      byMonthMap.set(month, round2((byMonthMap.get(month) ?? 0) + amount));
    }

    const by_month = Array.from(byMonthMap.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([month, amount]) => ({ month, amount }));

    return {
      card_id: cardId,
      from,
      to,
      scope,
      total_spent: round2(total),
      movements_count: (data ?? []).length,
      by_month,
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
        'id, debt_id, installment_number, due_date, amount, paid_amount, status, card_installment_debts!inner(description, card_id, user_id, status, total_installments)',
      )
      .neq('status', 'pagada')
      .eq('card_installment_debts.card_id', id)
      .eq('card_installment_debts.user_id', this.userId)
      .order('due_date', { ascending: true })
      .order('installment_number', { ascending: true });
    console.log('[tarjetas.repo cuotas-pendientes] supabase raw', {
      card_id: id,
      error: error?.message ?? null,
      data_type: data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data,
    });
    if (error) throw new Error(error.message);

    const rowsRaw = data ?? [];
    const rowsList = Array.isArray(rowsRaw) ? rowsRaw : [];
    if (!Array.isArray(rowsRaw)) {
      console.log('[tarjetas.repo cuotas-pendientes] data no es array; se usa []', rowsRaw);
    }

    const installments: CardPendingInstallmentRow[] = [];
    for (const row of rowsList as Array<{
      id: string;
      debt_id: string;
      installment_number: number;
      due_date: string;
      amount: number | string;
      paid_amount: number | string;
      status: string;
      card_installment_debts:
        | {
            description: string;
            card_id: string;
            user_id: string;
            status: string;
            total_installments: number;
          }
        | Array<{
            description: string;
            card_id: string;
            user_id: string;
            status: string;
            total_installments: number;
          }>;
    }>) {
      const debtRef =
        Array.isArray(row.card_installment_debts) ?
          row.card_installment_debts[0]
        : row.card_installment_debts;
      if (!debtRef) continue;
      if (debtRef.user_id !== this.userId) continue;
      if (debtRef.card_id !== id) continue;
      if (debtRef.status === 'pagada' || debtRef.status === 'cancelada') continue;

      const amount = Number(row.amount);
      const paidAmount = Number(row.paid_amount);
      const remaining = round2(Math.max(amount - paidAmount, 0));
      if (remaining <= 0) continue;

      installments.push({
        debt_id: row.debt_id,
        debt_description: debtRef.description,
        debt_total_installments: Number(debtRef.total_installments),
        installment_id: row.id,
        installment_number: Number(row.installment_number),
        due_date: row.due_date,
        amount,
        paid_amount: paidAmount,
        remaining_amount: remaining,
        status: normalizeCardInstallmentStatus(row.status),
      });
    }

    const total_remaining_amount = round2(
      installments.reduce((s, r) => s + r.remaining_amount, 0),
    );
    return {
      pending_count: installments.length,
      total_remaining_amount,
      installments,
    };
  }

  async getStatementById(cardId: string, statementId: string): Promise<CardStatementDetail | null> {
    const card = await this.findById(cardId);
    if (!card) return null;

    const { data: statement, error: statementError } = await this.client
      .from('card_statements')
      .select(
        'id, card_id, period_year, period_month, opened_at, closed_at, due_date, total_amount, paid_amount, outstanding_amount, status',
      )
      .eq('id', statementId)
      .eq('user_id', this.userId)
      .eq('card_id', cardId)
      .maybeSingle();
    if (statementError) throw new Error(statementError.message);
    if (!statement) return null;

    const { data: lines, error: linesError } = await this.client
      .from('card_statement_lines')
      .select('id, source_type, movement_id, installment_id, detail, amount')
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
    }>;
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

    return {
      ...mapStatementRow(statement),
      lines: lineRows.map((line) =>
        mapStatementLineRow(
          line,
          line.installment_id ? installmentMetaById.get(line.installment_id) : undefined,
        ),
      ),
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

    const { data, error } = await this.client
      .from('card_statements')
      .upsert(
        {
          user_id: this.userId,
          card_id: cardId,
          period_year: input.year,
          period_month: input.month,
          opened_at: period.from,
          closed_at: period.to,
          due_date: dueDate,
          total_amount: rounded,
          paid_amount: 0,
          outstanding_amount: rounded,
          minimum_payment: 0,
          interest_amount: 0,
          status,
        },
        { onConflict: 'card_id,period_year,period_month' },
      )
      .select(
        'id, card_id, period_year, period_month, opened_at, closed_at, due_date, total_amount, paid_amount, outstanding_amount, status',
      )
      .single();

    if (error) throw new Error(error.message);
    if (!data) throw new Error('No se pudo guardar deuda inicial de tarjeta');
    return mapStatementRow(data);
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

  private async sumCardSpendByPeriod(
    cardId: string,
    fromDate: string,
    toDate: string,
    scope: EntryScope,
  ): Promise<number> {
    let query = this.client
      .from('movements')
      .select('amount, currency, fx_ars_per_usd')
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
    const total = (data ?? []).reduce(
      (
        acc,
        row: { amount: number | string; currency?: string | null; fx_ars_per_usd?: number | string | null },
      ) => acc + effectiveMovementArsAmount(row),
      0,
    );
    return round2(total);
  }

  private async sumCardPaymentsByPeriod(
    cardId: string,
    fromDate: string,
    toDate: string,
    scope: EntryScope,
  ): Promise<number> {
    let query = this.client
      .from('movements')
      .select('amount')
      .eq('user_id', this.userId)
      .eq('status', 'active')
      .eq('settled_card_id', cardId)
      .eq('direction', 'gasto')
      .gte('movement_date', fromDate)
      .lte('movement_date', toDate);

    if (scope === 'operativo' || scope === 'historico') {
      query = query.eq('entry_mode', scope);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const total = (data ?? []).reduce((acc, row: { amount: number | string }) => {
      const n = Number(row.amount);
      return Number.isFinite(n) ? acc + n : acc;
    }, 0);
    return round2(total);
  }

  private async sumCardProjectedDebtByPeriod(
    cardId: string,
    fromDate: string,
    toDate: string,
    scope: EntryScope,
  ): Promise<number> {
    let query = this.client
      .from('movements')
      .select('amount, currency, fx_ars_per_usd, installments_total')
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

    const total = (data ?? []).reduce(
      (
        acc,
        row: {
          amount: number | string;
          currency?: string | null;
          fx_ars_per_usd?: number | string | null;
          installments_total: number | null;
        },
      ) => {
        const effective = effectiveMovementArsAmount(row);
        if (!Number.isFinite(effective) || effective <= 0) return acc;
        const installmentsTotal =
          typeof row.installments_total === 'number' &&
          Number.isFinite(row.installments_total) &&
          row.installments_total > 1 ?
            row.installments_total
          : 1;
        return acc + effective / installmentsTotal;
      },
      0,
    );

    return round2(total);
  }

  private async getStatementDebtDueUntil(
    cardId: string,
    toDueDateInclusive: string,
  ): Promise<{ hasDueStatements: boolean; outstandingAmount: number }> {
    const { data, error } = await this.client
      .from('card_statements')
      .select('outstanding_amount, status, due_date')
      .eq('user_id', this.userId)
      .eq('card_id', cardId)
      .lte('due_date', toDueDateInclusive)
      .in('status', ['abierto', 'cerrado', 'vencido', 'pagado']);
    if (error) throw new Error(error.message);

    const total = (data ?? []).reduce((acc, row: { outstanding_amount: number | string }) => {
      const n = Number(row.outstanding_amount);
      return Number.isFinite(n) ? acc + Math.max(n, 0) : acc;
    }, 0);
    return {
      hasDueStatements: (data ?? []).length > 0,
      outstandingAmount: round2(total),
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
    const currentWindow = currentStmt ?? cycleByClosingDay?.current ?? { from: current.from, to: current.to };
    const nextWindow = nextStmt ?? {
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
      .select(
        'id, card_id, period_year, period_month, opened_at, closed_at, due_date, total_amount, paid_amount, outstanding_amount, status',
      )
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
        minimum_payment: 0,
        interest_amount: 0,
        paid_amount: 0,
        outstanding_amount: 0,
        status: 'abierto',
      })
      .select(
        'id, card_id, period_year, period_month, opened_at, closed_at, due_date, total_amount, paid_amount, outstanding_amount, status',
      )
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
  paid_amount: number | string;
  outstanding_amount: number | string;
  status: string;
}): CardStatementRow {
  return {
    id: row.id,
    card_id: row.card_id,
    period_year: Number(row.period_year),
    period_month: Number(row.period_month),
    opened_at: row.opened_at,
    closed_at: row.closed_at,
    due_date: row.due_date,
    total_amount: Number(row.total_amount),
    paid_amount: Number(row.paid_amount),
    outstanding_amount: Number(row.outstanding_amount),
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
}, installmentMeta?: {
  installment_number: number;
  total_installments: number;
}): CardStatementLineRow {
  return {
    id: row.id,
    source_type: row.source_type === 'installment' ? 'installment' : 'movement',
    movement_id: row.movement_id,
    installment_id: row.installment_id,
    detail: row.detail,
    amount: Number(row.amount),
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

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Monto en ARS para consumos de tarjeta (USD con FX guardado; sin FX no suma). */
function effectiveMovementArsAmount(row: {
  amount: number | string;
  currency?: string | null;
  fx_ars_per_usd?: number | string | null;
}): number {
  const amount = Number(row.amount);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const c = String(row.currency ?? 'ARS').trim().toUpperCase();
  if (c !== 'USD') return round2(amount);
  const fx = Number(row.fx_ars_per_usd);
  if (!Number.isFinite(fx) || fx <= 0) return 0;
  return round2(amount * fx);
}

function addDaysIso(isoDate: string, days: number): string {
  const t = Date.parse(`${isoDate}T12:00:00.000Z`);
  if (Number.isNaN(t)) return isoDate;
  const d = new Date(t);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

function parseYearMonth(value: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  return { year, month };
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
