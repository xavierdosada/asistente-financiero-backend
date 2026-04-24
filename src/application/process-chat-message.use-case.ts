import { Inject, Injectable } from '@nestjs/common';
import { IngresoEgreso } from '../domain/entities/ingreso-egreso.entity';
import type { MedioPago } from '../domain/entities/ingreso-egreso.entity';
import type { EntryMode } from '../domain/ports/entry-mode.port';
import {
  AI_TRANSACTION_PARSER,
  AiTransactionParserPort,
} from '../domain/ports/ai-transaction-parser.port';
import {
  CATEGORIA_REPOSITORY,
  CategoriaRepositoryPort,
} from '../domain/ports/categoria-repository.port';
import {
  TARJETA_REPOSITORY,
  TarjetaRepositoryPort,
  type TarjetaRow,
} from '../domain/ports/tarjeta-repository.port';
import {
  LOAN_REPOSITORY,
  LoanRepositoryPort,
  type LoanRow,
} from '../domain/ports/loan-repository.port';
import {
  ACCOUNT_REPOSITORY,
  AccountRepositoryPort,
} from '../domain/ports/account-repository.port';
import {
  BUDGET_REPOSITORY,
  BudgetRepositoryPort,
} from '../domain/ports/budget-repository.port';
import {
  TRANSACTION_REPOSITORY,
  TransactionRepositoryPort,
} from '../domain/ports/transaction-repository.port';
import {
  CHAT_PREFERENCES_REPOSITORY,
  ChatPreferencesRepositoryPort,
} from '../domain/ports/chat-preferences.repository.port';
import {
  FIXED_EXPENSE_REPOSITORY,
  FixedExpenseRepositoryPort,
} from '../domain/ports/fixed-expense-repository.port';

export type ProcessChatMessageResult =
  | { saved: true; id: string; note?: string }
  | { saved: false; reason: string };

export type ProcessChatMessageOptions = {
  autoCreateCategory?: boolean;
  entryMode?: EntryMode;
  /** ARS por 1 USD para este guardado (gasto con tarjeta en USD). */
  usdArsRate?: number;
};

type CatalogRow = { id: string; nombre: string };
type LoanMatchResult =
  | { status: 'none' }
  | { status: 'single'; loan: LoanRow }
  | { status: 'ambiguous'; loans: LoanRow[] };

@Injectable()
export class ProcessChatMessageUseCase {
  constructor(
    @Inject(AI_TRANSACTION_PARSER)
    private readonly parser: AiTransactionParserPort,
    @Inject(TRANSACTION_REPOSITORY)
    private readonly repository: TransactionRepositoryPort,
    @Inject(CATEGORIA_REPOSITORY)
    private readonly categorias: CategoriaRepositoryPort,
    @Inject(TARJETA_REPOSITORY)
    private readonly tarjetas: TarjetaRepositoryPort,
    @Inject(LOAN_REPOSITORY)
    private readonly loans: LoanRepositoryPort,
    @Inject(ACCOUNT_REPOSITORY)
    private readonly accounts: AccountRepositoryPort,
    @Inject(BUDGET_REPOSITORY)
    private readonly budgets: BudgetRepositoryPort,
    @Inject(FIXED_EXPENSE_REPOSITORY)
    private readonly fixedExpenses: FixedExpenseRepositoryPort,
    @Inject(CHAT_PREFERENCES_REPOSITORY)
    private readonly chatPreferences: ChatPreferencesRepositoryPort,
  ) {}

