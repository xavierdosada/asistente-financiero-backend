import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  NotFoundException,
  Patch,
  Param,
  Query,
} from '@nestjs/common';
import { isEntryMode } from '../../domain/ports/entry-mode.port';
import { SupabaseMovementQueryRepository } from '../../infrastructure/supabase/supabase-movement-query.repository';

@Controller('movements')
export class MovimientosController {
  constructor(private readonly movements: SupabaseMovementQueryRepository) {}

  @Patch(':id')
  async updateCategory(
    @Param('id') id: string,
    @Body() body?: { category_id?: string | null; detail?: string },
  ) {
    const trimmedId = id?.trim();
    if (!trimmedId) {
      throw new HttpException('id requerido', HttpStatus.BAD_REQUEST);
    }
    if (
      !body ||
      (!Object.prototype.hasOwnProperty.call(body, 'category_id') &&
        !Object.prototype.hasOwnProperty.call(body, 'detail'))
    ) {
      throw new HttpException('Enviá category_id o detail', HttpStatus.BAD_REQUEST);
    }
    const categoryIdRaw = body.category_id;
    const hasCategoryId = Object.prototype.hasOwnProperty.call(body, 'category_id');
    const categoryId =
      categoryIdRaw === null ? null
      : typeof categoryIdRaw === 'string' && categoryIdRaw.trim().length > 0 ? categoryIdRaw.trim()
      : undefined;
    if (hasCategoryId && categoryId === undefined) {
      throw new HttpException('category_id inválido', HttpStatus.BAD_REQUEST);
    }
    const detailRaw = body.detail;
    const detail =
      detailRaw === undefined ? undefined
      : typeof detailRaw === 'string' && detailRaw.trim().length > 0 ? detailRaw.trim()
      : null;
    if (detail === null) {
      throw new HttpException('detail inválido', HttpStatus.BAD_REQUEST);
    }

    try {
      const updated = await this.movements.updateById(trimmedId, {
        category_id:
          hasCategoryId ? categoryId : undefined,
        detail,
      });
      if (!updated) {
        throw new NotFoundException('Movimiento no encontrado');
      }
      return updated;
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      const msg = e instanceof Error ? e.message : 'Error interno';
      if (msg.includes('category_not_found')) {
        throw new HttpException('Categoría no encontrada', HttpStatus.BAD_REQUEST);
      }
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get()
  async list(
    @Query('limit') limit?: string,
    @Query('entry_mode') entryMode?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const resolvedLimit = limit ? Number(limit) : 100;
    if (!Number.isInteger(resolvedLimit) || resolvedLimit <= 0 || resolvedLimit > 500) {
      throw new HttpException('limit inválido (1..500)', HttpStatus.BAD_REQUEST);
    }
    if (entryMode !== undefined && !isEntryMode(entryMode)) {
      throw new HttpException(
        'entry_mode inválido (operativo|historico)',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (from !== undefined && !isIsoYmd(from)) {
      throw new HttpException('from inválido (YYYY-MM-DD)', HttpStatus.BAD_REQUEST);
    }
    if (to !== undefined && !isIsoYmd(to)) {
      throw new HttpException('to inválido (YYYY-MM-DD)', HttpStatus.BAD_REQUEST);
    }
    if (from && to && from > to) {
      throw new HttpException('from no puede ser mayor que to', HttpStatus.BAD_REQUEST);
    }

    try {
      return await this.movements.listRecent({
        limit: resolvedLimit,
        entryMode,
        from,
        to,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Body() body?: { reason?: string }) {
    if (!id?.trim()) {
      console.log('[movements.remove] rechazado: id vacío');
      throw new HttpException('id requerido', HttpStatus.BAD_REQUEST);
    }
    if (body?.reason !== undefined && typeof body.reason !== 'string') {
      console.log('[movements.remove] rechazado: reason inválido', { id: id.trim() });
      throw new HttpException('reason inválido', HttpStatus.BAD_REQUEST);
    }

    const trimmedId = id.trim();
    const reason = body?.reason?.trim() || null;
    console.log('[movements.remove] inicio', { id: trimmedId, reason });

    try {
      console.log('[movements.remove] llamando deleteById', { id: trimmedId, reason });
      const deleted = await this.movements.deleteById(trimmedId, reason);
      if (!deleted) {
        console.log('[movements.remove] no encontrado', { id: trimmedId });
        throw new NotFoundException('Movimiento no encontrado');
      }
      console.log('[movements.remove] ok', { id: trimmedId });
      return deleted;
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      console.log('[movements.remove] error', e);
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}

function isIsoYmd(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  return !Number.isNaN(Date.parse(`${v}T12:00:00.000Z`));
}
