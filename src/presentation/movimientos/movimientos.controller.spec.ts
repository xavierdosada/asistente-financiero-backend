import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { SupabaseMovementQueryRepository } from '../../infrastructure/supabase/supabase-movement-query.repository';
import { MovimientosController } from './movimientos.controller';

describe('Movimientos endpoints', () => {
  let app: INestApplication;

  const repo: jest.Mocked<
    Pick<SupabaseMovementQueryRepository, 'listRecent' | 'deleteById' | 'updateById'>
  > = {
    listRecent: jest.fn(),
    deleteById: jest.fn(),
    updateById: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [MovimientosController],
      providers: [{ provide: SupabaseMovementQueryRepository, useValue: repo }],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /movements returns list', async () => {
    repo.listRecent.mockResolvedValueOnce([
      {
        id: 'mov-1',
        direction: 'gasto',
        amount: 1000,
        currency: 'ARS',
        detail: 'almuerzo',
        payment_method: 'efectivo',
        movement_date: '2026-04-10',
        entry_mode: 'operativo',
        category_id: 'cat-1',
        card_id: null,
        loan_id: null,
        settled_card_id: null,
        installments_total: null,
        installment_number: null,
        created_at: '2026-04-10T12:00:00Z',
        fx_ars_per_usd: null,
      },
    ]);

    const res = await request(app.getHttpServer()).get('/movements?limit=10');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('GET /movements returns 400 for invalid entry_mode', async () => {
    const res = await request(app.getHttpServer()).get('/movements?entry_mode=foo');

    expect(res.status).toBe(400);
  });

  it('DELETE /movements/:id deletes movement', async () => {
    repo.deleteById.mockResolvedValueOnce({
      deleted: true,
      already_deleted: false,
      movement_id: 'mov-1',
      reversed_goal_contributions: 0,
      reversed_budget_consumptions: 1,
      reversed_loan_allocations: 0,
      recalculated_loan_installments: 0,
      reversed_movement_effects: 1,
      recalculated_card_statements: 1,
      deleted_card_installment_debts: 1,
    });

    const res = await request(app.getHttpServer())
      .delete('/movements/mov-1')
      .send({ reason: 'Carga incorrecta' });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.movement_id).toBe('mov-1');
  });

  it('PATCH /movements/:id updates category_id', async () => {
    repo.updateById.mockResolvedValueOnce({
      id: 'mov-1',
      category_id: 'cat-2',
      detail: 'almuerzo',
    });

    const res = await request(app.getHttpServer())
      .patch('/movements/mov-1')
      .send({ category_id: 'cat-2' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: 'mov-1',
      category_id: 'cat-2',
      detail: 'almuerzo',
    });
  });

  it('PATCH /movements/:id returns 400 when category_id missing', async () => {
    const res = await request(app.getHttpServer())
      .patch('/movements/mov-1')
      .send({});
    expect(res.status).toBe(400);
  });

  it('PATCH /movements/:id returns 400 when category not found', async () => {
    repo.updateById.mockRejectedValueOnce(new Error('category_not_found'));

    const res = await request(app.getHttpServer())
      .patch('/movements/mov-1')
      .send({ category_id: 'cat-x' });
    expect(res.status).toBe(400);
  });

  it('PATCH /movements/:id returns 404 when movement not found', async () => {
    repo.updateById.mockResolvedValueOnce(null);

    const res = await request(app.getHttpServer())
      .patch('/movements/mov-x')
      .send({ category_id: 'cat-2' });
    expect(res.status).toBe(404);
  });

  it('PATCH /movements/:id updates detail', async () => {
    repo.updateById.mockResolvedValueOnce({
      id: 'mov-1',
      category_id: 'cat-1',
      detail: 'Cena con amigos',
    });

    const res = await request(app.getHttpServer())
      .patch('/movements/mov-1')
      .send({ detail: 'Cena con amigos' });

    expect(res.status).toBe(200);
    expect(res.body.detail).toBe('Cena con amigos');
  });
});