  async execute(
    message: string,
    options: ProcessChatMessageOptions = {},
  ): Promise<ProcessChatMessageResult> {
    const trimmed = message.trim();
    if (!trimmed) {
      return { saved: false, reason: 'Mensaje vacío.' };
    }

    const categoriasCatalog = await this.categorias.list();
    if (categoriasCatalog.length === 0) {
      return {
        saved: false,
        reason:
          'No hay categorías registradas. Creá al menos una con POST /categorias.',
      };
    }

    const tarjetasCatalog = await this.tarjetas.list();
    const loansCatalog = await this.loans.list();

    const fixedMatch = await this.fixedExpenses.findBestMatch(trimmed);
    const fixedPaymentIntent = this.isFixedExpensePaymentIntent(trimmed);

    let parsed = await this.parser.parse(trimmed, {
      categorias: categoriasCatalog,
      tarjetas: tarjetasCatalog,
    });

    if (!parsed.save && fixedMatch && fixedPaymentIntent) {
      parsed = {
        save: true,
        currency: fixedMatch.currency,
        amount: fixedMatch.amount,
        type: 'gasto',
        detail: fixedMatch.name,
        categoriaNombre:
          categoriasCatalog.find((c) => c.id === fixedMatch.category_id)?.nombre ?? null,
        medioPago: fixedMatch.payment_method,
        tarjetaNombre:
          fixedMatch.payment_method === 'tarjeta' ?
            this.cardNameById(fixedMatch.card_id, tarjetasCatalog)
          : null,
        movementDate: todayIso(),
        installmentsTotal: null,
      };
    }
    if (!parsed.save) {
      return { saved: false, reason: parsed.reason };
    }

    const preferences = await this.chatPreferences.get();
    const autoCreateCategory =
      options.autoCreateCategory ?? preferences.auto_create_category_default;
    const entryMode = options.entryMode ?? preferences.default_entry_mode;
    const currencyNorm = normalizeCurrencyCode(parsed.currency);

    const categoriaId = await this.resolveOrCreateCategoryId(
      parsed.categoriaNombre,
      categoriasCatalog,
      autoCreateCategory,
    );
    if (!categoriaId) {
      return {
        saved: false,
        reason:
          'No se pudo asociar el mensaje a una categoría registrada. Revisá el nombre o agregá la categoría en POST /categorias.',
      };
    }

    const isLoanPayment = this.isLoanPayment(trimmed, parsed.detail);
    const isCardBillPayment =
      !isLoanPayment && this.isCardBillPayment(trimmed, parsed.detail);
    const medioPago: MedioPago =
      isCardBillPayment || isLoanPayment ? 'efectivo' : parsed.medioPago;

    let tarjetaId = this.resolveTarjetaId(
      medioPago,
      parsed.tarjetaNombre,
      tarjetasCatalog,
    );

    const installmentsTotal = this.resolveInstallmentsTotal(
      trimmed,
      parsed.detail,
      parsed.installmentsTotal ?? null,
      medioPago,
      parsed.type,
    );
    const installmentNumber = installmentsTotal
      ? this.resolveInstallmentNumber(trimmed, parsed.detail, installmentsTotal)
      : null;

    if (
      medioPago === 'tarjeta' &&
      !tarjetaId &&
      installmentsTotal &&
      installmentNumber
    ) {
      tarjetaId = await this.inferTarjetaIdFromInstallmentContext(
        parsed.detail,
        tarjetasCatalog,
        installmentsTotal,
        installmentNumber,
      );
    }

    const settledCardId =
      isCardBillPayment ?
        this.resolveTarjetaPagoId(
          trimmed,
          parsed.detail,
          parsed.tarjetaNombre,
          tarjetasCatalog,
        )
      : null;

    const loanMatch = isLoanPayment
      ? this.resolveLoanMatch(trimmed, parsed.detail, loansCatalog)
      : null;
    const loanId = loanMatch?.status === 'single' ? loanMatch.loan.id : null;

    if (isCardBillPayment && !settledCardId) {
      return {
        saved: false,
        reason:
          'No pude identificar qué tarjeta se está pagando. En el mensaje aclará con que tarjeta realizaste el pago.',
      };
    }

    if (medioPago === 'tarjeta' && !tarjetaId) {
      return {
        saved: false,
        reason:
          'No pude identificar la tarjeta para el gasto en cuotas. En el mensaje aclará con que tarjeta realizaste el pago.',
      };
    }

    if (isLoanPayment && loanMatch?.status === 'none') {
      return {
        saved: false,
        reason:
          'No encontré un préstamo con ese nombre. Probá con el nombre exacto o la entidad.',
      };
    }

    if (isLoanPayment && loanMatch?.status === 'ambiguous') {
      return {
        saved: false,
        reason:
          'Encontré más de un préstamo similar. Especificá mejor el nombre o la entidad.',
      };
    }

    if (medioPago === 'efectivo' && !isSupportedCashCurrency(currencyNorm)) {
      return {
        saved: false,
        reason:
          'Para caja en efectivo solo se soportan ARS y USD. Indicá una de esas monedas.',
      };
    }

    const sourceAccountId =
      medioPago === 'efectivo'
        ? (await this.accounts.getOrCreateCashAccount(currencyNorm)).id
        : null;

    const resolvedAmount = await this.resolveAmountForMovement(
      parsed.amount,
      isLoanPayment,
      loanMatch,
    );
    const amountFromFixed =
      fixedMatch && fixedPaymentIntent && parsed.amount === null ? fixedMatch.amount : null;
    const finalAmount = resolvedAmount ?? amountFromFixed;
    if (finalAmount === null) {
      return {
        saved: false,
        reason:
          'No pude determinar el monto de la cuota para ese préstamo. Revisá el préstamo o su plan de cuotas.',
      };
    }

    const fxArsPerUsd = resolveFxArsPerUsdForSave({
      type: parsed.type,
      medioPago,
      currency: currencyNorm,
      optionsUsd: options.usdArsRate,
      defaultFromProfile: preferences.default_usd_ars_rate,
    });
    if (fxArsPerUsd === 'missing') {
      return {
        saved: false,
        reason:
          'Para gastos en dólares con tarjeta necesitás indicar a cuántos pesos cotizás el USD (campo arriba o preferencia).',
      };
    }

    const entity = new IngresoEgreso(
      currencyNorm,
      finalAmount,
      parsed.type,
      parsed.detail,
      categoriaId,
      medioPago,
      tarjetaId,
      installmentsTotal,
      installmentNumber,
      loanId,
      settledCardId,
      parsed.movementDate,
      sourceAccountId,
      entryMode,
      trimmed,
      fxArsPerUsd,
    );

    if (!this.isValidEntity(entity)) {
      return {
        saved: false,
        reason: 'Datos incompletos o inválidos para guardar el movimiento.',
      };
    }

    const { id } = await this.repository.save(entity);
    if (fixedMatch && fixedPaymentIntent) {
      const month = monthStartIso(entity.movementDate);
      await this.fixedExpenses.generateInstancesForMonth(month);
      const instances = await this.fixedExpenses.listInstances(month);
      const pending = instances.find(
        (i) => i.fixed_expense_id === fixedMatch.fixed_expense_id && i.status === 'pendiente',
      );
      if (pending) {
        await this.fixedExpenses.markInstancePaid(pending.id, id);
      }
    }

    const notes: string[] = [];
    const installmentNote =
      entity.installmentsTotal && entity.installmentNumber ?
        `Se agregó el gasto de la cuota número ${entity.installmentNumber} para el próximo mes.`
      : undefined;
    if (installmentNote) notes.push(installmentNote);
    const budgetNote = await this.buildBudgetNote(entity);
    if (budgetNote) notes.push(budgetNote);
    return { saved: true, id, note: notes.length ? notes.join(' ') : undefined };
  }

