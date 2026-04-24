import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import {
  BUDGET_REPOSITORY,
  BudgetRepositoryPort,
} from '../../domain/ports/budget-repository.port';
import { PresupuestosController } from './presupuestos.controller';

describe('Presupuestos endpoints', () => {
  let app: INestApplication;

  const repo: jest.Mocked<BudgetRepositoryPort> = {
    listActive: jest.fn(),
    upsertMonthly: jest.fn(),
    closeActiveById: jest.fn(),
    getProgress: jest.fn(),
    getCategoryMonthlyProgress: jest.fn(),
    getRealSpendAnalytics: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [PresupuestosController],
      providers: [{ provide: BUDGET_REPOSITORY, useValue: repo }],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /budgets returns list', async () => {
    repo.listActive.mockResolvedValueOnce([]);
    const res = await request(app.getHttpServer()).get('/budgets');
    expect(res.status).toBe(200);
    expect(repo.listActive).toHaveBeenCalled();
  });

  it('GET /budgets/progress returns list', async () => {
    repo.getProgress.mockResolvedValueOnce([]);
    const res = await request(app.getHttpServer()).get('/budgets/progress');
    expect(res.status).toBe(200);
    expect(repo.getProgress).toHaveBeenCalled();
  });

  it('GET /budgets/real-spend uses default range when no query', async () => {
    repo.getRealSpendAnalytics.mockResolvedValueOnce({
      from: '2025-11-01',
      to: '2026-04-30',
      months_in_range: 6,
      categories: [],
    });
    const res = await request(app.getHttpServer()).get('/budgets/real-spend');
    expect(res.status).toBe(200);
    expect(repo.getRealSpendAnalytics).toHaveBeenCalled();
  });

  it('GET /budgets/real-spend accepts month=YYYY-MM', async () => {
    repo.getRealSpendAnalytics.mockResolvedValueOnce({
      from: '2026-04-01',
      to: '2026-04-30',
      months_in_range: 1,
      categories: [],
    });
    const res = await request(app.getHttpServer()).get('/budgets/real-spend?month=2026-04');
    expect(res.status).toBe(200);
    expect(repo.getRealSpendAnalytics).toHaveBeenCalledWith('2026-04-01', '2026-04-30');
  });

  it('GET /budgets/real-spend returns 400 when range exceeds 6 months', async () => {
    const res = await request(app.getHttpServer()).get(
      '/budgets/real-spend?from=2025-01-01&to=2025-08-31',
    );
    expect(res.status).toBe(400);
    expect(repo.getRealSpendAnalytics).not.toHaveBeenCalled();
  });

  it('POST /budgets validates payload', async () => {
    const res = await request(app.getHttpServer()).post('/budgets').send({ amount: 1000 });
    expect(res.status).toBe(400);
  });

  it('POST /budgets upserts monthly budget', async () => {
    repo.upsertMonthly.mockResolvedValueOnce({
      id: '1',
      category_id: 'cat',
      category_name: 'Comida',
      currency: 'ARS',
      amount: 1000,
      active_from: '2026-04-01',
      active_to: null,
    });
    const res = await request(app.getHttpServer())
      .post('/budgets')
      .send({ category_id: 'cat', amount: 1000, currency: 'ARS', month: '2026-04-01' });
    expect(res.status).toBe(201);
    expect(repo.upsertMonthly).toHaveBeenCalledWith({
      category_id: 'cat',
      amount: 1000,
      currency: 'ARS',
      month: '2026-04-01',
    });
  });

  it('DELETE /budgets/:id closes active budget', async () => {
    repo.closeActiveById.mockResolvedValueOnce(true);
    const res = await request(app.getHttpServer()).delete('/budgets/1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
