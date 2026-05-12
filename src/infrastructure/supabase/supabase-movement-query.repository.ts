import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { EntryMode } from '../../domain/ports/entry-mode.port';
import type { AuthenticatedRequest } from '../../auth/auth.types';
import { getAuthenticatedUserId } from '../../auth/request-user.util';
import {
  signedStatementLineAmountForTotals,
  type StatementLineMovementMeta,
} from './statement-line-credit.util';

export type ListMovementsInput = {
  limit: number;
  entryMode?: EntryMode;
  from?: string;
  to?: string;
  cursorCreatedAt?: string;
  cursorId?: string;
};

export type MovementListItem = {
  id: string;
  direction: string;
  amount: number;
  currency: string;
  detail: string;
  payment_method: string;
  movement_date: string;
  entry_mode: string;
  category_id: string | null;
  card_id: string | null;
  loan_id: string | null;
  settled_card_id: string | null;
  installments_total: number | null;
  installment_number: number | null;
  created_at: string;
  fx_ars_per_usd: number | null;
};

export type MovementsCursor = {
  created_at: string;
  id: string;
};

export type MovementListPage = {
  items: MovementListItem[];
  next_cursor: MovementsCursor | null;
  has_more: boolean;
};

export type DeleteMovementSummary = {
  deleted: boolean;
  already_deleted: boolean;
  movement_id: string;
  reversed_goal_contributions: number;
  reversed_budget_consumptions: number;
  reversed_loan_allocations: number;
  recalculated_loan_installments: number;
  reversed_movement_effects: number;
  recalculated_card_statements: number;
  /** Deudas en cuotas de tarjeta eliminadas (compra en N cuotas). */
  deleted_card_installment_debts: number;
};

export type UpdateMovementResult = {
  id: string;
  category_id: string | null;
  detail: string;
  amount: number;
};

type MovementUpdateSource = {
  id: string;
  amount: number;
  currency: string;
  direction: string;
  detail: string;
  category_id: string | null;
  payment_method: string;
  card_id: string | null;
  loan_id: string | null;
  settled_card_id: string | null;
  installments_total: number | null;
  installment_number: number | null;
  movement_date: string;
  fx_ars_per_usd: number | null;
};

@Injectable({ scope: Scope.REQUEST })
export class SupabaseMovementQueryRepository {
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

