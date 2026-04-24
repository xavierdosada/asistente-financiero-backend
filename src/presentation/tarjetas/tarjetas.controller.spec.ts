import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import {
  TARJETA_REPOSITORY,
  TarjetaRepositoryPort,
} from '../../domain/ports/tarjeta-repository.port';
import { TarjetasController } from './tarjetas.controller';

describe('Tarjetas endpoints', () => {
  let app: INestApplication;

  const repo: jest.Mocked<TarjetaRepositoryPort> = {
    list: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    deleteById: jest.fn(),
    usageSummaryById: jest.fn(),
    debtsByCardId: jest.fn(),
    listStatementsByCardId: jest.fn(),
    getStatementById: jest.fn(),
    generateMonthlyStatement: jest.fn(),
    spendByRange: jest.fn(),
    pendingInstallmentsByCardId: jest.fn(),
    setInitialDebt: jest.fn(),
    totalDebtAllCreditCards: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [TarjetasController],
      providers: [{ provide: TARJETA_REPOSITORY, useValue: repo }],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /tarjetas returns list', async () => {
    repo.list.mockResolvedValueOnce([
      {
        id: '1',
        name: 'VISA NARANJA (credito)',
        bank: 'NARANJA',
        type_card: 'credito',
        payment_card: 'VISA',
        closing_day: 10,
        credit_limit: 500000,
      },
    ]);

    const res = await request(app.getHttpServer()).get('/tarjetas');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('GET /tarjetas/deuda-total returns aggregated debt of credit cards', async () => {
    repo.totalDebtAllCreditCards.mockResolvedValueOnce({
      cards_count: 2,
      debts_count: 3,
      total_outstanding_amount: 450000,
    });

    const res = await request(app.getHttpServer()).get('/tarjetas/deuda-total');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      cards_count: 2,
      debts_count: 3,
      total_outstanding_amount: 450000,
    });
  });

  it('GET /tarjetas/:id returns 404 when missing', async () => {
    repo.findById.mockResolvedValueOnce(null);

    const res = await request(app.getHttpServer()).get('/tarjetas/abc');

    expect(res.status).toBe(404);
  });

  it('POST /tarjetas returns 400 for invalid type_card', async () => {
    const res = await request(app.getHttpServer()).post('/tarjetas').send({
      bank: 'NARANJA',
      type_card: 'gold',
      payment_card: 'VISA',
    });

    expect(res.status).toBe(400);
  });

  it('POST /tarjetas creates card', async () => {
    repo.create.mockResolvedValueOnce({
      id: '1',
      name: 'VISA NARANJA (credito)',
      bank: 'NARANJA',
      type_card: 'credito',
      payment_card: 'VISA',
      closing_day: 10,
      due_day: 8,
      credit_limit: 500000,
    });

    const res = await request(app.getHttpServer()).post('/tarjetas').send({
      bank: 'NARANJA',
      type_card: 'credito',
      payment_card: 'VISA',
      closing_day: 10,
      due_day: 8,
      credit_limit: 500000,
    });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('VISA NARANJA (credito)');
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        due_day: 8,
      }),
    );
  });

  it('POST /tarjetas creates card without due_day', async () => {
    repo.create.mockResolvedValueOnce({
      id: '1',
      name: 'VISA NARANJA (credito)',
      bank: 'NARANJA',
      type_card: 'credito',
      payment_card: 'VISA',
      closing_day: 10,
      due_day: 10,
      credit_limit: 500000,
    });

    const res = await request(app.getHttpServer()).post('/tarjetas').send({
      bank: 'NARANJA',
      type_card: 'credito',
      payment_card: 'VISA',
      closing_day: 10,
      credit_limit: 500000,
    });

    expect(res.status).toBe(201);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        due_day: undefined,
      }),
    );
  });

  it('POST /tarjetas returns 400 for invalid due_day', async () => {
    const res = await request(app.getHttpServer()).post('/tarjetas').send({
      bank: 'NARANJA',
      type_card: 'credito',
      payment_card: 'VISA',
      closing_day: 10,
      due_day: 40,
    });

    expect(res.status).toBe(400);
  });

  it('PATCH /tarjetas/:id updates card', async () => {
    repo.update.mockResolvedValueOnce({
      id: '1',
      name: 'MASTERCARD NARANJA (credito)',
      bank: 'NARANJA',
      type_card: 'credito',
      payment_card: 'MASTERCARD',
      closing_day: 10,
      due_day: 12,
      credit_limit: 500000,
    });

    const res = await request(app.getHttpServer())
      .patch('/tarjetas/1')
      .send({ payment_card: 'MASTERCARD', due_day: 12, apply_due_day_to_current: true });

    expect(res.status).toBe(200);
    expect(res.body.payment_card).toBe('MASTERCARD');
    expect(repo.update).toHaveBeenCalledWith(
      '1',
      expect.objectContaining({
        due_day: 12,
        apply_due_day_to_current: true,
      }),
    );
  });

  it('PATCH /tarjetas/:id returns 400 for invalid due_day', async () => {
    const res = await request(app.getHttpServer()).patch('/tarjetas/1').send({ due_day: 0 });
    expect(res.status).toBe(400);
  });

  it('DELETE /tarjetas/:id returns ok true', async () => {
    repo.deleteById.mockResolvedValueOnce();

    const res = await request(app.getHttpServer()).delete('/tarjetas/1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /tarjetas/:id/resumen returns dynamic usage by card', async () => {
    repo.usageSummaryById.mockResolvedValueOnce({
      card_id: '1',
      month_current: '2026-04',
      month_next: '2026-05',
      spent_current: 9000,
      spent_next: 0,
      pending_month_debt: 3000,
      pending_month_credit: 0,
      next_month_debt: 8000,
      credit_limit: 100000,
      available_current: 91000,
      available_next: 100000,
    });

    const res = await request(app.getHttpServer()).get('/tarjetas/1/resumen');

    expect(res.status).toBe(200);
    expect(res.body.available_current).toBe(91000);
    expect(res.body.pending_month_debt).toBe(3000);
    expect(res.body.pending_month_credit).toBe(0);
    expect(res.body.next_month_debt).toBe(8000);
  });

  it('GET /tarjetas/:id/deudas returns card debts with installments', async () => {
    repo.debtsByCardId.mockResolvedValueOnce([
      {
        id: 'debt-1',
        card_id: '1',
        description: 'Notebook 12 cuotas',
        currency: 'ARS',
        principal_amount: 1200000,
        outstanding_amount: 900000,
        total_installments: 12,
        installments_paid: 3,
        installments_remaining: 9,
        first_due_date: '2026-01-10',
        status: 'abierta',
        installments: [
          {
            id: 'inst-1',
            installment_number: 1,
            due_date: '2026-01-10',
            amount: 100000,
            paid_amount: 100000,
            status: 'pagada',
            paid_at: '2026-01-10',
          },
        ],
      },
    ]);

    const res = await request(app.getHttpServer()).get('/tarjetas/1/deudas');

    expect(res.status).toBe(200);
    expect(res.body[0].installments_remaining).toBe(9);
  });

  it('GET /tarjetas/:id/cuotas-pendientes returns pending installments', async () => {
    repo.pendingInstallmentsByCardId.mockResolvedValueOnce({
      pending_count: 1,
      total_remaining_amount: 100000,
      installments: [
        {
          debt_id: 'debt-1',
          debt_description: 'Heladera 12 cuotas',
          debt_total_installments: 12,
          installment_id: 'inst-6',
          installment_number: 6,
          due_date: '2026-06-10',
          amount: 100000,
          paid_amount: 0,
          remaining_amount: 100000,
          status: 'pendiente',
        },
      ],
    });

    const res = await request(app.getHttpServer()).get('/tarjetas/1/cuotas-pendientes');

    expect(res.status).toBe(200);
    expect(res.body.pending_count).toBe(1);
    expect(res.body.total_remaining_amount).toBe(100000);
    expect(res.body.installments).toHaveLength(1);
    expect(res.body.installments[0].remaining_amount).toBe(100000);
    expect(res.body.installments[0].debt_total_installments).toBe(12);
  });

  it('GET /tarjetas/:id/resumenes returns statements', async () => {
    repo.listStatementsByCardId.mockResolvedValueOnce([
      {
        id: 'st-1',
        card_id: '1',
        period_year: 2026,
        period_month: 4,
        opened_at: '2026-04-01',
        closed_at: '2026-04-30',
        due_date: '2026-05-10',
        total_amount: 120000,
        paid_amount: 60000,
        outstanding_amount: 60000,
        status: 'cerrado',
      },
    ]);

    const res = await request(app.getHttpServer()).get('/tarjetas/1/resumenes');

    expect(res.status).toBe(200);
    expect(res.body[0].outstanding_amount).toBe(60000);
  });

  it('GET /tarjetas/:id/resumenes/:statementId returns statement detail', async () => {
    repo.getStatementById.mockResolvedValueOnce({
      id: 'st-1',
      card_id: '1',
      period_year: 2026,
      period_month: 4,
      opened_at: '2026-04-01',
      closed_at: '2026-04-30',
      due_date: '2026-05-10',
      total_amount: 120000,
      paid_amount: 60000,
      outstanding_amount: 60000,
      status: 'cerrado',
      lines: [
        {
          id: 'ln-1',
          source_type: 'movement',
          movement_id: 'mov-1',
          installment_id: null,
          detail: 'Supermercado',
          amount: 60000,
        },
      ],
    });

    const res = await request(app.getHttpServer()).get('/tarjetas/1/resumenes/st-1');

    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(1);
  });

  it('POST /tarjetas/:id/resumenes/generar generates statement', async () => {
    repo.generateMonthlyStatement.mockResolvedValueOnce({
      id: 'st-1',
      card_id: '1',
      period_year: 2026,
      period_month: 4,
      opened_at: '2026-04-01',
      closed_at: '2026-04-30',
      due_date: '2026-05-10',
      total_amount: 120000,
      paid_amount: 0,
      outstanding_amount: 120000,
      status: 'cerrado',
      lines: [],
    });

    const res = await request(app.getHttpServer())
      .post('/tarjetas/1/resumenes/generar')
      .send({ year: 2026, month: 4 });

    expect(res.status).toBe(201);
    expect(res.body.period_month).toBe(4);
  });

  it('POST /tarjetas/:id/deuda-inicial sets initial debt', async () => {
    repo.setInitialDebt.mockResolvedValueOnce({
      id: 'st-boot-1',
      card_id: '1',
      period_year: 2026,
      period_month: 4,
      opened_at: '2026-04-01',
      closed_at: '2026-04-30',
      due_date: '2026-05-10',
      total_amount: 300000,
      paid_amount: 0,
      outstanding_amount: 300000,
      status: 'cerrado',
    });

    const res = await request(app.getHttpServer())
      .post('/tarjetas/1/deuda-inicial')
      .send({ year: 2026, month: 4, outstanding_amount: 300000, due_date: '2026-05-10' });

    expect(res.status).toBe(201);
    expect(res.body.outstanding_amount).toBe(300000);
  });

  it('GET /tarjetas/:id/gastos returns range summary', async () => {
    repo.spendByRange.mockResolvedValueOnce({
      card_id: '1',
      from: '2026-04-01',
      to: '2026-04-30',
      scope: 'operativo',
      total_spent: 55000,
      movements_count: 2,
      by_month: [{ month: '2026-04', amount: 55000 }],
    });

    const res = await request(app.getHttpServer())
      .get('/tarjetas/1/gastos?from=2026-04-01&to=2026-04-30');

    expect(res.status).toBe(200);
    expect(res.body.total_spent).toBe(55000);
    expect(res.body.scope).toBe('operativo');
    expect(repo.spendByRange).toHaveBeenCalledWith(
      '1',
      '2026-04-01',
      '2026-04-30',
      'operativo',
    );
  });

  it('GET /tarjetas/:id/gastos accepts scope=historico', async () => {
    repo.spendByRange.mockResolvedValueOnce({
      card_id: '1',
      from: '2026-03-01',
      to: '2026-03-31',
      scope: 'historico',
      total_spent: 70000,
      movements_count: 3,
      by_month: [{ month: '2026-03', amount: 70000 }],
    });

    const res = await request(app.getHttpServer())
      .get('/tarjetas/1/gastos?from=2026-03-01&to=2026-03-31&scope=historico');

    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('historico');
  });

  it('GET /tarjetas/:id/gastos returns 400 for invalid scope', async () => {
    const res = await request(app.getHttpServer())
      .get('/tarjetas/1/gastos?from=2026-03-01&to=2026-03-31&scope=todo');
    expect(res.status).toBe(400);
  });
});
