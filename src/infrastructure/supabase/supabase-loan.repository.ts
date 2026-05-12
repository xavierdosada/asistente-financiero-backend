import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  CreateLoanInput,
  LoanCurrentMonthInstallmentUpdateRow,
  LoanInstallmentRow,
  LoanPaymentRow,
  LoanRepositoryPort,
  LoanRow,
  UpdateLoanInput,
  isLoanStatus,
} from '../../domain/ports/loan-repository.port';
import type { AuthenticatedRequest } from '../../auth/auth.types';
import { getAuthenticatedUserId } from '../../auth/request-user.util';

@Injectable({ scope: Scope.REQUEST })
export class SupabaseLoanRepository implements LoanRepositoryPort {
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

  async list(): Promise<LoanRow[]> {
    const { data, error } = await this.client
      .from('loans')
      .select(
        'id, name, lender, currency, principal_amount, installment_amount, outstanding_amount, total_installments, installments_paid, first_due_date, status, annual_rate, notes',
      )
      .eq('user_id', this.userId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map(mapLoanRow);
  }

  async findById(id: string): Promise<LoanRow | null> {
    const { data, error } = await this.client
      .from('loans')
      .select(
        'id, name, lender, currency, principal_amount, installment_amount, outstanding_amount, total_installments, installments_paid, first_due_date, status, annual_rate, notes',
      )
      .eq('id', id)
      .eq('user_id', this.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? mapLoanRow(data) : null;
  }

  async installmentsByLoanId(id: string): Promise<LoanInstallmentRow[] | null> {
    const loan = await this.findById(id);
    if (!loan) return null;

    const { data, error } = await this.client
      .from('loan_installments')
      .select('id, loan_id, installment_number, due_date, amount, paid_amount, status, paid_at')
      .eq('loan_id', id)
      .order('installment_number', { ascending: true });
    if (error) throw new Error(error.message);

    const mapped = (data ?? []).map((row: {
      id: string;
      loan_id: string;
      installment_number: number;
      due_date: string;
      amount: number | string;
      paid_amount: number | string;
      status: string;
      paid_at: string | null;
    }) => ({
      id: row.id,
      loan_id: row.loan_id,
      installment_number: Number(row.installment_number),
      due_date: row.due_date,
      amount: Number(row.amount),
      paid_amount: Number(row.paid_amount),
      status: normalizeInstallmentStatus(row.status),
      paid_at: row.paid_at,
    }));
    return mapped;
  }

  async listPayments(loanId?: string): Promise<LoanPaymentRow[]> {
    let query = this.client
      .from('loan_payment_events')
      .select(
        'id, loan_id, movement_id, amount, payment_date, created_at, loans!inner(name), movements!inner(id, detail, currency, movement_date)',
      )
      .eq('user_id', this.userId)
      .order('payment_date', { ascending: false })
      .order('created_at', { ascending: false });
    if (loanId) {
      query = query.eq('loan_id', loanId);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return (data ?? []).map(mapLoanPaymentRow);
  }

  async updateCurrentMonthInstallment(
    loanId: string,
    amount: number,
  ): Promise<LoanCurrentMonthInstallmentUpdateRow | null> {
    const loan = await this.findById(loanId);
    if (!loan) return null;
    validatePositive(amount, 'amount');

    const { monthStart, monthEnd, today } = currentMonthRange();
    const { data: installment, error: installmentError } = await this.client
      .from('loan_installments')
      .select('id, loan_id, installment_number, due_date, amount, paid_amount, status, paid_at')
      .eq('loan_id', loanId)
      .gte('due_date', monthStart)
      .lte('due_date', monthEnd)
      .order('due_date', { ascending: true })
      .order('installment_number', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (installmentError) throw new Error(installmentError.message);
    if (!installment) {
      throw new Error('current_month_installment_not_found');
    }

    const paidAmount = Number(installment.paid_amount ?? 0);
    if (amount < paidAmount) {
      throw new Error('amount_below_paid_amount');
    }

    const nextStatus = resolveInstallmentStatus({
      dueDate: String(installment.due_date),
      paidAmount,
      amount,
      today,
    });
    const { error: updateError } = await this.client
      .from('loan_installments')
      .update({
        amount: round2(amount),
        status: nextStatus,
        paid_at: nextStatus === 'pagada' ? installment.paid_at : null,
      })
      .eq('id', String(installment.id))
      .eq('loan_id', loanId);
    if (updateError) throw new Error(updateError.message);

    await this.recalcLoan(loanId);

    const refreshedLoan = await this.findById(loanId);
    const { data: refreshedInstallment, error: refreshedInstallmentError } = await this.client
      .from('loan_installments')
      .select('id, loan_id, installment_number, due_date, amount, paid_amount, status, paid_at')
      .eq('id', String(installment.id))
      .maybeSingle();
    if (refreshedInstallmentError) throw new Error(refreshedInstallmentError.message);
    if (!refreshedLoan || !refreshedInstallment) {
      throw new Error('post_update_not_found');
    }

    return {
      loan: refreshedLoan,
      installment: mapLoanInstallmentRow(refreshedInstallment),
    };
  }

  async adjustPayment(
    loanId: string,
    paymentId: string,
    patch: { amount: number; payment_date?: string },
  ): Promise<LoanPaymentRow | null> {
    validatePositive(patch.amount, 'amount');
    if (patch.payment_date !== undefined) {
      validateIsoDate(patch.payment_date, 'payment_date');
    }

    const { data: payment, error: paymentError } = await this.client
      .from('loan_payment_events')
      .select(
        'id, loan_id, movement_id, amount, payment_date, created_at, movements!inner(id, direction, currency, detail, category_id, payment_method, account_id, card_id, installments_total, installment_number, loan_id, settled_card_id, entry_mode, raw_message, fx_ars_per_usd, movement_date)',
      )
      .eq('id', paymentId)
      .eq('loan_id', loanId)
      .eq('user_id', this.userId)
      .maybeSingle();
    if (paymentError) throw new Error(paymentError.message);
    if (!payment) return null;

    const movementRaw = payment.movements as
      | Record<string, unknown>
      | Record<string, unknown>[]
      | null;
    const movement = Array.isArray(movementRaw) ? movementRaw[0] : movementRaw;
    if (!movement) throw new Error('payment_movement_not_found');
    const nextAmount = round2(patch.amount);
    const nextPaymentDate = patch.payment_date ?? String(payment.payment_date);

    if (
      nextAmount === round2(Number(payment.amount)) &&
      nextPaymentDate === String(payment.payment_date)
    ) {
      const rows = await this.listPayments(loanId);
      return rows.find((row) => row.id === paymentId) ?? null;
    }

    await this.reverseMovement(String(payment.movement_id), 'Ajuste de pago de préstamo');

    const { data: insertedMovement, error: insertMovementError } = await this.client
      .from('movements')
      .insert({
        user_id: this.userId,
        direction: movement.direction,
        currency: movement.currency,
        amount: nextAmount,
        detail: movement.detail,
        category_id: movement.category_id,
        payment_method: movement.payment_method,
        account_id: movement.account_id,
        card_id: movement.card_id,
        installments_total: movement.installments_total,
        installment_number: movement.installment_number,
        loan_id: movement.loan_id,
        settled_card_id: movement.settled_card_id,
        entry_mode: movement.entry_mode,
        movement_date: nextPaymentDate,
        raw_message: movement.raw_message,
        fx_ars_per_usd: movement.fx_ars_per_usd,
      })
      .select('id')
      .single();
    if (insertMovementError) throw new Error(insertMovementError.message);
    if (!insertedMovement?.id) throw new Error('new_movement_not_created');

    const { data: adjusted, error: adjustedError } = await this.client
      .from('loan_payment_events')
      .select(
        'id, loan_id, movement_id, amount, payment_date, created_at, loans!inner(name), movements!inner(id, detail, currency, movement_date)',
      )
      .eq('movement_id', String(insertedMovement.id))
      .eq('loan_id', loanId)
      .eq('user_id', this.userId)
      .maybeSingle();
    if (adjustedError) throw new Error(adjustedError.message);
    if (!adjusted) throw new Error('loan_payment_event_not_created');

    return mapLoanPaymentRow(adjusted);
  }

  async create(input: CreateLoanInput): Promise<LoanRow> {
    validateIsoDate(input.first_due_date, 'first_due_date');
    validatePositive(input.principal_amount, 'principal_amount');
    validatePositive(input.installment_amount, 'installment_amount');
    validatePositiveInt(input.total_installments, 'total_installments');
    const installmentsPaid = input.installments_paid ?? 0;
    validateNonNegativeInt(installmentsPaid, 'installments_paid');
    if (installmentsPaid > input.total_installments) {
      throw new Error('installments_paid no puede ser mayor a total_installments');
    }
    const outstanding = calculateDerivedOutstanding({
      installmentAmount: input.installment_amount,
      totalInstallments: input.total_installments,
      installmentsPaid,
    });
    validateNonNegative(outstanding, 'outstanding_amount');

    const currency = normalizeLoanCurrency(input.currency);

    const { data, error } = await this.client
      .from('loans')
      .insert({
        user_id: this.userId,
        name: input.name.trim(),
        lender: input.lender?.trim() || null,
        currency,
        principal_amount: round2(input.principal_amount),
        installment_amount: round2(input.installment_amount),
        outstanding_amount: round2(outstanding),
        total_installments: input.total_installments,
        installments_paid: installmentsPaid,
        first_due_date: input.first_due_date,
        annual_rate:
          input.annual_rate === undefined || input.annual_rate === null ? null : round4(input.annual_rate),
        notes: input.notes?.trim() || null,
      })
      .select(
        'id, name, lender, currency, principal_amount, installment_amount, outstanding_amount, total_installments, installments_paid, first_due_date, status, annual_rate, notes',
      )
      .single();
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Supabase returned no row');
    return mapLoanRow(data);
  }

  async update(id: string, input: UpdateLoanInput): Promise<LoanRow | null> {
    const current = await this.findById(id);
    if (!current) return null;

    const patch: Record<string, unknown> = {};
    let nextInstallmentAmount = current.installment_amount;
    let nextTotalInstallments = current.total_installments;
    let nextInstallmentsPaid = current.installments_paid;
    let recalculatesOutstanding = false;

    if (input.name !== undefined) {
      if (!input.name.trim()) throw new Error('name no puede ser vacío');
      patch.name = input.name.trim();
    }
    if (input.lender !== undefined) {
      patch.lender = input.lender?.trim() || null;
    }
    if (input.currency !== undefined) {
      patch.currency = normalizeLoanCurrency(input.currency);
    }
    if (input.principal_amount !== undefined) {
      validatePositive(input.principal_amount, 'principal_amount');
      patch.principal_amount = round2(input.principal_amount);
    }
    if (input.installment_amount !== undefined) {
      validatePositive(input.installment_amount, 'installment_amount');
      nextInstallmentAmount = input.installment_amount;
      patch.installment_amount = round2(nextInstallmentAmount);
      recalculatesOutstanding = true;
    }
    if (input.total_installments !== undefined) {
      validatePositiveInt(input.total_installments, 'total_installments');
      nextTotalInstallments = input.total_installments;
      patch.total_installments = nextTotalInstallments;
      recalculatesOutstanding = true;
    }
    if (input.installments_paid !== undefined) {
      validateNonNegativeInt(input.installments_paid, 'installments_paid');
      nextInstallmentsPaid = input.installments_paid;
      patch.installments_paid = nextInstallmentsPaid;
      recalculatesOutstanding = true;
    }
    if (nextInstallmentsPaid > nextTotalInstallments) {
      throw new Error('installments_paid no puede ser mayor a total_installments');
    }
    if (input.first_due_date !== undefined) {
      validateIsoDate(input.first_due_date, 'first_due_date');
      patch.first_due_date = input.first_due_date;
    }
    if (input.annual_rate !== undefined) {
      patch.annual_rate = input.annual_rate === null ? null : round4(input.annual_rate);
    }
    if (input.notes !== undefined) {
      patch.notes = input.notes?.trim() || null;
    }
    if (input.status !== undefined) {
      if (!isLoanStatus(input.status)) throw new Error('status inválido');
      patch.status = input.status;
    }
    if (recalculatesOutstanding) {
      const outstanding = calculateDerivedOutstanding({
        installmentAmount: nextInstallmentAmount,
        totalInstallments: nextTotalInstallments,
        installmentsPaid: nextInstallmentsPaid,
      });
      patch.outstanding_amount = round2(outstanding);
      if (input.status === undefined) {
        if (outstanding === 0) {
          patch.status = 'pagada';
        } else if (current.status === 'pagada') {
          patch.status = 'activa';
        }
      }
    }

    if (Object.keys(patch).length === 0) return this.findById(id);

    const { data, error } = await this.client
      .from('loans')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', this.userId)
      .select(
        'id, name, lender, currency, principal_amount, installment_amount, outstanding_amount, total_installments, installments_paid, first_due_date, status, annual_rate, notes',
      )
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? mapLoanRow(data) : null;
  }

  async deleteById(id: string): Promise<void> {
    const { error } = await this.client
      .from('loans')
      .delete()
      .eq('id', id)
      .eq('user_id', this.userId);
    if (error) throw new Error(error.message);
  }

  private async reverseMovement(movementId: string, reason: string): Promise<void> {
    const payload = {
      p_user_id: this.userId,
      p_movement_id: movementId,
      p_deleted_by: this.userId,
      p_reason: reason,
    };
    const { data, error } = await this.client.rpc('delete_movement_with_reversal_v1', payload);
    if (error) throw new Error(error.message);
    if (!data) throw new Error('movement_reversal_failed');
    const row = data as { deleted?: boolean; already_deleted?: boolean };
    if (!row.deleted && !row.already_deleted) {
      throw new Error('movement_reversal_failed');
    }
  }

  private async recalcLoan(loanId: string): Promise<void> {
    const { error } = await this.client.rpc('recalc_loan', { p_loan_id: loanId });
    if (error) throw new Error(error.message);
  }
}

function mapLoanRow(row: {
  id: string;
  name: string;
  lender: string | null;
  currency: string;
  principal_amount: number | string;
  installment_amount: number | string;
  outstanding_amount: number | string;
  total_installments: number;
  installments_paid: number;
  first_due_date: string;
  status: string;
  annual_rate: number | string | null;
  notes: string | null;
}): LoanRow {
  const totalInstallments = Number(row.total_installments);
  const paid = Number(row.installments_paid);
  return {
    id: row.id,
    name: row.name,
    lender: row.lender,
    currency: row.currency,
    principal_amount: Number(row.principal_amount),
    installment_amount: Number(row.installment_amount),
    outstanding_amount: Number(row.outstanding_amount),
    total_installments: totalInstallments,
    installments_paid: paid,
    installments_remaining: Math.max(totalInstallments - paid, 0),
    first_due_date: row.first_due_date,
    status: isLoanStatus(row.status) ? row.status : 'activa',
    annual_rate: row.annual_rate === null ? null : Number(row.annual_rate),
    notes: row.notes,
  };
}

function validatePositive(v: number, field: string): void {
  if (!Number.isFinite(v) || v <= 0) throw new Error(`${field} debe ser > 0`);
}
function validateNonNegative(v: number, field: string): void {
  if (!Number.isFinite(v) || v < 0) throw new Error(`${field} debe ser >= 0`);
}
function validatePositiveInt(v: number, field: string): void {
  if (!Number.isInteger(v) || v <= 0) throw new Error(`${field} debe ser entero > 0`);
}
function validateNonNegativeInt(v: number, field: string): void {
  if (!Number.isInteger(v) || v < 0) throw new Error(`${field} debe ser entero >= 0`);
}
function validateIsoDate(s: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${field} inválida`);
  const t = Date.parse(`${s}T12:00:00.000Z`);
  if (Number.isNaN(t)) throw new Error(`${field} inválida`);
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function calculateDerivedOutstanding(input: {
  installmentAmount: number;
  totalInstallments: number;
  installmentsPaid: number;
}): number {
  return input.installmentAmount * Math.max(input.totalInstallments - input.installmentsPaid, 0);
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function normalizeLoanCurrency(raw?: string): string {
  const c = (raw ?? 'ARS').trim().toUpperCase();
  if (c !== 'ARS' && c !== 'USD') {
    throw new Error('currency debe ser ARS o USD');
  }
  return c;
}

function normalizeInstallmentStatus(v: string): LoanInstallmentRow['status'] {
  return v === 'pagada' || v === 'vencida' ? v : 'pendiente';
}

function mapLoanInstallmentRow(row: {
  id: string;
  loan_id: string;
  installment_number: number;
  due_date: string;
  amount: number | string;
  paid_amount: number | string;
  status: string;
  paid_at: string | null;
}): LoanInstallmentRow {
  return {
    id: row.id,
    loan_id: row.loan_id,
    installment_number: Number(row.installment_number),
    due_date: row.due_date,
    amount: Number(row.amount),
    paid_amount: Number(row.paid_amount),
    status: normalizeInstallmentStatus(row.status),
    paid_at: row.paid_at,
  };
}

function mapLoanPaymentRow(row: Record<string, unknown>): LoanPaymentRow {
  const loan = row.loans as Record<string, unknown> | null;
  const movement = row.movements as Record<string, unknown> | null;
  return {
    id: String(row.id),
    loan_id: String(row.loan_id),
    loan_name: loan?.name ? String(loan.name) : 'Préstamo',
    movement_id: String(row.movement_id),
    amount: Number(row.amount),
    currency: movement?.currency ? String(movement.currency) : 'ARS',
    detail: movement?.detail ? String(movement.detail) : 'Pago de préstamo',
    payment_date: String(row.payment_date),
    movement_date: movement?.movement_date ? String(movement.movement_date) : String(row.payment_date),
    created_at: row.created_at ? String(row.created_at) : new Date().toISOString(),
  };
}

function currentMonthRange(now: Date = new Date()): {
  monthStart: string;
  monthEnd: string;
  today: string;
} {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const monthStart = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const monthEnd = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  return { monthStart, monthEnd, today };
}

function resolveInstallmentStatus(params: {
  dueDate: string;
  paidAmount: number;
  amount: number;
  today: string;
}): LoanInstallmentRow['status'] {
  const { dueDate, paidAmount, amount, today } = params;
  if (paidAmount >= amount) return 'pagada';
  if (dueDate < today) return 'vencida';
  return 'pendiente';
}
