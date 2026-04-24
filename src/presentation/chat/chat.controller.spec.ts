import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { ProcessChatMessageUseCase } from '../../application/process-chat-message.use-case';
import {
  CHAT_PREFERENCES_REPOSITORY,
  ChatPreferencesRepositoryPort,
} from '../../domain/ports/chat-preferences.repository.port';
import { ChatController } from './chat.controller';

describe('Chat endpoints', () => {
  let app: INestApplication;

  const processChatMock = {
    execute: jest.fn(),
  } as Pick<ProcessChatMessageUseCase, 'execute'>;

  const preferencesMock: jest.Mocked<ChatPreferencesRepositoryPort> = {
    get: jest.fn(),
    update: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ProcessChatMessageUseCase, useValue: processChatMock },
        { provide: CHAT_PREFERENCES_REPOSITORY, useValue: preferencesMock },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /chat/messages returns 400 when message is missing', async () => {
    const res = await request(app.getHttpServer()).post('/chat/messages').send({});

    expect(res.status).toBe(400);
  });

  it('POST /chat/messages returns use case result', async () => {
    processChatMock.execute = jest
      .fn()
      .mockResolvedValueOnce({ saved: true, id: 'abc' });

    const res = await request(app.getHttpServer())
      .post('/chat/messages')
      .send({ message: 'Gaste 1000 en comida con tarjeta visa' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ saved: true, id: 'abc' });
    expect(processChatMock.execute).toHaveBeenCalledWith(
      'Gaste 1000 en comida con tarjeta visa',
      { autoCreateCategory: undefined, entryMode: undefined, usdArsRate: undefined },
    );
  });

  it('POST /chat/messages forwards auto_create_category=true', async () => {
    processChatMock.execute = jest
      .fn()
      .mockResolvedValueOnce({ saved: true, id: 'abc' });

    const res = await request(app.getHttpServer())
      .post('/chat/messages')
      .send({ message: 'Gasté 1000 en veterinaria', auto_create_category: true });

    expect(res.status).toBe(201);
    expect(processChatMock.execute).toHaveBeenCalledWith(
      'Gasté 1000 en veterinaria',
      { autoCreateCategory: true, entryMode: undefined, usdArsRate: undefined },
    );
  });

  it('POST /chat/messages forwards entry_mode=historico', async () => {
    processChatMock.execute = jest
      .fn()
      .mockResolvedValueOnce({ saved: true, id: 'abc' });

    const res = await request(app.getHttpServer()).post('/chat/messages').send({
      message: 'Cargá histórico de marzo',
      entry_mode: 'historico',
    });

    expect(res.status).toBe(201);
    expect(processChatMock.execute).toHaveBeenCalledWith(
      'Cargá histórico de marzo',
      { autoCreateCategory: undefined, entryMode: 'historico', usdArsRate: undefined },
    );
  });

  it('POST /chat/messages forwards usd_ars_rate', async () => {
    processChatMock.execute = jest.fn().mockResolvedValueOnce({ saved: true, id: 'abc' });

    const res = await request(app.getHttpServer()).post('/chat/messages').send({
      message: 'Gasté 5 usd con visa',
      usd_ars_rate: 1000,
    });

    expect(res.status).toBe(201);
    expect(processChatMock.execute).toHaveBeenCalledWith('Gasté 5 usd con visa', {
      autoCreateCategory: undefined,
      entryMode: undefined,
      usdArsRate: 1000,
    });
  });

  it('POST /chat/messages returns 400 when usd_ars_rate is invalid', async () => {
    const res = await request(app.getHttpServer()).post('/chat/messages').send({
      message: 'hola',
      usd_ars_rate: 0,
    });

    expect(res.status).toBe(400);
  });

  it('POST /chat/messages returns 400 when auto_create_category is invalid', async () => {
    const res = await request(app.getHttpServer())
      .post('/chat/messages')
      .send({ message: 'hola', auto_create_category: 'si' });

    expect(res.status).toBe(400);
  });

  it('POST /chat/messages returns 400 when entry_mode is invalid', async () => {
    const res = await request(app.getHttpServer()).post('/chat/messages').send({
      message: 'hola',
      entry_mode: 'legacy',
    });

    expect(res.status).toBe(400);
  });

  it('GET /chat/preferences returns persisted preferences', async () => {
    preferencesMock.get.mockResolvedValueOnce({
      auto_create_category_default: true,
      default_entry_mode: 'operativo',
      default_usd_ars_rate: null,
    });

    const res = await request(app.getHttpServer()).get('/chat/preferences');

    expect(res.status).toBe(200);
    expect(res.body.auto_create_category_default).toBe(true);
    expect(res.body.default_entry_mode).toBe('operativo');
    expect(res.body.default_usd_ars_rate).toBeNull();
  });

  it('PUT /chat/preferences updates persisted preferences with partial patch', async () => {
    preferencesMock.update.mockResolvedValueOnce({
      auto_create_category_default: false,
      default_entry_mode: 'historico',
      default_usd_ars_rate: null,
    });

    const res = await request(app.getHttpServer())
      .put('/chat/preferences')
      .send({ default_entry_mode: 'historico' });

    expect(res.status).toBe(200);
    expect(res.body.default_entry_mode).toBe('historico');
    expect(preferencesMock.update).toHaveBeenCalledWith({
      auto_create_category_default: undefined,
      default_entry_mode: 'historico',
      default_usd_ars_rate: undefined,
    });
  });

  it('PUT /chat/preferences accepts only default_usd_ars_rate', async () => {
    preferencesMock.update.mockResolvedValueOnce({
      auto_create_category_default: false,
      default_entry_mode: 'operativo',
      default_usd_ars_rate: 1300,
    });

    const res = await request(app.getHttpServer())
      .put('/chat/preferences')
      .send({ default_usd_ars_rate: 1300 });

    expect(res.status).toBe(200);
    expect(preferencesMock.update).toHaveBeenCalledWith({
      auto_create_category_default: undefined,
      default_entry_mode: undefined,
      default_usd_ars_rate: 1300,
    });
  });

  it('PUT /chat/preferences returns 400 when body is empty', async () => {
    const res = await request(app.getHttpServer()).put('/chat/preferences').send({});
    expect(res.status).toBe(400);
  });

  it('POST /chat/messages returns 500 when use case throws', async () => {
    processChatMock.execute = jest.fn().mockRejectedValueOnce(new Error('boom'));

    const res = await request(app.getHttpServer())
      .post('/chat/messages')
      .send({ message: 'hola' });

    expect(res.status).toBe(500);
    expect(res.text).toContain('boom');
  });
});
