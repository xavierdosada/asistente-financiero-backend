import {
  signedStatementLineAmountForTotals,
  statementLineTreatsMovementAsCredit,
  type StatementLineMovementMeta,
} from './statement-line-credit.util';

describe('statementLineTreatsMovementAsCredit', () => {
  it('detects ingreso', () => {
    expect(
      statementLineTreatsMovementAsCredit({
        direction: 'ingreso',
        detail: 'Cualquier cosa',
        rawMessage: null,
      }),
    ).toBe(true);
  });

  it('detects reintegro / anulación / devolución / reembolso en detalle (gasto)', () => {
    expect(
      statementLineTreatsMovementAsCredit({
        direction: 'gasto',
        detail: 'Reintegro PedidosYa',
        rawMessage: null,
      }),
    ).toBe(true);
    expect(
      statementLineTreatsMovementAsCredit({
        direction: 'gasto',
        detail: 'Anulación bonificación X',
        rawMessage: null,
      }),
    ).toBe(true);
    expect(
      statementLineTreatsMovementAsCredit({
        direction: 'gasto',
        detail: 'Devolución compra',
        rawMessage: null,
      }),
    ).toBe(true);
    expect(
      statementLineTreatsMovementAsCredit({
        direction: 'gasto',
        detail: 'Reembolso Visa',
        rawMessage: null,
      }),
    ).toBe(true);
  });

  it('detects importe negativo en comprobante Banco Provincia aunque direction sea gasto', () => {
    expect(
      statementLineTreatsMovementAsCredit({
        direction: 'gasto',
        detail: 'PedidosYa Vea La Plata',
        rawMessage:
          '19/04/2026  PEDIDOSYA*VEA LA PLATA  Importe  -$ 961,85 VISA BPROVINCIA',
      }),
    ).toBe(true);
  });

  it('no marca cargo normal con importe positivo en PDF', () => {
    expect(
      statementLineTreatsMovementAsCredit({
        direction: 'gasto',
        detail: 'PedidosYa',
        rawMessage: '19/04/2026  PEDIDOSYA  Importe  $ 500,00 VISA BPROVINCIA',
      }),
    ).toBe(false);
  });
});

describe('signedStatementLineAmountForTotals', () => {
  const meta = (m: Record<string, StatementLineMovementMeta>) => new Map(Object.entries(m));

  it('resta crédito por raw_message con Importe -$', () => {
    const id = '62b8d306-ef07-42aa-a928-4c4a7f985da5';
    const signed = signedStatementLineAmountForTotals(
      {
        amount: 961.85,
        movement_id: id,
        detail: 'PedidosYa Vea La Plata',
      },
      meta({
        [id]: {
          direction: 'gasto',
          raw_message:
            '19/04/2026  PEDIDOSYA*VEA LA PLATA  Importe  -$ 961,85 VISA BPROVINCIA',
        },
      }),
    );
    expect(signed).toBe(-961.85);
  });

  it('resta ingreso con monto positivo', () => {
    const id = 'bf1c2b31-2d8f-424e-acee-7f02b92b6efd';
    const signed = signedStatementLineAmountForTotals(
      { amount: 192.37, movement_id: id, detail: 'Anulación bonificación' },
      meta({
        [id]: { direction: 'ingreso', raw_message: '… Importe  $ 192,37 …' },
      }),
    );
    expect(signed).toBe(-192.37);
  });
});
