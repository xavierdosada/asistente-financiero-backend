import type { TarjetaRow } from '../../domain/ports/tarjeta-repository.port';
import {
  collectPeriodKeysWithDueInCalendarMonth,
  computeDebtBuckets,
  movementLinePayload,
  normalizeMovementCurrency,
} from './supabase-tarjeta.repository';

describe('collectPeriodKeysWithDueInCalendarMonth', () => {
  const base: TarjetaRow = {
    id: 'c1',
    name: 'Test',
    bank: 'B',
    type_card: 'credito',
    payment_card: 'VISA',
    credit_limit: 100_000,
    closing_day: null,
    due_day: 10,
  };

  it('includes period whose due falls in range when closing_day is unset', () => {
    // monthRangeByYearMonth(2026,2) usa due en el mes siguiente al índice interno (comportamiento existente).
    const keys = collectPeriodKeysWithDueInCalendarMonth(
      base,
      '2026-03-01',
      '2026-03-31',
      2026,
      2,
    );
    expect(keys.some((k) => k.year === 2026 && k.month === 2)).toBe(true);
  });

  it('finds at least one period whose due falls in May for closing_day 15', () => {
    const card: TarjetaRow = { ...base, closing_day: 15, due_day: 10 };
    const keys = collectPeriodKeysWithDueInCalendarMonth(
      card,
      '2026-05-01',
      '2026-05-31',
      2026,
      5,
    );
    expect(keys.length).toBeGreaterThanOrEqual(1);
    for (const k of keys) {
      expect(k.year).toBeGreaterThanOrEqual(2025);
      expect(k.month).toBeGreaterThanOrEqual(1);
      expect(k.month).toBeLessThanOrEqual(12);
    }
  });
});

describe('computeDebtBuckets', () => {
  it('moves in-cycle spends to pending debt while cycle is open', () => {
    const result = computeDebtBuckets({
      carryOverBase: 1000,
      paidUntilCurrentClosing: 0,
      spentUntilCurrentClosing: 400,
      spentUntilNextClosing: 250,
      cycleOpen: true,
    });

    // Ciclo abierto: pending = solo arrastre; next = gasto del ciclo actual (proyectado).
    expect(result.pendingMonthDebt).toBe(1000);
    expect(result.pendingMonthCredit).toBe(0);
    expect(result.nextMonthDebt).toBe(400);
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

    expect(result.pendingMonthDebt).toBe(0);
    expect(result.pendingMonthCredit).toBe(200);
    expect(result.nextMonthDebt).toBe(300);
  });
});

describe('normalizeMovementCurrency', () => {
  it('defaults blank to ARS', () => {
    expect(normalizeMovementCurrency(null)).toBe('ARS');
    expect(normalizeMovementCurrency('  ')).toBe('ARS');
  });

  it('accepts usd case-insensitive', () => {
    expect(normalizeMovementCurrency('usd')).toBe('USD');
    expect(normalizeMovementCurrency('USD')).toBe('USD');
  });

  it('maps unknown codes to ARS', () => {
    expect(normalizeMovementCurrency('EUR')).toBe('ARS');
  });
});

describe('movementLinePayload (moneda original)', () => {
  it('does not convert USD amounts to ARS', () => {
    const p = movementLinePayload({
      amount: 250,
      currency: 'USD',
      fx_ars_per_usd: 1200,
    });
    expect(p.amount).toBe(250);
    expect(p.currency).toBe('USD');
    expect(p.fx_ars_per_usd).toBe(1200);
  });

  it('uses raw amount for ARS', () => {
    const p = movementLinePayload({ amount: 1500.5, currency: 'ARS', fx_ars_per_usd: null });
    expect(p.amount).toBe(1500.5);
    expect(p.currency).toBe('ARS');
    expect(p.fx_ars_per_usd).toBeNull();
  });
});

