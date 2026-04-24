import { ProcessAdvisorMessageUseCase } from './process-advisor-message.use-case';
import type { AiFinancialAdvisorPort } from '../domain/ports/ai-financial-advisor.port';
import type { TarjetaRepositoryPort } from '../domain/ports/tarjeta-repository.port';
import type { LoanRepositoryPort } from '../domain/ports/loan-repository.port';
import type { AccountRepositoryPort } from '../domain/ports/account-repository.port';

describe('ProcessAdvisorMessageUseCase scope behavior', () => {
  const advisor: jest.Mocked<AiFinancialAdvisorPort> = {
    answer: jest.fn(),
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

  const useCase = new ProcessAdvisorMessageUseCase(
    advisor,
    tarjetas,
    loans,
    accounts,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    advisor.answer.mockResolvedValue({ answer: 'ok' });
  });

  it('does not include operational loans when scope=historico', async () => {
    const res = await useCase.execute({
      message: 'Como vengo con mis prestamos?',
      scope: 'historico',
    });

    expect(res.intent).toBe('loans_status');
    expect(loans.list).not.toHaveBeenCalled();
    expect(advisor.answer).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scope: 'historico',
          prestamos: [],
        }),
      }),
    );
  });

  it('forwards scope to cash summary calculation', async () => {
    accounts.monthlyCashSummary.mockResolvedValue({
      year: 2026,
      month: 4,
      currency: 'ARS',
      account_id: 'acc-1',
      account_name: 'Caja',
      opening_balance: 0,
      ajustes: 0,
      ingresos: 100,
      gastos: 30,
      neto_movimientos: 70,
      saldo: 70,
    });

    await useCase.execute({
      message: 'estado de caja abril 2026',
      scope: 'operativo',
      year: 2026,
      month: 4,
    });

    expect(accounts.monthlyCashSummary).toHaveBeenCalledWith(2026, 4, 'operativo');
  });

  it('forwards scope to card spending and usage summary', async () => {
    tarjetas.list.mockResolvedValue([
      {
        id: 'card-1',
        name: 'VISA BBVA (credito)',
        bank: 'BBVA',
        type_card: 'credito',
        payment_card: 'VISA',
        credit_limit: 100000,
      },
    ]);
    tarjetas.spendByRange.mockResolvedValue({
      card_id: 'card-1',
      from: '2026-04-01',
      to: '2026-04-30',
      scope: 'historico',
      total_spent: 0,
      movements_count: 0,
      by_month: [],
    });
    tarjetas.usageSummaryById.mockResolvedValue({
      card_id: 'card-1',
      month_current: '2026-04',
      month_next: '2026-05',
      spent_current: 0,
      spent_next: 0,
      pending_month_debt: 0,
      pending_month_credit: 0,
      next_month_debt: 0,
      credit_limit: 100000,
      available_current: 100000,
      available_next: 100000,
    });

    await useCase.execute({
      message: 'gastos tarjeta visa',
      scope: 'historico',
      from: '2026-04-01',
      to: '2026-04-30',
    });

    expect(tarjetas.spendByRange).toHaveBeenCalledWith(
      'card-1',
      '2026-04-01',
      '2026-04-30',
      'historico',
    );
    expect(tarjetas.usageSummaryById).toHaveBeenCalledWith(
      'card-1',
      expect.any(Date),
      'historico',
    );
  });
});
