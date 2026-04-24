import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  CATEGORIA_REPOSITORY,
  CategoriaRepositoryPort,
} from '../../domain/ports/categoria-repository.port';

class CreateCategoriaDto {
  nombre!: string;
  icon_key?: string | null;
}

class UpdateCategoriaDto {
  nombre?: string;
  icon_key?: string | null;
}

function parseIconKeyInput(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    throw new HttpException('Campo "icon_key" inválido', HttpStatus.BAD_REQUEST);
  }
  const t = raw.trim();
  return t ? t.slice(0, 64) : null;
}

@Controller('categorias')
export class CategoriasController {
  constructor(
    @Inject(CATEGORIA_REPOSITORY)
    private readonly categorias: CategoriaRepositoryPort,
  ) {}

  @Get()
  async list() {
    try {
      return await this.categorias.list();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id')
  async getOne(@Param('id') id: string) {
    if (!id?.trim()) {
      throw new HttpException('id requerido', HttpStatus.BAD_REQUEST);
    }
    try {
      const row = await this.categorias.findById(id.trim());
      if (!row) throw new NotFoundException('Categoría no encontrada');
      return row;
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post()
  async create(@Body() body: CreateCategoriaDto) {
    const nombre = body?.nombre;
    if (typeof nombre !== 'string' || !nombre.trim()) {
      throw new HttpException('Campo "nombre" requerido', HttpStatus.BAD_REQUEST);
    }
    let iconKey: string | null | undefined;
    if (body && 'icon_key' in body) {
      iconKey = parseIconKeyInput(body.icon_key);
    }
    try {
      return await this.categorias.create(nombre.trim(), iconKey);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: UpdateCategoriaDto) {
    if (!id?.trim()) {
      throw new HttpException('id requerido', HttpStatus.BAD_REQUEST);
    }
    const patch: { nombre?: string; icon_key?: string | null } = {};
    if (body && 'nombre' in body) {
      const nombre = body.nombre;
      if (typeof nombre !== 'string' || !nombre.trim()) {
        throw new HttpException('Campo "nombre" inválido o vacío', HttpStatus.BAD_REQUEST);
      }
      patch.nombre = nombre.trim();
    }
    if (body && 'icon_key' in body) {
      const parsedIcon = parseIconKeyInput(body.icon_key);
      if (parsedIcon !== undefined) {
        patch.icon_key = parsedIcon;
      }
    }
    if (Object.keys(patch).length === 0) {
      throw new HttpException('Enviá al menos "nombre" o "icon_key"', HttpStatus.BAD_REQUEST);
    }
    try {
      const row = await this.categorias.update(id.trim(), patch);
      if (!row) throw new NotFoundException('Categoría no encontrada');
      return row;
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    if (!id?.trim()) {
      throw new HttpException('id requerido', HttpStatus.BAD_REQUEST);
    }
    try {
      await this.categorias.deleteById(id.trim());
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
