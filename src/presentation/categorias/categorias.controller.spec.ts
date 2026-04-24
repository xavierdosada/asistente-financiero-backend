import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import {
  CATEGORIA_REPOSITORY,
  CategoriaRepositoryPort,
} from '../../domain/ports/categoria-repository.port';
import { CategoriasController } from './categorias.controller';

describe('Categorias endpoints', () => {
  let app: INestApplication;

  const repo: jest.Mocked<CategoriaRepositoryPort> = {
    list: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    deleteById: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [CategoriasController],
      providers: [{ provide: CATEGORIA_REPOSITORY, useValue: repo }],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /categorias returns list', async () => {
    repo.list.mockResolvedValueOnce([{ id: '1', nombre: 'Comida', icon_key: null }]);

    const res = await request(app.getHttpServer()).get('/categorias');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: '1', nombre: 'Comida', icon_key: null }]);
  });

  it('GET /categorias/:id returns 404 when missing', async () => {
    repo.findById.mockResolvedValueOnce(null);

    const res = await request(app.getHttpServer()).get('/categorias/abc');

    expect(res.status).toBe(404);
  });

  it('POST /categorias returns 400 for invalid body', async () => {
    const res = await request(app.getHttpServer())
      .post('/categorias')
      .send({ nombre: '   ' });

    expect(res.status).toBe(400);
  });

  it('POST /categorias creates category', async () => {
    repo.create.mockResolvedValueOnce({ id: '1', nombre: 'Servicios', icon_key: null });

    const res = await request(app.getHttpServer())
      .post('/categorias')
      .send({ nombre: 'Servicios' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: '1', nombre: 'Servicios', icon_key: null });
    expect(repo.create).toHaveBeenCalledWith('Servicios', undefined);
  });

  it('POST /categorias accepts icon_key', async () => {
    repo.create.mockResolvedValueOnce({ id: '1', nombre: 'Servicios', icon_key: 'Wallet' });

    const res = await request(app.getHttpServer())
      .post('/categorias')
      .send({ nombre: 'Servicios', icon_key: 'Wallet' });

    expect(res.status).toBe(201);
    expect(repo.create).toHaveBeenCalledWith('Servicios', 'Wallet');
  });

  it('PATCH /categorias/:id updates category', async () => {
    repo.update.mockResolvedValueOnce({ id: '1', nombre: 'Supermercado', icon_key: null });

    const res = await request(app.getHttpServer())
      .patch('/categorias/1')
      .send({ nombre: 'Supermercado' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: '1', nombre: 'Supermercado', icon_key: null });
    expect(repo.update).toHaveBeenCalledWith('1', { nombre: 'Supermercado' });
  });

  it('PATCH /categorias/:id updates icon_key only', async () => {
    repo.update.mockResolvedValueOnce({ id: '1', nombre: 'Comida', icon_key: 'Coffee' });

    const res = await request(app.getHttpServer())
      .patch('/categorias/1')
      .send({ icon_key: 'Coffee' });

    expect(res.status).toBe(200);
    expect(repo.update).toHaveBeenCalledWith('1', { icon_key: 'Coffee' });
  });

  it('DELETE /categorias/:id returns ok true', async () => {
    repo.deleteById.mockResolvedValueOnce();

    const res = await request(app.getHttpServer()).delete('/categorias/1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
