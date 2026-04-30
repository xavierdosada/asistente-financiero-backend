import { computeDebtBuckets } from './supabase-tarjeta.repository';

describe('computeDebtBuckets', () => {
  it('moves in-cycle spends to pending debt while cycle is open', () => {
    const result = computeDebtBuckets({
      carryOverBase: 1000,
      paidUntilCurrentClosing: 0,
      spentUntilCurrentClosing: 400,
      spentUntilNextClosing: 250,
      cycleOpen: true,
    });

    expect(result.pendingMonthDebt).toBe(1400);
    expect(result.pendingMonthCredit).toBe(0);
    expect(result.nextMonthDebt).toBe(250);
  });

  it('keeps in-cycle spends in next month debt when cycle is already closed', () => {
    const result = computeDebtBuckets({
      carryOverBase: 1000,
      paidUntilCurrentClosing: 0,
      spentUntilCurrentClosing: 400,
      spentUntilNextClosing: 250,
      cycleOpen: false,
    });

    expect(result.pendingMonthDebt).toBe(1000);
    expect(result.pendingMonthCredit).toBe(0);
    expect(result.nextMonthDebt).toBe(1400);
  });

  it('applies overpayment as month credit', () => {
    const result = computeDebtBuckets({
      carryOverBase: 800,
      paidUntilCurrentClosing: 1000,
      spentUntilCurrentClosing: 300,
      spentUntilNextClosing: 50,
      cycleOpen: true,
    });

    expect(result.pendingMonthDebt).toBe(100);
    expect(result.pendingMonthCredit).toBe(200);
    expect(result.nextMonthDebt).toBe(50);
  });
});
