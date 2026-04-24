import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { ProcessAdvisorMessageUseCase } from '../../application/process-advisor-message.use-case';
import { AsesorController } from './asesor.controller';

describe('Asesor endpoints', () => {
  let app: INestApplication;

  const useCaseMock = {
    execute: jest.fn(),
  } as Pick<ProcessAdvisorMessageUseCase, 'execute'>;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AsesorController],
      providers: [{ provide: ProcessAdvisorMessageUseCase, useValue: useCaseMock }],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /asesor/messages returns 400 when message missing', async () => {
    const res = await request(app.getHttpServer()).post('/asesor/messages').send({});

    expect(res.status).toBe(400);
  });

  it('POST /asesor/messages returns advisor response', async () => {
    useCaseMock.execute = jest.fn().mockResolvedValueOnce({
      intent: 'loans_status',
      answer: 'Tenés 2 préstamos activos.',
      data: { prestamos: [] },
    });

    const res = await request(app.getHttpServer())
      .post('/asesor/messages')
      .send({ message: 'Cómo vengo con mis préstamos?' });

    expect(res.status).toBe(201);
    expect(res.body.intent).toBe('loans_status');
  });

  it('POST /asesor/messages forwards scope to use case', async () => {
    useCaseMock.execute = jest.fn().mockResolvedValueOnce({
      intent: 'cash_status',
      answer: 'ok',
      data: {},
    });

    const res = await request(app.getHttpServer())
      .post('/asesor/messages')
      .send({ message: 'Caja abril', scope: 'historico' });

    expect(res.status).toBe(201);
    expect(useCaseMock.execute).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'historico' }),
    );
  });

  it('POST /asesor/messages returns 400 for invalid scope', async () => {
    const res = await request(app.getHttpServer())
      .post('/asesor/messages')
      .send({ message: 'Caja abril', scope: 'legacy' });
    expect(res.status).toBe(400);
  });
});
