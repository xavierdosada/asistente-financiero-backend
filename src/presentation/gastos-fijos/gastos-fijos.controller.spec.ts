import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { ACCOUNT_REPOSITORY, AccountRepositoryPort } from '../../domain/ports/account-repository.port';
import {
  FIXED_EXPENSE_REPOSITORY,
  FixedExpenseRepositoryPort,
} from '../../domain/ports/fixed-expense-repository.port';
import {
  TRANSACTION_REPOSITORY,
  TransactionRepositoryPort,
} from '../../domain/ports/transaction-repository.port';
import { GastosFijosController } from './gastos-fijos.controller';

describe('Gastos fijos endpoints', () => {
  let app: INestApplication;

  const fixedRepo: jest.Mocked<FixedExpenseRepositoryPort> = {
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
  const txRepo: jest.Mocked<TransactionRepositoryPort> = {
    save: jest.fn(),
  };
  const accountRepo: jest.Mocked<AccountRepositoryPort> = {
    getOrCreateCashAccount: jest.fn(),
    setMonthlyOpening: jest.fn(),
    adjustMonthlyOpening: jest.fn(),
    monthlyCashHistory: jest.fn(),
    monthlyCashSummary: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [GastosFijosController],
      providers: [
        { provide: FIXED_EXPENSE_REPOSITORY, useValue: fixedRepo },
        { provide: TRANSACTION_REPOSITORY, useValue: txRepo },
        { provide: ACCOUNT_REPOSITORY, useValue: accountRepo },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /fixed-expenses returns list', async () => {
    fixedRepo.list.mockResolvedValueOnce([]);
    const res = await request(app.getHttpServer()).get('/fixed-expenses');
    expect(res.status).toBe(200);
  });

  it('POST /fixed-expenses validates payload', async () => {
    const res = await request(app.getHttpServer()).post('/fixed-expenses').send({});
    expect(res.status).toBe(400);
  });

  it('POST /fixed-expenses creates item', async () => {
    fixedRepo.create.mockResolvedValueOnce({
      id: 'fx-1',
      name: 'Alquiler',
      aliases: ['alquiler'],
      amount: 200000,
      currency: 'ARS',
      category_id: 'cat-1',
      category_name: 'Vivienda',
      payment_method: 'efectivo',
      card_id: null,
      due_day: 10,
      is_active: true,
    });
    const res = await request(app.getHttpServer()).post('/fixed-expenses').send({
      name: 'Alquiler',
      aliases: ['alquiler'],
      amount: 200000,
      currency: 'ARS',
      category_id: 'cat-1',
      payment_method: 'efectivo',
      due_day: 10,
    });
    expect(res.status).toBe(201);
  });

  it('GET /fixed-expenses/instances generates and returns rows', async () => {
    fixedRepo.generateInstancesForMonth.mockResolvedValueOnce(1);
    fixedRepo.listInstances.mockResolvedValueOnce([]);
    const res = await request(app.getHttpServer()).get('/fixed-expenses/instances?month=2026-04-01');
    expect(res.status).toBe(200);
    expect(fixedRepo.generateInstancesForMonth).toHaveBeenCalledWith('2026-04-01');
  });

  it('POST /fixed-expenses/instances/:id/pay marks payment', async () => {
    fixedRepo.findInstanceById.mockResolvedValueOnce({
      id: 'ins-1',
      fixed_expense_id: 'fx-1',
      fixed_expense_name: 'Alquiler',
      period_month: '2026-04-01',
      due_date: '2026-04-10',
      expected_amount: 200000,
      status: 'pendiente',
      movement_id: null,
      paid_at: null,
    });
    fixedRepo.findById.mockResolvedValueOnce({
      id: 'fx-1',
      name: 'Alquiler',
      aliases: ['alquiler'],
      amount: 200000,
      currency: 'ARS',
      category_id: 'cat-1',
      category_name: 'Vivienda',
      payment_method: 'efectivo',
      card_id: null,
      due_day: 10,
      is_active: true,
    });
    accountRepo.getOrCreateCashAccount.mockResolvedValueOnce({
      id: 'acc-1',
      name: 'Efectivo ARS',
      account_type: 'efectivo',
      currency: 'ARS',
    });
    txRepo.save.mockResolvedValueOnce({ id: 'mov-1' });
    fixedRepo.markInstancePaid.mockResolvedValueOnce(true);

    const res = await request(app.getHttpServer()).post('/fixed-expenses/instances/ins-1/pay');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, movement_id: 'mov-1' });
  });
});