  private isCardBillPayment(message: string, detail: string): boolean {
    const source = norm(`${message} ${detail}`);
    const mentionsCard = /\b(tarjeta|credito|resumen|vencimiento)\b/.test(source);
    const paymentIntent =
      /\b(pago|pague|pagar|pagamos|abono|abone|abonar|abonamos|cancelo|cancele|cancelar|cancelamos|saldo)\b/.test(
        source,
      );
    return mentionsCard && paymentIntent;
  }

  private isLoanPayment(message: string, detail: string): boolean {
    const source = norm(`${message} ${detail}`);
    const mentionsLoan =
      /\b(prestamo|pr[eé]stamo|credito personal|cuota del prestamo|cuota prestamo)\b/.test(
        source,
      );
    const paymentIntent =
      /\b(pago|pague|pagar|pagamos|abono|abone|abonar|abonamos|cancelo|cancele|cancelar|cancelamos|saldo|cuota)\b/.test(
        source,
      );
    return mentionsLoan && paymentIntent;
  }

  private isFixedExpensePaymentIntent(message: string): boolean {
    const source = norm(message);
    return /\b(pago|pague|pagar|pagamos|abono|abone|abonar|abonamos|cancelo|cancele|cancelar|cancelamos)\b/.test(
      source,
    );
  }

  private cardNameById(cardId: string | null, cards: TarjetaRow[]): string | null {
    if (!cardId) return null;
    const card = cards.find((c) => c.id === cardId);
    return card?.name ?? null;
  }

