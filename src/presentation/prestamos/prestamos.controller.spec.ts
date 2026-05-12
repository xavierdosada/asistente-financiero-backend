import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import {
  LOAN_REPOSITORY,
  LoanRepositoryPort,
} from '../../domain/ports/loan-repository.port';
import { PrestamosController } from './prestamos.controller';

describe('Prestamos endpoints', () => {
  let app: INestApplication;

  const repo: jest.Mocked<LoanRepositoryPort> = {
    list: jest.fn(),
    findById: jest.fn(),
    installmentsByLoanId: jest.fn(),
    listPayments: jest.fn(),
    updateCurrentMonthInstallment: jest.fn(),
    adjustPayment: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    deleteById: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [PrestamosController],
      providers: [{ provide: LOAN_REPOSITORY, useValue: repo }],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /prestamos returns list', async () => {
    repo.list.mockResolvedValueOnce([
      {
        id: '1',
        name: 'Prestamo personal',
        lender: 'Banco X',
        currency: 'ARS',
        principal_amount: 1200000,
        installment_amount: 100000,
        outstanding_amount: 800000,
        total_installments: 12,
        installments_paid: 4,
        installments_remaining: 8,
        first_due_date: '2026-01-10',
        status: 'activa',
        annual_rate: null,
        notes: null,
      },
    ]);

    const res = await request(app.getHttpServer()).get('/prestamos');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('POST /prestamos creates loan with installments_started', async () => {
    repo.create.mockResolvedValueOnce({
      id: '1',
      name: 'Prestamo personal',
      lender: 'Banco X',
      currency: 'ARS',
      principal_amount: 1200000,
      installment_amount: 100000,
      outstanding_amount: 800000,
      total_installments: 12,
      installments_paid: 4,
      installments_remaining: 8,
      first_due_date: '2026-01-10',
      status: 'activa',
      annual_rate: null,
      notes: null,
    });

    const res = await request(app.getHttpServer()).post('/prestamos').send({
      name: 'Prestamo personal',
      lender: 'Banco X',
      principal_amount: 1200000,
      installment_amount: 100000,
      outstanding_amount: 800000,
      total_installments: 12,
      installments_paid: 4,
      first_due_date: '2026-01-10',
    });

    expect(res.status).toBe(201);
    expect(res.body.installments_remaining).toBe(8);
    expect(repo.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ outstanding_amount: expect.anything() }),
    );
  });

  it('PATCH /prestamos/:id updates loan', async () => {
    repo.update.mockResolvedValueOnce({
      id: '1',
      name: 'Prestamo personal',
      lender: 'Banco X',
      currency: 'ARS',
      principal_amount: 1200000,
      installment_amount: 100000,
      outstanding_amount: 700000,
      total_installments: 12,
      installments_paid: 5,
      installments_remaining: 7,
      first_due_date: '2026-01-10',
      status: 'activa',
      annual_rate: null,
      notes: null,
    });

    const res = await request(app.getHttpServer())
      .patch('/prestamos/1')
      .send({ installments_paid: 5, outstanding_amount: 999999 });

    expect(res.status).toBe(200);
    expect(res.body.installments_paid).toBe(5);
    expect(repo.update).toHaveBeenCalledWith(
      '1',
      expect.not.objectContaining({ outstanding_amount: expect.anything() }),
    );
  });

  it('POST /prestamos returns 400 for invalid currency', async () => {
    const res = await request(app.getHttpServer()).post('/prestamos').send({
      name: 'Prestamo personal',
      lender: 'Banco X',
      currency: 'EUR',
      principal_amount: 1200000,
      installment_amount: 100000,
      outstanding_amount: 800000,
      total_installments: 12,
      installments_paid: 4,
      first_due_date: '2026-01-10',
    });

    expect(res.status).toBe(400);
  });

  it('GET /prestamos/:id/cuotas returns installments', async () => {
    repo.installmentsByLoanId.mockResolvedValueOnce([
      {
        id: 'q1',
        loan_id: '1',
        installment_number: 1,
        due_date: '2026-01-10',
        amount: 100000,
        paid_amount: 100000,
        status: 'pagada',
        paid_at: '2026-01-10',
      },
      {
        id: 'q2',
        loan_id: '1',
        installment_number: 2,
        due_date: '2026-02-10',
        amount: 100000,
        paid_amount: 0,
        status: 'pendiente',
        paid_at: null,
      },
    ]);

    const res = await request(app.getHttpServer()).get('/prestamos/1/cuotas');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[1].status).toBe('pendiente');
  });

  it('GET /prestamos/pagos returns loan payments list', async () => {
    repo.listPayments.mockResolvedValueOnce([
      {
        id: 'pay-1',
        loan_id: '1',
        loan_name: 'Prestamo personal',
        movement_id: 'mov-1',
        amount: 100000,
        currency: 'ARS',
        detail: 'Pago cuota préstamo',
        payment_date: '2026-04-15',
        movement_date: '2026-04-15',
        created_at: '2026-04-15T12:00:00.000Z',
      },
    ]);

    const res = await request(app.getHttpServer()).get('/prestamos/pagos');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].amount).toBe(100000);
  });

  it('PATCH /prestamos/:id/cuota-actual updates current month installment', async () => {
    repo.updateCurrentMonthInstallment.mockResolvedValueOnce({
      loan: {
        id: '1',
        name: 'Prestamo personal',
        lender: 'Banco X',
        currency: 'ARS',
        principal_amount: 1200000,
        installment_amount: 100000,
        outstanding_amount: 700000,
        total_installments: 12,
        installments_paid: 5,
        installments_remaining: 7,
        first_due_date: '2026-01-10',
        status: 'activa',
        annual_rate: null,
        notes: null,
      },
      installment: {
        id: 'inst-1',
        loan_id: '1',
        installment_number: 5,
        due_date: '2026-04-10',
        amount: 120000,
        paid_amount: 0,
        status: 'pendiente',
        paid_at: null,
      },
    });

    const res = await request(app.getHttpServer())
      .patch('/prestamos/1/cuota-actual')
      .send({ amount: 120000 });
    expect(res.status).toBe(200);
    expect(res.body.installment.amount).toBe(120000);
  });

  it('PATCH /prestamos/:id/pagos/:paymentId adjusts payment', async () => {
    repo.adjustPayment.mockResolvedValueOnce({
      id: 'pay-2',
      loan_id: '1',
      loan_name: 'Prestamo personal',
      movement_id: 'mov-2',
      amount: 120000,
      currency: 'ARS',
      detail: 'Pago préstamo ajustado',
      payment_date: '2026-04-20',
      movement_date: '2026-04-20',
      created_at: '2026-04-20T12:00:00.000Z',
    });

    const res = await request(app.getHttpServer())
      .patch('/prestamos/1/pagos/pay-1')
      .send({ amount: 120000, payment_date: '2026-04-20' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('pay-2');
  });
});
