import { Injectable } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  CreateLoanInput,
  LoanInstallmentRow,
  LoanRepositoryPort,
  LoanRow,
  UpdateLoanInput,
  isLoanStatus,
} from '../../domain/ports/loan-repository.port';

@Injectable()
export class SupabaseLoanRepository implements LoanRepositoryPort {
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

    return (data ?? []).map((row: {
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
    const outstanding =
      input.outstanding_amount === undefined
        ? input.installment_amount * (input.total_installments - installmentsPaid)
        : input.outstanding_amount;
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
    const patch: Record<string, unknown> = {};
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
      patch.installment_amount = round2(input.installment_amount);
    }
    if (input.outstanding_amount !== undefined) {
      validateNonNegative(input.outstanding_amount, 'outstanding_amount');
      patch.outstanding_amount = round2(input.outstanding_amount);
    }
    if (input.total_installments !== undefined) {
      validatePositiveInt(input.total_installments, 'total_installments');
      patch.total_installments = input.total_installments;
    }
    if (input.installments_paid !== undefined) {
      validateNonNegativeInt(input.installments_paid, 'installments_paid');
      patch.installments_paid = input.installments_paid;
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
