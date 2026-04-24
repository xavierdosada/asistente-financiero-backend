import { Injectable } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { IngresoEgreso } from '../../domain/entities/ingreso-egreso.entity';
import { TransactionRepositoryPort } from '../../domain/ports/transaction-repository.port';

@Injectable()
export class SupabaseTransactionRepository implements TransactionRepositoryPort {
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

  async save(row: IngresoEgreso): Promise<{ id: string }> {
    const { data, error } = await this.client
      .from('movements')
      .insert({
        user_id: this.userId,
        direction: row.type,
        currency: row.currency,
        amount: row.amount,
        detail: row.detail,
        category_id: row.categoriaId,
        payment_method: row.medioPago,
        account_id: row.sourceAccountId,
        card_id: row.tarjetaId,
        installments_total: row.installmentsTotal,
        installment_number: row.installmentNumber,
        loan_id: row.loanId,
        settled_card_id: row.settledCardId,
        entry_mode: row.entryMode,
        movement_date: row.movementDate,
        raw_message: row.rawMessage,
        fx_ars_per_usd: row.fxArsPerUsd,
      })
      .select('id')
      .single();

    if (error) {
      throw new Error(error.message);
    }
    if (!data?.id) {
      throw new Error('Supabase no devolvió id');
    }

    await this.maybeCreateCardInstallmentDebt(row, data.id as string);

    return { id: data.id as string };
  }

  private async maybeCreateCardInstallmentDebt(
    row: IngresoEgreso,
    movementId: string,
  ): Promise<void> {
    if (row.entryMode !== 'operativo') return;
    if (row.type !== 'gasto') return;
    if (row.medioPago !== 'tarjeta') return;
    if (!row.tarjetaId) return;
    if (!row.installmentsTotal || row.installmentsTotal <= 1) return;

    const firstDueDate = addMonthsIso(row.movementDate, 1);
    const installmentNumber = normalizeInstallmentNumber(
      row.installmentNumber,
      row.installmentsTotal,
    );
    const installmentsPaid = Math.max(installmentNumber - 1, 0);

    const isUsdWithFx =
      row.currency.trim().toUpperCase() === 'USD' &&
      row.fxArsPerUsd !== null &&
      Number.isFinite(row.fxArsPerUsd) &&
      (row.fxArsPerUsd as number) > 0;
    const perInstallmentArs = isUsdWithFx ? round2(row.amount * (row.fxArsPerUsd as number)) : row.amount;
    // movement.amount representa el monto de UNA cuota (ver prompt del parser AI);
    // principal_amount en card_installment_debts debe ser el total financiado porque
    // el trigger SQL seed_card_debt_installments_after_insert calcula cada cuota
    // como principal_amount / total_installments.
    const principalArs = round2(perInstallmentArs * row.installmentsTotal);
    const debtCurrency = isUsdWithFx ? 'ARS' : row.currency;

    const { error } = await this.client
      .from('card_installment_debts')
      .insert({
        user_id: this.userId,
        card_id: row.tarjetaId,
        source_movement_id: movementId,
        description: row.detail,
        currency: debtCurrency,
        principal_amount: principalArs,
        outstanding_amount: principalArs,
        total_installments: row.installmentsTotal,
        installments_paid: installmentsPaid,
        first_due_date: firstDueDate,
      });

    if (!error) return;
    if (error.code === '23505') return;
    throw new Error(error.message);
  }
}

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

function normalizeInstallmentNumber(
  installmentNumber: number | null,
  installmentsTotal: number,
): number {
  if (!Number.isInteger(installmentNumber)) return 1;
  const n = installmentNumber as number;
  return Math.min(Math.max(n, 1), installmentsTotal);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
