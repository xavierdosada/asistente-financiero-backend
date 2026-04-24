import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import {
  ACCOUNT_REPOSITORY,
  AccountRepositoryPort,
} from '../../domain/ports/account-repository.port';
import { CajaController } from './caja.controller';

describe('Caja endpoints', () => {
  let app: INestApplication;

  const repo: jest.Mocked<AccountRepositoryPort> = {
    getOrCreateCashAccount: jest.fn(),
    setMonthlyOpening: jest.fn(),
    adjustMonthlyOpening: jest.fn(),
    monthlyCashHistory: jest.fn(),
    monthlyCashSummary: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [CajaController],
      providers: [{ provide: ACCOUNT_REPOSITORY, useValue: repo }],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /caja/resumen returns monthly summary', async () => {
    repo.monthlyCashSummary.mockResolvedValueOnce({
      year: 2026,
      month: 4,
      currency: 'ARS',
      account_id: 'acc-1',
      account_name: 'Caja',
      opening_balance: 10000,
      ajustes: 0,
      ingresos: 200000,
      gastos: 120000,
      neto_movimientos: 80000,
      saldo: 90000,
    });

    const res = await request(app.getHttpServer()).get('/caja/resumen?year=2026&month=4&currency=ARS');

    expect(res.status).toBe(200);
    expect(res.body.saldo).toBe(90000);
    expect(repo.monthlyCashSummary).toHaveBeenCalledWith(2026, 4, 'operativo', 'ARS');
  });

  it('GET /caja/resumen returns 400 when month is invalid', async () => {
    const res = await request(app.getHttpServer()).get('/caja/resumen?month=13');

    expect(res.status).toBe(400);
  });

  it('GET /caja/resumen supports USD summary', async () => {
    repo.monthlyCashSummary.mockResolvedValueOnce({
      year: 2026,
      month: 4,
      currency: 'USD',
      account_id: 'acc-usd',
      account_name: 'Caja USD',
      opening_balance: 1500,
      ajustes: 0,
      ingresos: 200,
      gastos: 50,
      neto_movimientos: 150,
      saldo: 1650,
    });

    const res = await request(app.getHttpServer()).get('/caja/resumen?year=2026&month=4&currency=USD');
    expect(res.status).toBe(200);
    expect(res.body.currency).toBe('USD');
    expect(repo.monthlyCashSummary).toHaveBeenCalledWith(2026, 4, 'operativo', 'USD');
  });

  it('POST /caja/apertura creates or updates monthly opening', async () => {
    repo.setMonthlyOpening.mockResolvedValueOnce({
      year: 2026,
      month: 4,
      currency: 'ARS',
      account_id: 'acc-1',
      account_name: 'Caja',
      opening_balance: 150000,
    });

    const res = await request(app.getHttpServer()).post('/caja/apertura').send({
      year: 2026,
      month: 4,
      opening_balance: 150000,
      currency: 'ARS',
    });

    expect(res.status).toBe(201);
    expect(res.body.opening_balance).toBe(150000);
    expect(repo.setMonthlyOpening).toHaveBeenCalledWith(2026, 4, 150000, 'ARS');
  });

  it('POST /caja/apertura supports USD opening', async () => {
    repo.setMonthlyOpening.mockResolvedValueOnce({
      year: 2026,
      month: 4,
      currency: 'USD',
      account_id: 'acc-usd',
      account_name: 'Caja USD',
      opening_balance: 1500,
    });

    const res = await request(app.getHttpServer()).post('/caja/apertura').send({
      year: 2026,
      month: 4,
      opening_balance: 1500,
      currency: 'USD',
    });

    expect(res.status).toBe(201);
    expect(res.body.currency).toBe('USD');
  });

  it('POST /caja/ajuste creates an append-only adjustment', async () => {
    repo.adjustMonthlyOpening.mockResolvedValueOnce({
      id: 'adj-1',
      year: 2026,
      month: 4,
      currency: 'ARS',
      account_id: 'acc-1',
      account_name: 'Caja',
      previous_balance: 150000,
      new_balance: 147500,
      adjustment_amount: -2500,
      reason: 'Arqueo de mitad de mes',
      created_at: new Date().toISOString(),
    });

    const res = await request(app.getHttpServer()).post('/caja/ajuste').send({
      year: 2026,
      month: 4,
      new_balance: 147500,
      reason: 'Arqueo de mitad de mes',
      currency: 'ARS',
    });

    expect(res.status).toBe(201);
    expect(res.body.adjustment_amount).toBe(-2500);
    expect(repo.adjustMonthlyOpening).toHaveBeenCalledWith(
      2026,
      4,
      147500,
      'Arqueo de mitad de mes',
      'ARS',
    );
  });

  it('GET /caja/historial returns opening and monthly adjustments', async () => {
    repo.monthlyCashHistory.mockResolvedValueOnce({
      year: 2026,
      month: 4,
      currency: 'ARS',
      account_id: 'acc-1',
      account_name: 'Caja',
      opening_balance: 150000,
      current_opening_balance: 147500,
      adjustments: [
        {
          id: 'adj-1',
          year: 2026,
          month: 4,
          currency: 'ARS',
          account_id: 'acc-1',
          account_name: 'Caja',
          previous_balance: 150000,
          new_balance: 147500,
          adjustment_amount: -2500,
          reason: 'Arqueo de mitad de mes',
          created_at: new Date().toISOString(),
        },
      ],
    });

    const res = await request(app.getHttpServer()).get('/caja/historial?year=2026&month=4&currency=ARS');

    expect(res.status).toBe(200);
    expect(res.body.current_opening_balance).toBe(147500);
    expect(res.body.adjustments).toHaveLength(1);
    expect(repo.monthlyCashHistory).toHaveBeenCalledWith(2026, 4, 'ARS');
  });

  it('GET /caja/resumen returns 400 for invalid currency', async () => {
    const res = await request(app.getHttpServer()).get('/caja/resumen?year=2026&month=4&currency=EUR');
    expect(res.status).toBe(400);
  });

  it('POST /caja/apertura returns 400 for invalid payload', async () => {
    const res = await request(app.getHttpServer()).post('/caja/apertura').send({
      year: 2026,
      month: 0,
      opening_balance: -10,
    });

    expect(res.status).toBe(400);
  });

  it('POST /caja/ajuste returns 400 when reason is missing', async () => {
    const res = await request(app.getHttpServer()).post('/caja/ajuste').send({
      year: 2026,
      month: 4,
      new_balance: 1000,
      reason: ' ',
    });

    expect(res.status).toBe(400);
  });
});
