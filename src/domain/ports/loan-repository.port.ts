export type LoanStatus = 'activa' | 'pagada' | 'cancelada' | 'mora';

export type LoanRow = {
  id: string;
  name: string;
  lender: string | null;
  currency: string;
  principal_amount: number;
  installment_amount: number;
  outstanding_amount: number;
  total_installments: number;
  installments_paid: number;
  installments_remaining: number;
  first_due_date: string;
  status: LoanStatus;
  annual_rate: number | null;
  notes: string | null;
};

export type LoanInstallmentRow = {
  id: string;
  loan_id: string;
  installment_number: number;
  due_date: string;
  amount: number;
  paid_amount: number;
  status: 'pendiente' | 'pagada' | 'vencida';
  paid_at: string | null;
};

export type CreateLoanInput = {
  name: string;
  lender?: string | null;
  currency?: string;
  principal_amount: number;
  installment_amount: number;
  outstanding_amount?: number;
  total_installments: number;
  installments_paid?: number;
  first_due_date: string;
  annual_rate?: number | null;
  notes?: string | null;
};

export type UpdateLoanInput = Partial<{
  name: string;
  lender: string | null;
  currency: string;
  principal_amount: number;
  installment_amount: number;
  outstanding_amount: number;
  total_installments: number;
  installments_paid: number;
  first_due_date: string;
  annual_rate: number | null;
  notes: string | null;
  status: LoanStatus;
}>;

export interface LoanRepositoryPort {
  list(): Promise<LoanRow[]>;
  findById(id: string): Promise<LoanRow | null>;
  installmentsByLoanId(id: string): Promise<LoanInstallmentRow[] | null>;
  create(input: CreateLoanInput): Promise<LoanRow>;
  update(id: string, input: UpdateLoanInput): Promise<LoanRow | null>;
  deleteById(id: string): Promise<void>;
}

export const LOAN_REPOSITORY = Symbol('LOAN_REPOSITORY');

export function isLoanStatus(v: string): v is LoanStatus {
  return ['activa', 'pagada', 'cancelada', 'mora'].includes(v);
}
