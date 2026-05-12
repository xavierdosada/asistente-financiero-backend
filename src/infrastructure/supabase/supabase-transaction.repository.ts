import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { IngresoEgreso, type InstallmentStatementImpact } from '../../domain/entities/ingreso-egreso.entity';
import { TransactionRepositoryPort } from '../../domain/ports/transaction-repository.port';
import type { AuthenticatedRequest } from '../../auth/auth.types';
import { getAuthenticatedUserId } from '../../auth/request-user.util';

@Injectable({ scope: Scope.REQUEST })
export class SupabaseTransactionRepository implements TransactionRepositoryPort {
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

    const installmentNumber = normalizeInstallmentNumber(
      row.installmentNumber,
      row.installmentsTotal,
    );
    const impact = row.installmentStatementImpact;
    const firstDueDate =
      installmentNumber > 1 && (impact === 'closed_statement' || impact === 'next_statement') ?
        addMonthsIso(
          await this.resolveTargetCloseDateForNonInitialInstallment(row.tarjetaId, impact),
          -(installmentNumber - 1),
        )
      : addMonthsIso(row.movementDate, 1);
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

  private async resolveTargetCloseDateForNonInitialInstallment(
    cardId: string,
    impact: InstallmentStatementImpact,
  ): Promise<string> {
    const today = new Date().toISOString().slice(0, 10);
    const { data: currentPayable, error } = await this.client
      .from('card_statements')
      .select('closed_at, due_date')
      .eq('user_id', this.userId)
      .eq('card_id', cardId)
      .in('status', ['cerrado', 'vencido'])
      .gte('due_date', today)
      .order('due_date', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);

    if (currentPayable?.closed_at) {
      const closedAt = String(currentPayable.closed_at).slice(0, 10);
      return impact === 'closed_statement' ? closedAt : addMonthsIso(closedAt, 1);
    }

    const { data: latestClosed, error: latestError } = await this.client
      .from('card_statements')
      .select('closed_at')
      .eq('user_id', this.userId)
      .eq('card_id', cardId)
      .in('status', ['cerrado', 'vencido'])
      .lte('closed_at', today)
      .order('closed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestError) throw new Error(latestError.message);
    if (latestClosed?.closed_at) {
      const closedAt = String(latestClosed.closed_at).slice(0, 10);
      return impact === 'closed_statement' ? closedAt : addMonthsIso(closedAt, 1);
    }

    return computeFallbackTargetCloseDateForNonInitialInstallment(impact);
  }
}

/**
 * Fallback sin resumen creado: ancla al fin de mes calendario actual o al siguiente.
 */
function computeFallbackTargetCloseDateForNonInitialInstallment(
  impact: InstallmentStatementImpact,
): string {
  const today = new Date();
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1;
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDayOfMonth = (year: number, month1to12: number) =>
    new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
  const endOfMonthIso = (year: number, month1to12: number) => {
    const d = lastDayOfMonth(year, month1to12);
    return `${year}-${pad(month1to12)}-${pad(d)}`;
  };
  let ty = y;
  let tm = m;
  if (impact === 'next_statement') {
    if (tm === 12) {
      ty += 1;
      tm = 1;
    } else {
      tm += 1;
    }
  }
  return endOfMonthIso(ty, tm);
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
