import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  BUDGET_REPOSITORY,
  BudgetRepositoryPort,
} from '../../domain/ports/budget-repository.port';

class UpsertBudgetDto {
  category_id!: string;
  amount!: number;
  currency?: string;
  month?: string;
}

@Controller('budgets')
export class PresupuestosController {
  constructor(
    @Inject(BUDGET_REPOSITORY)
    private readonly budgets: BudgetRepositoryPort,
  ) {}

  @Get()
  async list(@Query('month') month?: string) {
    try {
      return await this.budgets.listActive(month);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('progress')
  async progress(@Query('month') month?: string) {
    const targetMonth = month ?? new Date().toISOString().slice(0, 10);
    try {
      return await this.budgets.getProgress(targetMonth);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Gastos reales por categoría en un rango (máx. 6 meses calendario).
   * Query: `month=YYYY-MM` (un mes) o `from=YYYY-MM-DD&to=YYYY-MM-DD` o sin params (últimos 6 meses).
   */
  @Get('real-spend')
  async realSpend(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('month') month?: string,
  ) {
    try {
      const range = resolveRealSpendRange({ from, to, month });
      return await this.budgets.getRealSpendAnalytics(range.from, range.to);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      if (
        msg.includes('inválido') ||
        msg.includes('superar 6 meses') ||
        msg.includes('Rango') ||
        msg.includes('mes')
      ) {
        throw new HttpException(msg, HttpStatus.BAD_REQUEST);
      }
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post()
  async upsert(@Body() body: UpsertBudgetDto) {
    if (typeof body?.category_id !== 'string' || !body.category_id.trim()) {
      throw new HttpException('Campo "category_id" requerido', HttpStatus.BAD_REQUEST);
    }
    if (typeof body?.amount !== 'number' || !Number.isFinite(body.amount) || body.amount <= 0) {
      throw new HttpException('Campo "amount" inválido', HttpStatus.BAD_REQUEST);
    }
    const month = body.month ?? new Date().toISOString().slice(0, 10);
    const currency =
      typeof body.currency === 'string' && body.currency.trim() ?
        body.currency.trim().toUpperCase()
      : 'ARS';
    try {
      return await this.budgets.upsertMonthly({
        category_id: body.category_id.trim(),
        amount: body.amount,
        currency,
        month,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Delete(':id')
  async close(@Param('id') id: string) {
    if (!id?.trim()) {
      throw new HttpException('id requerido', HttpStatus.BAD_REQUEST);
    }
    try {
      const ok = await this.budgets.closeActiveById(id.trim());
      if (!ok) {
        throw new HttpException('Presupuesto no encontrado', HttpStatus.NOT_FOUND);
      }
      return { ok: true };
    } catch (e) {
      if (e instanceof HttpException) throw e;
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}

function resolveRealSpendRange(params: {
  from?: string;
  to?: string;
  month?: string;
}): { from: string; to: string } {
  const monthRaw = params.month?.trim();
  if (monthRaw) {
    if (!/^\d{4}-\d{2}$/.test(monthRaw)) {
      throw new Error('Parámetro month inválido (usá YYYY-MM).');
    }
    const from = `${monthRaw}-01`;
    const y = Number(monthRaw.slice(0, 4));
    const m = Number(monthRaw.slice(5, 7));
    if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
      throw new Error('Parámetro month inválido.');
    }
    const to = lastDayOfMonthUtc(y, m);
    return { from, to };
  }

  const fromRaw = params.from?.trim();
  const toRaw = params.to?.trim();
  if (fromRaw || toRaw) {
    if (!fromRaw || !toRaw) {
      throw new Error('Enviá from y to (YYYY-MM-DD) o solo month=YYYY-MM.');
    }
    if (!isIsoYmd(fromRaw) || !isIsoYmd(toRaw)) {
      throw new Error('from/to inválidos (YYYY-MM-DD).');
    }
    if (fromRaw > toRaw) {
      throw new Error('from no puede ser mayor que to.');
    }
    const span = countCalendarMonthsInclusive(fromRaw, toRaw);
    if (span > 6) {
      throw new Error('El rango no puede superar 6 meses calendario.');
    }
    return { from: fromRaw, to: toRaw };
  }

  const { y: endY, m: endM } = utcYearMonthNow();
  const from = addMonthsFirstDayIso(endY, endM, -5);
  const to = lastDayOfMonthUtc(endY, endM);
  return { from, to };
}

function utcYearMonthNow(): { y: number; m: number } {
  const d = new Date();
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}

function lastDayOfMonthUtc(year: number, month1to12: number): string {
  const d = new Date(Date.UTC(year, month1to12, 0));
  return d.toISOString().slice(0, 10);
}

function addMonthsFirstDayIso(year: number, month1to12: number, deltaMonths: number): string {
  const idx0 = (year * 12 + (month1to12 - 1) + deltaMonths);
  const ny = Math.floor(idx0 / 12);
  const nm = (idx0 % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}

function isIsoYmd(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  return !Number.isNaN(Date.parse(`${v}T12:00:00.000Z`));
}

function monthStartContaining(isoYmd: string): string {
  const d = new Date(`${isoYmd}T12:00:00.000Z`);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

function countCalendarMonthsInclusive(fromIso: string, toIso: string): number {
  const a = monthStartContaining(fromIso);
  const b = monthStartContaining(toIso);
  const y1 = Number(a.slice(0, 4));
  const m1 = Number(a.slice(5, 7));
  const y2 = Number(b.slice(0, 4));
  const m2 = Number(b.slice(5, 7));
  return (y2 - y1) * 12 + (m2 - m1) + 1;
}