  private async buildBudgetNote(entity: IngresoEgreso): Promise<string | null> {
    if (entity.type !== 'gasto') return null;
    const progress = await this.budgets.getCategoryMonthlyProgress({
      category_id: entity.categoriaId,
      currency: entity.currency,
      month: entity.movementDate,
    });
    if (!progress) return null;
    if (progress.remaining_amount >= 0) {
      return `Te queda ${formatMoney(progress.remaining_amount)} ${progress.currency} de ${formatMoney(progress.budget_amount)} ${progress.currency} en ${progress.category_name} este mes (${formatPct(progress.used_percent)} usado).`;
    }
    return `Excediste el presupuesto de ${progress.category_name} por ${formatMoney(Math.abs(progress.remaining_amount))} ${progress.currency}.`;
  }

  private resolveCatalogId(hint: string | null, catalog: CatalogRow[]): string | null {
    const h = norm(hint ?? '');
    if (h) {
      const exact = catalog.find((c) => norm(c.nombre) === h);
      if (exact) return exact.id;
      const byInclude = catalog.find(
        (c) =>
          norm(c.nombre).includes(h) ||
          h.includes(norm(c.nombre)) ||
          norm(c.nombre).replace(/\s+/g, '') === h.replace(/\s+/g, ''),
      );
      if (byInclude) return byInclude.id;
    }
    const otros = catalog.find((c) => norm(c.nombre) === 'otros');
    if (otros) return otros.id;
    return catalog.length === 1 ? catalog[0].id : null;
  }

  private async resolveOrCreateCategoryId(
    hint: string | null,
    catalog: CatalogRow[],
    autoCreate: boolean,
  ): Promise<string | null> {
    const existing = this.resolveCatalogId(hint, catalog);
    if (existing) return existing;
    if (!autoCreate) return null;

    const normalizedHint = this.normalizeCategoryName(hint);
    if (!normalizedHint) return null;

    try {
      const created = await this.categorias.create(normalizedHint);
      return created.id;
    } catch {
      // Si hubo carrera/duplicado u otro conflicto, reintentamos resolver por catálogo actualizado.
      const freshCatalog = await this.categorias.list();
      return this.resolveCatalogId(normalizedHint, freshCatalog);
    }
  }

  private normalizeCategoryName(name: string | null): string | null {
    if (typeof name !== 'string') return null;
    const raw = name.trim().replace(/\s+/g, ' ');
    if (!raw) return null;
    return raw.slice(0, 80);
  }

  private resolveTarjetaId(
    medio: MedioPago,
    hint: string | null,
    catalog: TarjetaRow[],
  ): string | null {
    if (medio !== 'tarjeta') return null;
    const h = norm(hint ?? '');
    if (!h) {
      const activeCreditCards = catalog.filter((t) => t.type_card === 'credito');
      return activeCreditCards.length === 1 ? activeCreditCards[0].id : null;
    }
    const needles = (t: TarjetaRow): string[] => {
      const name = norm(t.name);
      const combo = norm(`${t.payment_card} ${t.bank}`);
      const combo2 = norm(`${t.bank} ${t.payment_card}`);
      return [name, combo, combo2, norm(t.bank), norm(t.payment_card)];
    };
    const exact = catalog.find((t) => needles(t).some((n) => n === h));
    if (exact) return exact.id;
    const byInclude = catalog.find((t) =>
      needles(t).some(
        (n) =>
          n.includes(h) ||
          h.includes(n) ||
          n.replace(/\s+/g, '') === h.replace(/\s+/g, ''),
      ),
    );
    if (byInclude?.id) return byInclude.id;
    const activeCreditCards = catalog.filter((t) => t.type_card === 'credito');
    return activeCreditCards.length === 1 ? activeCreditCards[0].id : null;
  }

  private resolveTarjetaPagoId(
    message: string,
    detail: string,
    hint: string | null,
    catalog: TarjetaRow[],
  ): string | null {
    const candidates = [hint ?? '', message, detail]
      .map((v) => norm(v))
      .filter(Boolean);
    if (candidates.length === 0) return null;

    const needles = (t: TarjetaRow): string[] => [
      norm(t.name),
      norm(t.bank),
      norm(t.payment_card),
      norm(`${t.payment_card} ${t.bank}`),
      norm(`${t.bank} ${t.payment_card}`),
    ];

    for (const c of candidates) {
      const exact = catalog.find((t) => needles(t).some((n) => n === c));
      if (exact) return exact.id;
    }

    for (const c of candidates) {
      const byInclude = catalog.find((t) =>
        needles(t).some(
          (n) =>
            n.includes(c) ||
            c.includes(n) ||
            n.replace(/\s+/g, '') === c.replace(/\s+/g, ''),
        ),
      );
      if (byInclude) return byInclude.id;
    }

    const activeCreditCards = catalog.filter((t) => t.type_card === 'credito');
    return activeCreditCards.length === 1 ? activeCreditCards[0].id : null;
  }

