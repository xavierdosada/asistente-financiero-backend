import { parseMoneyAmountInput } from './parse-money-amount';

describe('parseMoneyAmountInput', () => {
  it('parses JSON number as decimal point', () => {
    expect(parseMoneyAmountInput(892754.96)).toBe(892754.96);
    expect(parseMoneyAmountInput(892.754)).toBe(892.754);
  });

  it('parses es-AR string with comma decimals', () => {
    expect(parseMoneyAmountInput('892754,96')).toBe(892754.96);
    expect(parseMoneyAmountInput('892.754,96')).toBe(892754.96);
  });

  it('parses thousands with single dot and 3 fractional digits as integer thousands (AR)', () => {
    expect(parseMoneyAmountInput('892.754')).toBe(892754);
  });

  it('parses multi-group thousands without comma', () => {
    expect(parseMoneyAmountInput('1.234.567')).toBe(1234567);
  });

  it('parses decimal with one dot and 1-2 fractional digits as float', () => {
    expect(parseMoneyAmountInput('892.75')).toBe(892.75);
    expect(parseMoneyAmountInput('10.5')).toBe(10.5);
  });

  it('parses full amount with dot as decimal separator (no comma)', () => {
    expect(parseMoneyAmountInput('892754.96')).toBe(892754.96);
  });
});
