import { ProcessChatMessageUseCase } from './process-chat-message.use-case';
import type { AiTransactionParserPort } from '../domain/ports/ai-transaction-parser.port';
import type { TransactionRepositoryPort } from '../domain/ports/transaction-repository.port';
import type { CategoriaRepositoryPort } from '../domain/ports/categoria-repository.port';
import type { TarjetaRepositoryPort } from '../domain/ports/tarjeta-repository.port';
import type { LoanRepositoryPort } from '../domain/ports/loan-repository.port';
import type { AccountRepositoryPort } from '../domain/ports/account-repository.port';
import type { BudgetRepositoryPort } from '../domain/ports/budget-repository.port';
import type { ChatPreferencesRepositoryPort } from '../domain/ports/chat-preferences.repository.port';
import type { FixedExpenseRepositoryPort } from '../domain/ports/fixed-expense-repository.port';

describe('ProcessChatMessageUseCase entry mode', () => {
  const parser: jest.Mocked<AiTransactionParserPort> = {
    parse: jest.fn(),
  };
  const transactions: jest.Mocked<TransactionRepositoryPort> = {
    save: jest.fn(),
  };
  const categorias: jest.Mocked<CategoriaRepositoryPort> = {
    list: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    deleteById: jest.fn(),
  };
  const tarjetas: jest.Mocked<TarjetaRepositoryPort> = {
    list: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    deleteById: jest.fn(),
    usageSummaryById: jest.fn(),
    listStatementsByCardId: jest.fn(),
    getStatementById: jest.fn(),
    generateMonthlyStatement: jest.fn(),
    spendByRange: jest.fn(),
    pendingInstallmentsByCardId: jest.fn(),
    setInitialDebt: jest.fn(),
    debtsByCardId: jest.fn(),
    totalDebtAllCreditCards: jest.fn(),
  };
  const loans: jest.Mocked<LoanRepositoryPort> = {
    list: jest.fn(),
    findById: jest.fn(),
    installmentsByLoanId: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    deleteById: jest.fn(),
  };
  const accounts: jest.Mocked<AccountRepositoryPort> = {
    getOrCreateCashAccount: jest.fn(),
    setMonthlyOpening: jest.fn(),
    adjustMonthlyOpening: jest.fn(),
    monthlyCashHistory: jest.fn(),
    monthlyCashSummary: jest.fn(),
  };
  const prefs: jest.Mocked<ChatPreferencesRepositoryPort> = {
    get: jest.fn(),
    update: jest.fn(),
  };
  const budgets: jest.Mocked<BudgetRepositoryPort> = {
    listActive: jest.fn(),
    upsertMonthly: jest.fn(),
    closeActiveById: jest.fn(),
    getProgress: jest.fn(),
    getCategoryMonthlyProgress: jest.fn(),
    getRealSpendAnalytics: jest.fn(),
  };
  const fixedExpenses: jest.Mocked<FixedExpenseRepositoryPort> = {
    list: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    generateInstancesForMonth: jest.fn(),
    listInstances: jest.fn(),
    findInstanceById: jest.fn(),
    markInstancePaid: jest.fn(),
    findBestMatch: jest.fn(),
  };

  const useCase = new ProcessChatMessageUseCase(
    parser,
    transactions,
    categorias,
    tarjetas,
    loans,
    accounts,
    budgets,
    fixedExpenses,
    prefs,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    categorias.list.mockResolvedValue([{ id: 'cat-1', nombre: 'Comida', icon_key: null }]);
    tarjetas.list.mockResolvedValue([]);
    loans.list.mockResolvedValue([]);
    parser.parse.mockResolvedValue({
      save: true,
      currency: 'ARS',
      amount: 1000,
      type: 'gasto',
      detail: 'almuerzo',
      categoriaNombre: 'Comida',
      medioPago: 'efectivo',
      tarjetaNombre: null,
      movementDate: '2026-04-10',
    });
    accounts.getOrCreateCashAccount.mockResolvedValue({
      id: 'acc-1',
      name: 'Caja',
      account_type: 'efectivo',
      currency: 'ARS',
    });
    transactions.save.mockResolvedValue({ id: 'mov-1' });
    budgets.getCategoryMonthlyProgress.mockResolvedValue(null);
    fixedExpenses.findBestMatch.mockResolvedValue(null);
  });

  it('uses default_entry_mode from preferences when request omits entry mode', async () => {
    prefs.get.mockResolvedValue({
      auto_create_category_default: false,
      default_entry_mode: 'historico',
      default_usd_ars_rate: null,
    });

    const res = await useCase.execute('Gasté 1000 en almuerzo');

    expect(res).toMatchObject({
      saved: true,
      id: 'mov-1',
    });
    expect(transactions.save).toHaveBeenCalledWith(
      expect.objectContaining({
        entryMode: 'historico',
      }),
    );
  });

  it('uses explicit entryMode from request over preferences default', async () => {
    prefs.get.mockResolvedValue({
      auto_create_category_default: false,
      default_entry_mode: 'historico',
      default_usd_ars_rate: null,
    });

    const res = await useCase.execute('Gasté 1000 en almuerzo', {
      entryMode: 'operativo',
    });

    expect(res).toMatchObject({ saved: true, id: 'mov-1' });
    expect(transactions.save).toHaveBeenCalledWith(
      expect.objectContaining({
        entryMode: 'operativo',
      }),
    );
  });

  it('routes efectivo USD movement to USD cash account', async () => {
    prefs.get.mockResolvedValue({
      auto_create_category_default: false,
      default_entry_mode: 'operativo',
      default_usd_ars_rate: null,
    });
    parser.parse.mockResolvedValueOnce({
      save: true,
      currency: 'USD',
      amount: 25,
      type: 'gasto',
      detail: 'cafe',
      categoriaNombre: 'Comida',
      medioPago: 'efectivo',
      tarjetaNombre: null,
      movementDate: '2026-04-11',
    });
    accounts.getOrCreateCashAccount.mockResolvedValueOnce({
      id: 'acc-usd',
      name: 'Caja USD',
      account_type: 'efectivo',
      currency: 'USD',
    });

    const res = await useCase.execute('Gasté 25 usd en cafe');
    expect(res).toMatchObject({
      saved: true,
      id: 'mov-1',
    });
    expect(accounts.getOrCreateCashAccount).toHaveBeenCalledWith('USD');
    expect(transactions.save).toHaveBeenCalledWith(
      expect.objectContaining({ sourceAccountId: 'acc-usd' }),
    );
  });

  it('rejects efectivo movement with unsupported cash currency', async () => {
    prefs.get.mockResolvedValue({
      auto_create_category_default: false,
      default_entry_mode: 'operativo',
      default_usd_ars_rate: null,
    });
    parser.parse.mockResolvedValueOnce({
      save: true,
      currency: 'EUR',
      amount: 20,
      type: 'gasto',
      detail: 'snack',
      categoriaNombre: 'Comida',
      medioPago: 'efectivo',
      tarjetaNombre: null,
      movementDate: '2026-04-11',
    });

    const res = await useCase.execute('Gasté 20 eur en snack');
    expect(res.saved).toBe(false);
    if (res.saved === false) {
      expect(res.reason).toContain('ARS y USD');
    }
    expect(accounts.getOrCreateCashAccount).not.toHaveBeenCalled();
  });

  it('detects installments in card spend and forwards installments_total', async () => {
    prefs.get.mockResolvedValue({
      auto_create_category_default: false,
      default_entry_mode: 'operativo',
      default_usd_ars_rate: null,
    });
    tarjetas.list.mockResolvedValueOnce([
      {
        id: 'card-1',
        name: 'VISA BBVA (credito)',
        bank: 'BBVA',
        type_card: 'credito',
        payment_card: 'VISA',
        credit_limit: 100000,
      },
    ]);
    parser.parse.mockResolvedValueOnce({
      save: true,
      currency: 'ARS',
      amount: 300000,
      type: 'gasto',
      detail: 'heladera en 3 cuotas',
      categoriaNombre: 'Comida',
      medioPago: 'tarjeta',
      tarjetaNombre: 'VISA BBVA',
      movementDate: '2026-04-11',
      installmentsTotal: null,
    });

    const res = await useCase.execute('Compré una heladera en 3 cuotas con VISA BBVA');

    expect(res).toMatchObject({ saved: true, id: 'mov-1' });
    expect(transactions.save).toHaveBeenCalledWith(
      expect.objectContaining({
        installmentsTotal: 3,
        installmentNumber: 1,
      }),
    );
  });

  it('keeps cuota amount unchanged when message indicates cuota progress 02/03', async () => {
    prefs.get.mockResolvedValue({
      auto_create_category_default: false,
      default_entry_mode: 'operativo',
      default_usd_ars_rate: null,
    });
    categorias.list.mockResolvedValueOnce([{ id: 'cat-ropa', nombre: 'Ropa', icon_key: null }]);
    tarjetas.list.mockResolvedValueOnce([
      {
        id: 'card-1',
        name: 'VISA BBVA (credito)',
        bank: 'BBVA',
        type_card: 'credito',
        payment_card: 'VISA',
        credit_limit: 100000,
      },
    ]);
    parser.parse.mockResolvedValueOnce({
      save: true,
      currency: 'ARS',
      amount: 13503.33,
      type: 'gasto',
      detail: 'Augusto C',
      categoriaNombre: 'Ropa',
      medioPago: 'tarjeta',
      tarjetaNombre: 'VISA BBVA',
      movementDate: '2026-03-16',
      installmentsTotal: 3,
    });

    const res = await useCase.execute(
      '16/03/26 AUGUSTO C local de ropa Cuota 02/03 $ 13.503,33 tarjeta BBVA',
    );

    expect(res).toMatchObject({ saved: true, id: 'mov-1' });
    expect(transactions.save).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 13503.33,
        installmentsTotal: 3,
        installmentNumber: 2,
      }),
    );
  });

  it('autocompletes amount from pending loan installment when paying cuota without explicit amount', async () => {
    prefs.get.mockResolvedValue({
      auto_create_category_default: false,
      default_entry_mode: 'operativo',
      default_usd_ars_rate: null,
    });
    loans.list.mockResolvedValueOnce([
      {
        id: 'loan-1',
        name: 'Prestamo Galeno',
        lender: 'Galeno',
        currency: 'ARS',
        principal_amount: 300000,
        installment_amount: 25000,
        outstanding_amount: 100000,
        total_installments: 12,
        installments_paid: 8,
        installments_remaining: 4,
        first_due_date: '2026-01-10',
        status: 'activa',
        annual_rate: null,
        notes: null,
      },
    ]);
    loans.installmentsByLoanId.mockResolvedValueOnce([
      {
        id: 'inst-1',
        loan_id: 'loan-1',
        installment_number: 9,
        due_date: '2026-09-10',
        amount: 25000,
        paid_amount: 0,
        status: 'pendiente',
        paid_at: null,
      },
    ]);
    parser.parse.mockResolvedValueOnce({
      save: true,
      currency: 'ARS',
      amount: null,
      type: 'gasto',
      detail: 'pago cuota prestamo galeno',
      categoriaNombre: 'Comida',
      medioPago: 'efectivo',
      tarjetaNombre: null,
      movementDate: '2026-09-10',
    });

    const res = await useCase.execute('pague la cuota del prestamo galeno');
    expect(res).toMatchObject({ saved: true, id: 'mov-1' });
    expect(transactions.save).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 25000,
        loanId: 'loan-1',
      }),
    );
  });

  it('returns clear error when loan payment without amount has no matching loan', async () => {
    prefs.get.mockResolvedValue({
      auto_create_category_default: false,
      default_entry_mode: 'operativo',
      default_usd_ars_rate: null,
    });
    loans.list.mockResolvedValueOnce([]);
    parser.parse.mockResolvedValueOnce({
      save: true,
      currency: 'ARS',
      amount: null,
      type: 'gasto',
      detail: 'pago cuota prestamo galeno',
      categoriaNombre: 'Comida',
      medioPago: 'efectivo',
      tarjetaNombre: null,
      movementDate: '2026-09-10',
    });

    const res = await useCase.execute('pague la cuota del prestamo galeno');
    expect(res.saved).toBe(false);
    if (!res.saved) {
      expect(res.reason).toContain('No encontr');
    }
  });

  it('returns ambiguity error when multiple loans match with same score', async () => {
    prefs.get.mockResolvedValue({
      auto_create_category_default: false,
      default_entry_mode: 'operativo',
      default_usd_ars_rate: null,
    });
    loans.list.mockResolvedValueOnce([
      {
        id: 'loan-1',
        name: 'Galeno plan A',
        lender: 'Galeno',
        currency: 'ARS',
        principal_amount: 300000,
        installment_amount: 25000,
        outstanding_amount: 100000,
        total_installments: 12,
        installments_paid: 8,
        installments_remaining: 4,
        first_due_date: '2026-01-10',
        status: 'activa',
        annual_rate: null,
        notes: null,
      },
      {
        id: 'loan-2',
        name: 'Galeno plan B',
        lender: 'Galeno',
        currency: 'ARS',
        principal_amount: 300000,
        installment_amount: 26000,
        outstanding_amount: 100000,
        total_installments: 12,
        installments_paid: 8,
        installments_remaining: 4,
        first_due_date: '2026-01-10',
        status: 'activa',
        annual_rate: null,
        notes: null,
      },
    ]);
    parser.parse.mockResolvedValueOnce({
      save: true,
      currency: 'ARS',
      amount: null,
      type: 'gasto',
      detail: 'pago cuota prestamo galeno',
      categoriaNombre: 'Comida',
      medioPago: 'efectivo',
      tarjetaNombre: null,
      movementDate: '2026-09-10',
    });

    const res = await useCase.execute('pague la cuota del prestamo galeno');
    expect(res.saved).toBe(false);
    if (!res.saved) {
      expect(res.reason).toContain('más de un préstamo');
    }
  });

  it('returns clear error when matched loan has no pending or overdue installments', async () => {
    prefs.get.mockResolvedValue({
      auto_create_category_default: false,
      default_entry_mode: 'operativo',
      default_usd_ars_rate: null,
    });
    loans.list.mockResolvedValueOnce([
      {
        id: 'loan-1',
        name: 'Prestamo Galeno',
        lender: 'Galeno',
        currency: 'ARS',
        principal_amount: 300000,
        installment_amount: 25000,
        outstanding_amount: 0,
        total_installments: 12,
        installments_paid: 12,
        installments_remaining: 0,
        first_due_date: '2026-01-10',
        status: 'pagada',
        annual_rate: null,
        notes: null,
      },
    ]);
    loans.installmentsByLoanId.mockResolvedValueOnce([
      {
        id: 'inst-1',
        loan_id: 'loan-1',
        installment_number: 12,
        due_date: '2026-08-10',
        amount: 25000,
        paid_amount: 25000,
        status: 'pagada',
        paid_at: '2026-08-10T00:00:00.000Z',
      },
    ]);
    parser.parse.mockResolvedValueOnce({
      save: true,
      currency: 'ARS',
      amount: null,
      type: 'gasto',
      detail: 'pago cuota prestamo galeno',
      categoriaNombre: 'Comida',
      medioPago: 'efectivo',
      tarjetaNombre: null,
      movementDate: '2026-09-10',
    });

    const res = await useCase.execute('pague la cuota del prestamo galeno');
    expect(res.saved).toBe(false);
    if (!res.saved) {
      expect(res.reason).toContain('No pude determinar el monto');
    }
  });

  it('rejects card spend USD without usd fx', async () => {
    prefs.get.mockResolvedValue({
      auto_create_category_default: false,
      default_entry_mode: 'operativo',
      default_usd_ars_rate: null,
    });
    tarjetas.list.mockResolvedValueOnce([
      {
        id: 'card-1',
        name: 'VISA BBVA (credito)',
        bank: 'BBVA',
        type_card: 'credito',
        payment_card: 'VISA',
        credit_limit: 100000,
      },
    ]);
    parser.parse.mockResolvedValueOnce({
      save: true,
      currency: 'USD',
      amount: 5,
      type: 'gasto',
      detail: 'steam',
      categoriaNombre: 'Comida',
      medioPago: 'tarjeta',
      tarjetaNombre: 'VISA BBVA',
      movementDate: '2026-04-11',
    });

    const res = await useCase.execute('Gasté 5 usd en steam con visa bbva');
    expect(res.saved).toBe(false);
    if (!res.saved) {
      expect(res.reason).toMatch(/cotiz|dólar|pesos/i);
    }
    expect(transactions.save).not.toHaveBeenCalled();
  });

  it('saves card spend USD with usdArsRate from options', async () => {
    prefs.get.mockResolvedValue({
      auto_create_category_default: false,
      default_entry_mode: 'operativo',
      default_usd_ars_rate: null,
    });
    tarjetas.list.mockResolvedValueOnce([
      {
        id: 'card-1',
        name: 'VISA BBVA (credito)',
        bank: 'BBVA',
        type_card: 'credito',
        payment_card: 'VISA',
        credit_limit: 100000,
      },
    ]);
    parser.parse.mockResolvedValueOnce({
      save: true,
      currency: 'USD',
      amount: 5,
      type: 'gasto',
      detail: 'steam',
      categoriaNombre: 'Comida',
      medioPago: 'tarjeta',
      tarjetaNombre: 'VISA BBVA',
      movementDate: '2026-04-11',
    });

    const res = await useCase.execute('Gasté 5 usd en steam con visa bbva', { usdArsRate: 1000 });
    expect(res).toMatchObject({ saved: true, id: 'mov-1' });
    expect(transactions.save).toHaveBeenCalledWith(
      expect.objectContaining({
        currency: 'USD',
        amount: 5,
        fxArsPerUsd: 1000,
      }),
    );
  });

  it('uses profile default_usd_ars_rate for card USD when options omit rate', async () => {
    prefs.get.mockResolvedValue({
      auto_create_category_default: false,
      default_entry_mode: 'operativo',
      default_usd_ars_rate: 1200,
    });
    tarjetas.list.mockResolvedValueOnce([
      {
        id: 'card-1',
        name: 'VISA BBVA (credito)',
        bank: 'BBVA',
        type_card: 'credito',
        payment_card: 'VISA',
        credit_limit: 100000,
      },
    ]);
    parser.parse.mockResolvedValueOnce({
      save: true,
      currency: 'USD',
      amount: 5,
      type: 'gasto',
      detail: 'steam',
      categoriaNombre: 'Comida',
      medioPago: 'tarjeta',
      tarjetaNombre: 'VISA BBVA',
      movementDate: '2026-04-11',
    });

    const res = await useCase.execute('Gasté 5 usd en steam con visa bbva');
    expect(res).toMatchObject({ saved: true, id: 'mov-1' });
    expect(transactions.save).toHaveBeenCalledWith(expect.objectContaining({ fxArsPerUsd: 1200 }));
  });
});