  private resolveLoanMatch(
    message: string,
    detail: string,
    catalog: LoanRow[],
  ): LoanMatchResult {
    const haystack = norm(`${message} ${detail}`);
    if (!haystack) return { status: 'none' };

    const active = catalog.filter(
      (l) => l.status !== 'pagada' && l.status !== 'cancelada',
    );
    const loans = active.length ? active : catalog;

    const score = (loan: LoanRow): number => {
      const keys = [loan.name, loan.lender ?? '']
        .map((v) => norm(v))
        .filter(Boolean);
      let s = 0;
      for (const k of keys) {
        if (haystack === k) s += 100;
        else if (haystack.includes(k)) s += 10;
        else if (k.includes(haystack)) s += 3;
      }
      return s;
    };

    const scored = loans
      .map((loan) => ({ loan, score: score(loan) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      return loans.length === 1 ? { status: 'single', loan: loans[0] } : { status: 'none' };
    }
    if (scored.length === 1) return { status: 'single', loan: scored[0].loan };
    if (scored[0].score > scored[1].score) {
      return { status: 'single', loan: scored[0].loan };
    }
    return { status: 'ambiguous', loans: scored.map((s) => s.loan) };
  }

  private async resolveAmountForMovement(
    parsedAmount: number | null,
    isLoanPayment: boolean,
    loanMatch: LoanMatchResult | null,
  ): Promise<number | null> {
    if (Number.isFinite(parsedAmount) && (parsedAmount as number) > 0) {
      return parsedAmount as number;
    }
    if (!isLoanPayment || !loanMatch || loanMatch.status !== 'single') return null;

    const installments = await this.loans.installmentsByLoanId(loanMatch.loan.id);
    if (!installments || installments.length === 0) return null;

    const pending = installments
      .filter((i) => i.status === 'pendiente')
      .sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));
    if (pending[0] && pending[0].amount > 0) return pending[0].amount;

    const overdue = installments
      .filter((i) => i.status === 'vencida')
      .sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));
    if (overdue[0] && overdue[0].amount > 0) return overdue[0].amount;

    return null;
  }

  private isValidEntity(e: IngresoEgreso): boolean {
    if (!e.currency || e.currency.length > 8) return false;
    if (!Number.isFinite(e.amount) || e.amount <= 0) return false;
    if (e.type !== 'ingreso' && e.type !== 'gasto') return false;
    if (!e.detail || e.detail.length > 2000) return false;
    if (!e.categoriaId?.trim()) return false;
    if (e.medioPago !== 'efectivo' && e.medioPago !== 'tarjeta') return false;
    if (e.medioPago === 'efectivo' && e.tarjetaId !== null) return false;
    if (e.medioPago === 'tarjeta' && !e.tarjetaId) return false;
    if (e.installmentsTotal !== null) {
      if (e.type !== 'gasto' || e.medioPago !== 'tarjeta') return false;
      if (!Number.isInteger(e.installmentsTotal) || e.installmentsTotal <= 1) return false;
      if (
        !Number.isInteger(e.installmentNumber) ||
        (e.installmentNumber as number) < 1 ||
        (e.installmentNumber as number) > e.installmentsTotal
      ) {
        return false;
      }
    }
    if (e.loanId && e.settledCardId) return false;
    if (!this.isValidIsoDate(e.movementDate)) return false;
    if (e.entryMode !== 'operativo' && e.entryMode !== 'historico') return false;
    if (e.type === 'gasto' && e.medioPago === 'tarjeta' && e.currency === 'USD') {
      if (
        e.fxArsPerUsd === null ||
        !Number.isFinite(e.fxArsPerUsd) ||
        (e.fxArsPerUsd as number) <= 0
      ) {
        return false;
      }
    }
    return true;
  }

  private resolveInstallmentsTotal(
    message: string,
    detail: string,
    parsedInstallments: number | null,
    medioPago: MedioPago,
    type: 'ingreso' | 'gasto',
  ): number | null {
    if (type !== 'gasto' || medioPago !== 'tarjeta') return null;
    if (parsedInstallments && Number.isInteger(parsedInstallments) && parsedInstallments > 1) {
      return parsedInstallments;
    }
    const source = norm(`${message} ${detail}`);
    const match = /\b(?:en\s*)?(\d{1,3})\s*cuotas?\b/.exec(source);
    if (!match) return null;
    const n = Number.parseInt(match[1], 10);
    if (!Number.isInteger(n) || n <= 1 || n > 120) return null;
    return n;
  }

  private resolveInstallmentNumber(
    message: string,
    detail: string,
    installmentsTotal: number,
  ): number {
    const source = norm(`${message} ${detail}`);
    const byProgress = /\b(?:voy|estoy)\s+por\s+la?\s*cuota\s*(\d{1,3})\b/.exec(source);
    if (byProgress) {
      const currentPaid = Number.parseInt(byProgress[1], 10);
      if (Number.isInteger(currentPaid) && currentPaid >= 0) {
        const next = currentPaid + 1;
        if (next >= 1 && next <= installmentsTotal) return next;
      }
    }
    const explicit = /\bcuota\s*(\d{1,3})\b/.exec(source);
    if (explicit) {
      const number = Number.parseInt(explicit[1], 10);
      if (Number.isInteger(number) && number >= 1 && number <= installmentsTotal) return number;
    }
    return 1;
  }

  private async inferTarjetaIdFromInstallmentContext(
    detail: string,
    cards: TarjetaRow[],
    installmentsTotal: number,
    installmentNumber: number,
  ): Promise<string | null> {
    const detailNorm = norm(detail);
    const candidates: Array<{ cardId: string; score: number }> = [];

    for (const card of cards) {
      const debts = await this.tarjetas.debtsByCardId(card.id);
      if (!debts || debts.length === 0) continue;

      let bestScore = 0;
      for (const debt of debts) {
        if (debt.total_installments !== installmentsTotal) continue;
        const debtNorm = norm(debt.description);
        const textMatch =
          debtNorm.includes(detailNorm) ||
          detailNorm.includes(debtNorm) ||
          debtNorm.replace(/\s+/g, '') === detailNorm.replace(/\s+/g, '');
        if (!textMatch) continue;

        let score = 10;
        const expectedInstallment = debt.installments_paid + 1;
        if (expectedInstallment === installmentNumber) score += 20;
        if (debt.status === 'abierta' || debt.status === 'mora') score += 5;
        bestScore = Math.max(bestScore, score);
      }

      if (bestScore > 0) {
        candidates.push({ cardId: card.id, score: bestScore });
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);
    if (
      candidates.length > 1 &&
      candidates[0].score === candidates[1].score
    ) {
      return null;
    }
    return candidates[0].cardId;
  }

  private isValidIsoDate(s: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const t = Date.parse(`${s}T12:00:00.000Z`);
    if (Number.isNaN(t)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const check = new Date(Date.UTC(y, m - 1, d));
    return (
      check.getUTCFullYear() === y &&
      check.getUTCMonth() === m - 1 &&
      check.getUTCDate() === d
    );
  }
}

function norm(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

function normalizeCurrencyCode(value: string): string {
  const c = value.trim().toUpperCase();
  return c.length > 0 ? c : 'ARS';
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthStartIso(value: string): string {
  const d = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return todayIso().slice(0, 7) + '-01';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function formatMoney(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00';
}

function formatPct(value: number): string {
  return `${Math.max(0, value).toFixed(1)}%`;
}

function resolveFxArsPerUsdForSave(params: {
  type: 'ingreso' | 'gasto';
  medioPago: MedioPago;
  currency: string;
  optionsUsd?: number;
  defaultFromProfile: number | null;
}): number | null | 'missing' {
  const { type, medioPago, currency, optionsUsd, defaultFromProfile } = params;
  if (type !== 'gasto' || medioPago !== 'tarjeta' || currency !== 'USD') {
    return null;
  }
  const fromOpts =
    typeof optionsUsd === 'number' && Number.isFinite(optionsUsd) && optionsUsd > 0 ?
      optionsUsd
    : null;
  const fromProf =
    defaultFromProfile !== null &&
    typeof defaultFromProfile === 'number' &&
    Number.isFinite(defaultFromProfile) &&
    defaultFromProfile > 0 ?
      defaultFromProfile
    : null;
  const fx = fromOpts ?? fromProf;
  if (fx === null) return 'missing';
  return Math.round(fx * 10000) / 10000;
}

function isSupportedCashCurrency(value: string): boolean {
  const c = value.trim().toUpperCase();
  return c === 'ARS' || c === 'USD';
}
