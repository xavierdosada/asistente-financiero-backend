import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Query,
} from '@nestjs/common';
import {
  ACCOUNT_REPOSITORY,
  AccountRepositoryPort,
} from '../../domain/ports/account-repository.port';

class CajaAperturaDto {
  year!: number;
  month!: number;
  opening_balance!: number;
  currency?: string;
}

class CajaAjusteDto {
  year!: number;
  month!: number;
  new_balance!: number;
  reason!: string;
  currency?: string;
}

@Controller('caja')
export class CajaController {
  constructor(
    @Inject(ACCOUNT_REPOSITORY)
    private readonly accounts: AccountRepositoryPort,
  ) {}

  @Get('resumen')
  async resumen(
    @Query('year') year?: string,
    @Query('month') month?: string,
    @Query('currency') currency?: string,
  ) {
    const now = new Date();
    const y = year ? Number(year) : now.getUTCFullYear();
    const m = month ? Number(month) : now.getUTCMonth() + 1;

    const ccy = normalizeCurrency(currency);

    if (!Number.isInteger(y) || y < 2000 || y > 2100) {
      throw new HttpException('year inválido', HttpStatus.BAD_REQUEST);
    }
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      throw new HttpException('month inválido', HttpStatus.BAD_REQUEST);
    }

    try {
      return await this.accounts.monthlyCashSummary(y, m, 'operativo', ccy);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('apertura')
  async apertura(@Body() body: CajaAperturaDto) {
    const y = Number(body?.year);
    const m = Number(body?.month);
    const openingBalance = Number(body?.opening_balance);
    const ccy = normalizeCurrency(body?.currency);

    if (!Number.isInteger(y) || y < 2000 || y > 2100) {
      throw new HttpException('year inválido', HttpStatus.BAD_REQUEST);
    }
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      throw new HttpException('month inválido', HttpStatus.BAD_REQUEST);
    }
    if (!Number.isFinite(openingBalance) || openingBalance < 0) {
      throw new HttpException('opening_balance inválido', HttpStatus.BAD_REQUEST);
    }

    try {
      return await this.accounts.setMonthlyOpening(y, m, openingBalance, ccy);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      const status = msg.includes('ya existe')
        ? HttpStatus.CONFLICT
        : HttpStatus.INTERNAL_SERVER_ERROR;
      throw new HttpException(msg, status);
    }
  }

  @Post('ajuste')
  async ajuste(@Body() body: CajaAjusteDto) {
    const y = Number(body?.year);
    const m = Number(body?.month);
    const newBalance = Number(body?.new_balance);
    const reason = String(body?.reason ?? '').trim();
    const ccy = normalizeCurrency(body?.currency);

    if (!Number.isInteger(y) || y < 2000 || y > 2100) {
      throw new HttpException('year inválido', HttpStatus.BAD_REQUEST);
    }
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      throw new HttpException('month inválido', HttpStatus.BAD_REQUEST);
    }
    if (!Number.isFinite(newBalance) || newBalance < 0) {
      throw new HttpException('new_balance inválido', HttpStatus.BAD_REQUEST);
    }
    if (!reason) {
      throw new HttpException('reason es obligatorio', HttpStatus.BAD_REQUEST);
    }

    try {
      return await this.accounts.adjustMonthlyOpening(y, m, newBalance, reason, ccy);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('historial')
  async historial(
    @Query('year') year?: string,
    @Query('month') month?: string,
    @Query('currency') currency?: string,
  ) {
    const now = new Date();
    const y = year ? Number(year) : now.getUTCFullYear();
    const m = month ? Number(month) : now.getUTCMonth() + 1;
    const ccy = normalizeCurrency(currency);

    if (!Number.isInteger(y) || y < 2000 || y > 2100) {
      throw new HttpException('year inválido', HttpStatus.BAD_REQUEST);
    }
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      throw new HttpException('month inválido', HttpStatus.BAD_REQUEST);
    }

    try {
      return await this.accounts.monthlyCashHistory(y, m, ccy);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}

function normalizeCurrency(currency?: string): string {
  const c = (currency ?? 'ARS').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) {
    throw new HttpException(
      'currency inválida: use código ISO de 3 letras',
      HttpStatus.BAD_REQUEST,
    );
  }
  if (c !== 'ARS' && c !== 'USD') {
    throw new HttpException('currency no soportada: use ARS o USD', HttpStatus.BAD_REQUEST);
  }
  return c;
}