  async listRecent(input: ListMovementsInput): Promise<MovementListPage> {
    let query = this.client
      .from('movements')
      .select(
        'id, direction, amount, currency, detail, payment_method, movement_date, entry_mode, category_id, card_id, loan_id, settled_card_id, installments_total, installment_number, created_at, fx_ars_per_usd',
      )
      .eq('user_id', this.userId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(input.limit + 1);

    if (input.entryMode) {
      query = query.eq('entry_mode', input.entryMode);
    }
    if (input.from) {
      query = query.gte('movement_date', input.from);
    }
    if (input.to) {
      query = query.lte('movement_date', input.to);
    }
    if (input.cursorCreatedAt && input.cursorId) {
      query = query.or(
        `created_at.lt.${input.cursorCreatedAt},and(created_at.eq.${input.cursorCreatedAt},id.lt.${input.cursorId})`,
      );
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const mapped = (data ?? []).map((row: {
      id: string;
      direction: string;
      amount: number | string;
      currency: string;
      detail: string;
      payment_method: string;
      movement_date: string;
      entry_mode: string;
      category_id: string | null;
      card_id: string | null;
      loan_id: string | null;
      settled_card_id: string | null;
      installments_total: number | null;
      installment_number: number | null;
      created_at: string;
      fx_ars_per_usd: number | string | null;
    }) => ({
      ...row,
      amount: Number(row.amount),
      installments_total:
        row.installments_total === null ? null : Number(row.installments_total),
      installment_number:
        row.installment_number === null ? null : Number(row.installment_number),
      fx_ars_per_usd:
        row.fx_ars_per_usd === null || row.fx_ars_per_usd === undefined ?
          null
        : Number(row.fx_ars_per_usd),
    }));
    const hasMore = mapped.length > input.limit;
    const items = hasMore ? mapped.slice(0, input.limit) : mapped;
    const last = items[items.length - 1];
    return {
      items,
      next_cursor:
        hasMore && last ?
          { created_at: last.created_at, id: last.id }
        : null,
      has_more: hasMore,
    };
  }

  async deleteById(
    id: string,
    reason: string | null,
  ): Promise<DeleteMovementSummary | null> {
    const fixedExpenseInstanceIdsPaidByMovement =
      await this.findPaidFixedExpenseInstanceIdsByMovement(id);

    const payload = {
      p_user_id: this.userId,
      p_movement_id: id,
      p_deleted_by: this.userId,
      p_reason: reason,
    };

    let data: unknown = null;
    let error: { message: string } | null = null;

    ({ data, error } = await this.client.rpc(
      'delete_movement_with_reversal_v1',
      payload,
    ));

    if (error) {
      if (error.message.toLowerCase().includes('movement_not_found')) return null;
      throw new Error(error.message);
    }
    if (!data) return null;

    const row = data as {
      deleted?: boolean;
      already_deleted?: boolean;
      movement_id?: string;
      reversed_goal_contributions?: number;
      reversed_budget_consumptions?: number;
      reversed_loan_allocations?: number;
      recalculated_loan_installments?: number;
      reversed_movement_effects?: number;
      recalculated_card_statements?: number;
      deleted_card_installment_debts?: number;
    };

    const deleted = Boolean(row.deleted);
    const alreadyDeleted = Boolean(row.already_deleted);

    // La RPC en Supabase puede estar desactualizada y no borrar card_installment_debts.
    // Este paso asegura eliminar la deuda en cuotas (y cuotas en card_debt_installments en cascada)
    // creada con source_movement_id = este movimiento, más líneas de resumen vinculadas.
    if (deleted || alreadyDeleted) {
      await this.removeCardDebtBySourceMovement(id);
      await this.resetFixedExpenseInstancesToPending(fixedExpenseInstanceIdsPaidByMovement);
    }

    return {
      deleted,
      already_deleted: alreadyDeleted,
      movement_id: String(row.movement_id),
      reversed_goal_contributions: Number(row.reversed_goal_contributions ?? 0),
      reversed_budget_consumptions: Number(row.reversed_budget_consumptions ?? 0),
      reversed_loan_allocations: Number(row.reversed_loan_allocations ?? 0),
      recalculated_loan_installments: Number(
        row.recalculated_loan_installments ?? 0,
      ),
      reversed_movement_effects: Number(row.reversed_movement_effects ?? 0),
      recalculated_card_statements: Number(row.recalculated_card_statements ?? 0),
      deleted_card_installment_debts: Number(row.deleted_card_installment_debts ?? 0),
    };
  }

  async updateById(
    id: string,
    patch: { category_id?: string | null; detail?: string; amount?: number },
  ): Promise<UpdateMovementResult | null> {
    if (patch.category_id !== undefined && patch.category_id !== null) {
      const { data: category, error: categoryError } = await this.client
        .from('categories')
        .select('id')
        .eq('id', patch.category_id)
        .eq('user_id', this.userId)
        .maybeSingle();
      if (categoryError) throw new Error(categoryError.message);
      if (!category) {
        throw new Error('category_not_found');
      }
    }

    const { data: currentRaw, error: currentError } = await this.client
      .from('movements')
      .select(
        'id, amount, currency, direction, detail, category_id, payment_method, card_id, loan_id, settled_card_id, installments_total, installment_number, movement_date, fx_ars_per_usd',
      )
      .eq('id', id)
      .eq('user_id', this.userId)
      .eq('status', 'active')
      .maybeSingle();
    if (currentError) throw new Error(currentError.message);
    if (!currentRaw) return null;

    const current = mapMovementUpdateSource(currentRaw);
    const nextAmount =
      patch.amount === undefined ? current.amount : round2(patch.amount);
    const amountChanged = patch.amount !== undefined && round2(current.amount) !== nextAmount;
    if (amountChanged && (current.loan_id || current.settled_card_id)) {
      throw new Error('amount_edit_payment_not_supported');
    }

    const updatePayload: {
      category_id?: string | null;
      detail?: string;
      amount?: number;
    } = {};
    if (patch.category_id !== undefined) updatePayload.category_id = patch.category_id;
    if (patch.detail !== undefined) updatePayload.detail = patch.detail;
    if (patch.amount !== undefined) updatePayload.amount = nextAmount;

    const { data, error } = await this.client
      .from('movements')
      .update(updatePayload)
      .eq('id', id)
      .eq('user_id', this.userId)
      .eq('status', 'active')
      .select('id, category_id, detail, amount')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;

    if (amountChanged || patch.detail !== undefined) {
      await this.syncDerivedMovementDataAfterUpdate({
        ...current,
        amount: nextAmount,
        detail: patch.detail ?? current.detail,
        category_id: patch.category_id !== undefined ? patch.category_id : current.category_id,
      }, {
        amountChanged,
        detailChanged: patch.detail !== undefined && patch.detail !== current.detail,
      });
    }

    return {
      id: data.id,
      category_id: data.category_id,
      detail: data.detail,
      amount: Number(data.amount),
    };
  }

  private async syncDerivedMovementDataAfterUpdate(
    movement: MovementUpdateSource,
    changes: { amountChanged: boolean; detailChanged: boolean },
  ): Promise<void> {
    if (changes.amountChanged) {
      await this.updateDirectAmountDependents(movement);
    }
    if (changes.amountChanged || changes.detailChanged) {
      await this.updateCardStatementLineByMovement(movement, changes);
      await this.updateCardInstallmentDebtByMovement(movement, changes);
    }
  }

  private async updateDirectAmountDependents(movement: MovementUpdateSource): Promise<void> {
    const rounded = round2(movement.amount);
    const { error: effectError } = await this.client
      .from('movement_effects')
      .update({ effect_amount: rounded })
      .eq('source_movement_id', movement.id)
      .eq('user_id', this.userId)
      .eq('status', 'active');
    if (effectError) throw new Error(effectError.message);

    const { error: budgetError } = await this.client
      .from('budget_consumptions')
      .update({ amount: rounded })
      .eq('movement_id', movement.id)
      .eq('status', 'active');
    if (budgetError) throw new Error(budgetError.message);

    const { error: goalError } = await this.client
      .from('goal_contributions')
      .update({ amount: rounded })
      .eq('movement_id', movement.id)
      .eq('status', 'active');
    if (goalError) throw new Error(goalError.message);
  }

  private async updateCardStatementLineByMovement(
    movement: MovementUpdateSource,
    changes: { amountChanged: boolean; detailChanged: boolean },
  ): Promise<void> {
    const updatePayload: { amount?: number; detail?: string } = {};
    if (changes.amountChanged) updatePayload.amount = round2(movement.amount);
    if (changes.detailChanged) updatePayload.detail = movement.detail || 'Consumo tarjeta';
    if (Object.keys(updatePayload).length === 0) return;

    const { data: lines, error: linesError } = await this.client
      .from('card_statement_lines')
      .select('statement_id')
      .eq('movement_id', movement.id);
    if (linesError) throw new Error(linesError.message);

    const statementIds = new Set((lines ?? []).map((line: { statement_id: string }) => line.statement_id));
    if (statementIds.size === 0) return;

    const { error: updateError } = await this.client
      .from('card_statement_lines')
      .update(updatePayload)
      .eq('movement_id', movement.id);
    if (updateError) throw new Error(updateError.message);

    for (const statementId of statementIds) {
      await this.recomputeStatementTotals(statementId);
    }
  }

  private async updateCardInstallmentDebtByMovement(
    movement: MovementUpdateSource,
    changes: { amountChanged: boolean; detailChanged: boolean },
  ): Promise<void> {
    const { data: debt, error: debtError } = await this.client
      .from('card_installment_debts')
      .select('id, total_installments, status')
      .eq('source_movement_id', movement.id)
      .eq('user_id', this.userId)
      .maybeSingle();
    if (debtError) throw new Error(debtError.message);
    if (!debt) return;

    const debtUpdate: {
      description?: string;
      principal_amount?: number;
      outstanding_amount?: number;
      installments_paid?: number;
      status?: string;
      currency?: string;
    } = {};
    if (changes.detailChanged) debtUpdate.description = movement.detail;

    const debtId = String(debt.id);
    if (changes.amountChanged) {
      const totalInstallments = Number(debt.total_installments ?? movement.installments_total ?? 1);
      const normalizedTotal = Number.isFinite(totalInstallments) && totalInstallments > 0 ? Math.trunc(totalInstallments) : 1;
      const isUsdWithFx =
        normalizeStatementLineCurrency(movement.currency) === 'USD' &&
        movement.fx_ars_per_usd !== null &&
        Number.isFinite(movement.fx_ars_per_usd) &&
        movement.fx_ars_per_usd > 0;
      const fx = isUsdWithFx ? movement.fx_ars_per_usd as number : null;
      const installmentAmount = round2(fx !== null ? movement.amount * fx : movement.amount);
      const principalAmount = round2(installmentAmount * normalizedTotal);
      const installmentAmounts = splitInstallments(principalAmount, normalizedTotal);

      const { data: installments, error: instError } = await this.client
        .from('card_debt_installments')
        .select('id, installment_number, paid_amount, statement_id')
        .eq('debt_id', debtId);
      if (instError) throw new Error(instError.message);

      const touchedStatements = new Set<string>();
      for (const inst of (installments ?? []) as Array<{
        id: string;
        installment_number: number | string;
        paid_amount: number | string;
        statement_id: string | null;
      }>) {
        const idx = Math.max(Number(inst.installment_number) - 1, 0);
        const nextInstallmentAmount = installmentAmounts[idx] ?? installmentAmount;
        if (Number(inst.paid_amount ?? 0) > nextInstallmentAmount) {
          throw new Error('amount_below_paid_card_installment');
        }
        const status = Number(inst.paid_amount ?? 0) >= nextInstallmentAmount ? 'pagada' : 'pendiente';
        const { error: updateInstError } = await this.client
          .from('card_debt_installments')
          .update({
            amount: nextInstallmentAmount,
            status,
            ...(status === 'pendiente' ? { paid_at: null } : {}),
          })
          .eq('id', inst.id);
        if (updateInstError) throw new Error(updateInstError.message);
        const { error: updateLineError } = await this.client
          .from('card_statement_lines')
          .update({ amount: nextInstallmentAmount })
          .eq('installment_id', inst.id);
        if (updateLineError) throw new Error(updateLineError.message);
        if (inst.statement_id) touchedStatements.add(inst.statement_id);
      }

      debtUpdate.principal_amount = principalAmount;
      debtUpdate.currency = isUsdWithFx ? 'ARS' : normalizeStatementLineCurrency(movement.currency);
      const outstandingAmount = round2(
        (installments ?? []).reduce((acc: number, inst: { installment_number: number | string; paid_amount: number | string }) => {
          const idx = Math.max(Number(inst.installment_number) - 1, 0);
          const nextInstallmentAmount = installmentAmounts[idx] ?? installmentAmount;
          return acc + Math.max(nextInstallmentAmount - Number(inst.paid_amount ?? 0), 0);
        }, 0),
      );
      debtUpdate.outstanding_amount = outstandingAmount;
      debtUpdate.installments_paid = (installments ?? []).reduce(
        (acc: number, inst: { installment_number: number | string; paid_amount: number | string }) => {
          const idx = Math.max(Number(inst.installment_number) - 1, 0);
          const nextInstallmentAmount = installmentAmounts[idx] ?? installmentAmount;
          return acc + (Number(inst.paid_amount ?? 0) >= nextInstallmentAmount ? 1 : 0);
        },
        0,
      );
      debtUpdate.status =
        outstandingAmount <= 0 ? 'pagada'
        : String(debt.status) === 'pagada' ? 'abierta'
        : String(debt.status);

      for (const statementId of touchedStatements) {
        await this.recomputeStatementTotals(statementId);
      }
    }

    if (Object.keys(debtUpdate).length > 0) {
      const { error: updateDebtError } = await this.client
        .from('card_installment_debts')
        .update(debtUpdate)
        .eq('id', debtId)
        .eq('user_id', this.userId);
      if (updateDebtError) throw new Error(updateDebtError.message);
    }
  }

  private async rollbackLoanPaymentByMovement(movementId: string): Promise<void> {
    const { data: event, error: eventError } = await this.client
      .from('loan_payment_events')
      .select('id, loan_id')
      .eq('movement_id', movementId)
      .maybeSingle();
    if (eventError) throw new Error(eventError.message);
    if (!event) return;

    const { data: allocations, error: allocError } = await this.client
      .from('loan_payment_allocations')
      .select('installment_id, applied_amount')
      .eq('event_id', event.id);
    if (allocError) throw new Error(allocError.message);

    for (const alloc of (allocations ?? []) as Array<{
      installment_id: string;
      applied_amount: number | string;
    }>) {
      const { data: inst, error: instError } = await this.client
        .from('loan_installments')
        .select('amount, paid_amount')
        .eq('id', alloc.installment_id)
        .maybeSingle();
      if (instError) throw new Error(instError.message);
      if (!inst) continue;

      const nextPaid = Math.max(Number(inst.paid_amount) - Number(alloc.applied_amount), 0);
      const nextStatus = nextPaid >= Number(inst.amount) ? 'pagada' : 'pendiente';

      const { error: updateInstError } = await this.client
        .from('loan_installments')
        .update({
          paid_amount: round2(nextPaid),
          status: nextStatus,
          paid_at: nextStatus === 'pagada' ? null : null,
        })
        .eq('id', alloc.installment_id);
      if (updateInstError) throw new Error(updateInstError.message);
    }

    const { error: deleteEventError } = await this.client
      .from('loan_payment_events')
      .delete()
      .eq('id', event.id)
      .eq('user_id', this.userId);
    if (deleteEventError) throw new Error(deleteEventError.message);

    await this.recalcLoan(event.loan_id);
  }

  private async rollbackCardStatementPaymentByMovement(movementId: string): Promise<void> {
    const { data: payment, error: paymentError } = await this.client
      .from('card_statement_payments')
      .select('id')
      .eq('movement_id', movementId)
      .eq('user_id', this.userId)
      .maybeSingle();
    if (paymentError) throw new Error(paymentError.message);
    if (!payment) return;

    const { data: allocs, error: allocsError } = await this.client
      .from('card_statement_payment_allocations')
      .select('statement_id')
      .eq('payment_id', payment.id);
    if (allocsError) throw new Error(allocsError.message);

    const touchedStatements = new Set<string>(
      (allocs ?? []).map((a: { statement_id: string }) => a.statement_id),
    );

    const { error: deletePaymentError } = await this.client
      .from('card_statement_payments')
      .delete()
      .eq('id', payment.id)
      .eq('user_id', this.userId);
    if (deletePaymentError) throw new Error(deletePaymentError.message);

    for (const statementId of touchedStatements) {
      await this.recomputeStatementTotals(statementId);
    }
  }

  private async removeStatementLinesByMovement(movementId: string): Promise<void> {
    const { data: lines, error: linesError } = await this.client
      .from('card_statement_lines')
      .select('id, statement_id')
      .eq('movement_id', movementId);
    if (linesError) throw new Error(linesError.message);

    const touchedStatements = new Set<string>((lines ?? []).map((l: { statement_id: string }) => l.statement_id));

    const { error: deleteLinesError } = await this.client
      .from('card_statement_lines')
      .delete()
      .eq('movement_id', movementId);
    if (deleteLinesError) throw new Error(deleteLinesError.message);

    for (const statementId of touchedStatements) {
      await this.recomputeStatementTotals(statementId);
    }
  }

  /** Antes del borrado: FK ON DELETE SET NULL podría limpiar movement_id y perder el vínculo. */
  private async findPaidFixedExpenseInstanceIdsByMovement(
    movementId: string,
  ): Promise<string[]> {
    const { data, error } = await this.client
      .from('fixed_expense_instances')
      .select('id')
      .eq('user_id', this.userId)
      .eq('movement_id', movementId)
      .eq('status', 'pagado');
    if (error) throw new Error(error.message);
    return (data ?? []).map((row: { id: string }) => String(row.id));
  }

  private async resetFixedExpenseInstancesToPending(instanceIds: string[]): Promise<void> {
    if (instanceIds.length === 0) return;
    const { error } = await this.client
      .from('fixed_expense_instances')
      .update({
        status: 'pendiente',
        movement_id: null,
        paid_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', this.userId)
      .in('id', instanceIds);
    if (error) throw new Error(error.message);
  }

  private async removeCardDebtBySourceMovement(movementId: string): Promise<void> {
    const { data: debts, error: debtsError } = await this.client
      .from('card_installment_debts')
      .select('id')
      .eq('user_id', this.userId)
      .eq('source_movement_id', movementId);
    if (debtsError) throw new Error(debtsError.message);

    for (const debt of (debts ?? []) as Array<{ id: string }>) {
      const { data: installments, error: instError } = await this.client
        .from('card_debt_installments')
        .select('id, statement_id')
        .eq('debt_id', debt.id);
      if (instError) throw new Error(instError.message);

      const touchedStatements = new Set<string>();
      for (const inst of (installments ?? []) as Array<{ id: string; statement_id: string | null }>) {
        if (inst.statement_id) touchedStatements.add(inst.statement_id);
      }

      const installmentIds = (installments ?? []).map((i: { id: string }) => i.id);
      if (installmentIds.length > 0) {
        const { error: delLinesByInstallmentError } = await this.client
          .from('card_statement_lines')
          .delete()
          .in('installment_id', installmentIds);
        if (delLinesByInstallmentError) throw new Error(delLinesByInstallmentError.message);
      }

      const { error: deleteDebtError } = await this.client
        .from('card_installment_debts')
        .delete()
        .eq('id', debt.id)
        .eq('user_id', this.userId);
      if (deleteDebtError) throw new Error(deleteDebtError.message);

      for (const statementId of touchedStatements) {
        await this.recomputeStatementTotals(statementId);
      }
    }
  }

  private async recomputeStatementTotals(statementId: string): Promise<void> {
    const { data: statement, error: statementError } = await this.client
      .from('card_statements')
      .select('id, status, opening_carry_amount, opening_carry_amount_usd')
      .eq('id', statementId)
      .eq('user_id', this.userId)
      .maybeSingle();
    if (statementError) throw new Error(statementError.message);
    if (!statement) return;

    const { data: lines, error: linesError } = await this.client
      .from('card_statement_lines')
      .select('amount, currency, movement_id, detail')
      .eq('statement_id', statementId);
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
      const signed = signedStatementLineAmountForTotals(r, movementMetaById);
      if (signed === null) continue;
      if (normalizeStatementLineCurrency(r.currency) === 'USD') totalUsd += signed;
      else totalArs += signed;
    }
    totalArs = round2(totalArs);
    totalUsd = round2(totalUsd);
    const stRow = statement as {
      opening_carry_amount?: number | string | null;
      opening_carry_amount_usd?: number | string | null;
    };
    const carryArs = round2(Number.isFinite(Number(stRow.opening_carry_amount)) ? Number(stRow.opening_carry_amount) : 0);
    const carryUsd = round2(
      Number.isFinite(Number(stRow.opening_carry_amount_usd)) ? Number(stRow.opening_carry_amount_usd) : 0,
    );
    totalArs = round2(totalArs + carryArs);
    totalUsd = round2(totalUsd + carryUsd);

    const { data: allocs, error: allocErr } = await this.client
      .from('card_statement_payment_allocations')
      .select('applied_amount, currency')
      .eq('statement_id', statementId);
    if (allocErr) throw new Error(allocErr.message);

    let paidArs = 0;
    let paidUsd = 0;
    for (const row of allocs ?? []) {
      const r = row as { applied_amount: number | string; currency?: string | null };
      const amt = Number(r.applied_amount);
      if (!Number.isFinite(amt)) continue;
      if (normalizeStatementLineCurrency(r.currency) === 'USD') paidUsd += amt;
      else paidArs += amt;
    }
    paidArs = round2(paidArs);
    paidUsd = round2(paidUsd);

    const outstandingArs = round2(Math.max(totalArs - paidArs, 0));
    const outstandingUsd = round2(Math.max(totalUsd - paidUsd, 0));
    const prior = String((statement as { status: string }).status ?? 'cerrado');
    const statusWhenOutstanding =
      prior === 'vencido' ? 'vencido'
      : prior === 'abierto' ? 'abierto'
      : 'cerrado';
    const fullyPaid = outstandingArs <= 0 && outstandingUsd <= 0;
    const status =
      fullyPaid ? 'pagado'
      : statusWhenOutstanding === 'vencido' ? 'vencido'
      : statusWhenOutstanding === 'abierto' ? 'abierto'
      : 'cerrado';

    const { error: updateError } = await this.client
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
    if (updateError) throw new Error(updateError.message);
  }

  private async recalcLoan(loanId: string): Promise<void> {
    const { data: installments, error: installmentsError } = await this.client
      .from('loan_installments')
      .select('amount, paid_amount')
      .eq('loan_id', loanId);
    if (installmentsError) throw new Error(installmentsError.message);

    let outstanding = 0;
    let installmentsPaid = 0;
    for (const row of (installments ?? []) as Array<{ amount: number | string; paid_amount: number | string }>) {
      const amount = Number(row.amount);
      const paid = Number(row.paid_amount);
      if (paid >= amount) installmentsPaid += 1;
      outstanding += Math.max(amount - paid, 0);
    }

    const status = outstanding === 0 ? 'pagada' : 'activa';
    const { error: updateLoanError } = await this.client
      .from('loans')
      .update({
        installments_paid: installmentsPaid,
        outstanding_amount: round2(outstanding),
        status,
      })
      .eq('id', loanId)
      .eq('user_id', this.userId);
    if (updateLoanError) throw new Error(updateLoanError.message);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function normalizeStatementLineCurrency(c: string | null | undefined): 'ARS' | 'USD' {
  const u = String(c ?? 'ARS').trim().toUpperCase();
  return u === 'USD' ? 'USD' : 'ARS';
}

function mapMovementUpdateSource(row: {
  id: string;
  amount: number | string;
  currency: string;
  direction: string;
  detail: string;
  category_id: string | null;
  payment_method: string;
  card_id: string | null;
  loan_id: string | null;
  settled_card_id: string | null;
  installments_total: number | string | null;
  installment_number: number | string | null;
  movement_date: string;
  fx_ars_per_usd: number | string | null;
}): MovementUpdateSource {
  return {
    id: row.id,
    amount: Number(row.amount),
    currency: row.currency,
    direction: row.direction,
    detail: row.detail,
    category_id: row.category_id,
    payment_method: row.payment_method,
    card_id: row.card_id,
    loan_id: row.loan_id,
    settled_card_id: row.settled_card_id,
    installments_total: row.installments_total === null ? null : Number(row.installments_total),
    installment_number: row.installment_number === null ? null : Number(row.installment_number),
    movement_date: row.movement_date,
    fx_ars_per_usd: row.fx_ars_per_usd === null ? null : Number(row.fx_ars_per_usd),
  };
}

function splitInstallments(total: number, count: number): number[] {
  if (!Number.isFinite(total) || !Number.isInteger(count) || count <= 0) return [];
  const base = round2(total / count);
  const rows = Array.from({ length: count }, () => base);
  rows[count - 1] = round2(total - base * (count - 1));
  return rows;
}
