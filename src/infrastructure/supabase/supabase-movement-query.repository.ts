import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { EntryMode } from '../../domain/ports/entry-mode.port';
import type { AuthenticatedRequest } from '../../auth/auth.types';
import { getAuthenticatedUserId } from '../../auth/request-user.util';

export type ListMovementsInput = {
  limit: number;
  entryMode?: EntryMode;
  from?: string;
  to?: string;
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

  async listRecent(input: ListMovementsInput): Promise<MovementListItem[]> {
    let query = this.client
      .from('movements')
      .select(
        'id, direction, amount, currency, detail, payment_method, movement_date, entry_mode, category_id, card_id, loan_id, settled_card_id, installments_total, installment_number, created_at, fx_ars_per_usd',
      )
      .eq('user_id', this.userId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(input.limit);

    if (input.entryMode) {
      query = query.eq('entry_mode', input.entryMode);
    }
    if (input.from) {
      query = query.gte('movement_date', input.from);
    }
    if (input.to) {
      query = query.lte('movement_date', input.to);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return (data ?? []).map((row: {
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
    patch: { category_id?: string | null; detail?: string },
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

    const updatePayload: {
      category_id?: string | null;
      detail?: string;
    } = {};
    if (patch.category_id !== undefined) updatePayload.category_id = patch.category_id;
    if (patch.detail !== undefined) updatePayload.detail = patch.detail;

    const { data, error } = await this.client
      .from('movements')
      .update(updatePayload)
      .eq('id', id)
      .eq('user_id', this.userId)
      .eq('status', 'active')
      .select('id, category_id, detail')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;

    return {
      id: data.id,
      category_id: data.category_id,
      detail: data.detail,
    };
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
      .select('statement_id, applied_amount')
      .eq('payment_id', payment.id);
    if (allocsError) throw new Error(allocsError.message);

    const touchedStatements = new Set<string>();
    for (const alloc of (allocs ?? []) as Array<{
      statement_id: string;
      applied_amount: number | string;
    }>) {
      touchedStatements.add(alloc.statement_id);
      const { data: st, error: stError } = await this.client
        .from('card_statements')
        .select('total_amount, paid_amount')
        .eq('id', alloc.statement_id)
        .eq('user_id', this.userId)
        .maybeSingle();
      if (stError) throw new Error(stError.message);
      if (!st) continue;

      const nextPaid = Math.max(Number(st.paid_amount) - Number(alloc.applied_amount), 0);
      const total = Number(st.total_amount);
      const outstanding = Math.max(total - nextPaid, 0);
      const nextStatus = outstanding === 0 ? 'pagado' : 'cerrado';

      const { error: updateStError } = await this.client
        .from('card_statements')
        .update({
          paid_amount: round2(nextPaid),
          outstanding_amount: round2(outstanding),
          status: nextStatus,
        })
        .eq('id', alloc.statement_id)
        .eq('user_id', this.userId);
      if (updateStError) throw new Error(updateStError.message);
    }

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
      .select('id, paid_amount')
      .eq('id', statementId)
      .eq('user_id', this.userId)
      .maybeSingle();
    if (statementError) throw new Error(statementError.message);
    if (!statement) return;

    const { data: lines, error: linesError } = await this.client
      .from('card_statement_lines')
      .select('amount')
      .eq('statement_id', statementId);
    if (linesError) throw new Error(linesError.message);

    const total = round2(
      (lines ?? []).reduce(
        (acc, row: { amount: number | string }) => acc + Number(row.amount),
        0,
      ),
    );
    const paid = round2(Number(statement.paid_amount));
    const outstanding = round2(Math.max(total - paid, 0));
    const status = outstanding === 0 ? 'pagado' : 'cerrado';

    const { error: updateError } = await this.client
      .from('card_statements')
      .update({
        total_amount: total,
        outstanding_amount: outstanding,
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
