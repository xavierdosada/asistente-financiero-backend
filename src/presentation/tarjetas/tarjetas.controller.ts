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
  Query,
} from '@nestjs/common';
import {
  TARJETA_REPOSITORY,
  TarjetaRepositoryPort,
  isTypeCard,
} from '../../domain/ports/tarjeta-repository.port';
import { isEntryScope } from '../../domain/ports/entry-mode.port';
import { parseMoneyAmountInput } from '../../lib/parse-money-amount';

/** Ejemplo: { "bank": "NARANJA", "type_card": "credito", "payment_card": "VISA" } */
class CreateTarjetaDto {
  bank!: string;
  type_card!: string;
  payment_card!: string;
  closing_day!: number;
  due_day?: number | null;
  credit_limit?: number | null;
}

class UpdateTarjetaDto {
  bank?: string;
  type_card?: string;
  payment_card?: string;
  closing_day?: number;
  due_day?: number | null;
  apply_due_day_to_current?: boolean;
  credit_limit?: number | null;
}

class GenerateStatementDto {
  year?: number;
  month?: number;
  opened_at?: string;
  closed_at?: string;
  due_date?: string;
}

class UpdateStatementWindowDto {
  opened_at?: string;
  closed_at?: string;
  due_date?: string;
}

class SetInitialDebtDto {
  year!: number;
  month!: number;
  /** Número JSON o string con formato es-AR (ej. `892754,96` o `"892.754,96"`). */
  outstanding_amount!: number | string;
  due_date?: string;
}

@Controller('tarjetas')
export class TarjetasController {
  constructor(
    @Inject(TARJETA_REPOSITORY)
    private readonly tarjetas: TarjetaRepositoryPort,
  ) {}

  @Get()
  async list() {
    try {
      return await this.tarjetas.list();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('deuda-total')
  async totalDebt() {
    try {
      return await this.tarjetas.totalDebtAllCreditCards();
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
      const row = await this.tarjetas.findById(id.trim());
      if (!row) throw new NotFoundException('Tarjeta no encontrada');
      return row;
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/resumen')
  async usageSummary(@Param('id') id: string) {
    if (!id?.trim()) {
      throw new HttpException('id requerido', HttpStatus.BAD_REQUEST);
    }
    try {
      const summary = await this.tarjetas.usageSummaryById(id.trim());
      if (!summary) throw new NotFoundException('Tarjeta no encontrada');
      return summary;
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/deudas')
  async debts(@Param('id') id: string) {
    if (!id?.trim()) {
      throw new HttpException('id requerido', HttpStatus.BAD_REQUEST);
    }
    try {
      const rows = await this.tarjetas.debtsByCardId(id.trim());
      if (!rows) throw new NotFoundException('Tarjeta no encontrada');
      return rows;
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/cuotas-pendientes')
  async pendingInstallments(@Param('id') id: string) {
    if (!id?.trim()) {
      throw new HttpException('id requerido', HttpStatus.BAD_REQUEST);
    }
    const cardId = id.trim();
    try {
      const result = await this.tarjetas.pendingInstallmentsByCardId(cardId);
      if (!result) {
        throw new NotFoundException('Tarjeta no encontrada');
      }
      return result;
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/resumenes')
  async listStatements(@Param('id') id: string) {
    if (!id?.trim()) {
      throw new HttpException('id requerido', HttpStatus.BAD_REQUEST);
    }
    try {
      const rows = await this.tarjetas.listStatementsByCardId(id.trim());
      if (!rows) throw new NotFoundException('Tarjeta no encontrada');
      return rows;
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/gastos')
  async spendByRange(
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('scope') scope?: string,
  ) {
    if (!id?.trim()) {
      throw new HttpException('id requerido', HttpStatus.BAD_REQUEST);
    }
    if (!from || !to) {
      throw new HttpException('from y to son requeridos (YYYY-MM-DD)', HttpStatus.BAD_REQUEST);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new HttpException('from/to inválidos (YYYY-MM-DD)', HttpStatus.BAD_REQUEST);
    }
    const resolvedScope = scope ?? 'operativo';
    if (!isEntryScope(resolvedScope)) {
      throw new HttpException(
        'scope inválido: use operativo, historico o ambos',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const row = await this.tarjetas.spendByRange(
        id.trim(),
        from,
        to,
        resolvedScope,
      );
      if (!row) throw new NotFoundException('Tarjeta no encontrada');
      return row;
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/resumenes/:statementId')
  async getStatement(
    @Param('id') id: string,
    @Param('statementId') statementId: string,
  ) {
    if (!id?.trim() || !statementId?.trim()) {
      throw new HttpException('id y statementId requeridos', HttpStatus.BAD_REQUEST);
    }
    try {
      const row = await this.tarjetas.getStatementById(id.trim(), statementId.trim());
      if (!row) throw new NotFoundException('Resumen no encontrado');
      return row;
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Patch(':id/resumenes/:statementId')
  async updateStatementWindow(
    @Param('id') id: string,
    @Param('statementId') statementId: string,
    @Body() body: UpdateStatementWindowDto,
  ) {
    if (!id?.trim() || !statementId?.trim()) {
      throw new HttpException('id y statementId requeridos', HttpStatus.BAD_REQUEST);
    }
    const patch: { opened_at?: string; closed_at?: string; due_date?: string } = {};
    if (body.opened_at !== undefined) {
      if (typeof body.opened_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.opened_at)) {
        throw new HttpException('opened_at inválida (YYYY-MM-DD)', HttpStatus.BAD_REQUEST);
      }
      patch.opened_at = body.opened_at;
    }
    if (body.closed_at !== undefined) {
      if (typeof body.closed_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.closed_at)) {
        throw new HttpException('closed_at inválida (YYYY-MM-DD)', HttpStatus.BAD_REQUEST);
      }
      patch.closed_at = body.closed_at;
    }
    if (body.due_date !== undefined) {
      if (typeof body.due_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.due_date)) {
        throw new HttpException('due_date inválida (YYYY-MM-DD)', HttpStatus.BAD_REQUEST);
      }
      patch.due_date = body.due_date;
    }
    if (Object.keys(patch).length === 0) {
      throw new HttpException(
        'Enviá al menos uno de: opened_at, closed_at, due_date',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const row = await this.tarjetas.updateStatementWindow(id.trim(), statementId.trim(), patch);
      if (!row) throw new NotFoundException('Resumen no encontrado');
      return row;
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post(':id/resumenes/generar')
  async generateStatement(
    @Param('id') id: string,
    @Body() body: GenerateStatementDto,
    @Query('year') yearQ?: string,
    @Query('month') monthQ?: string,
  ) {
    if (!id?.trim()) {
      throw new HttpException('id requerido', HttpStatus.BAD_REQUEST);
    }
    const now = new Date();
    const year =
      typeof body?.year === 'number' ? body.year
      : yearQ ? Number(yearQ)
      : now.getUTCFullYear();
    const month =
      typeof body?.month === 'number' ? body.month
      : monthQ ? Number(monthQ)
      : now.getUTCMonth() + 1;

    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new HttpException('year inválido', HttpStatus.BAD_REQUEST);
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new HttpException('month inválido', HttpStatus.BAD_REQUEST);
    }

    const hasWindowPart =
      body?.opened_at !== undefined ||
      body?.closed_at !== undefined ||
      body?.due_date !== undefined;
    if (hasWindowPart) {
      if (typeof body?.opened_at !== 'string' || typeof body?.closed_at !== 'string') {
        throw new HttpException(
          'Para ventana personalizada, opened_at y closed_at son requeridos',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.opened_at) || !/^\d{4}-\d{2}-\d{2}$/.test(body.closed_at)) {
        throw new HttpException('opened_at/closed_at inválidos (YYYY-MM-DD)', HttpStatus.BAD_REQUEST);
      }
      if (
        body.due_date !== undefined &&
        (typeof body.due_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.due_date))
      ) {
        throw new HttpException('due_date inválida (YYYY-MM-DD)', HttpStatus.BAD_REQUEST);
      }
    }

    const windowOverride =
      hasWindowPart ?
        {
          opened_at: body!.opened_at!,
          closed_at: body!.closed_at!,
          due_date: body!.due_date,
        }
      : undefined;

    try {
      const row = await this.tarjetas.generateMonthlyStatement(
        id.trim(),
        year,
        month,
        windowOverride,
      );
      if (!row) throw new NotFoundException('Tarjeta no encontrada');
      return row;
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post(':id/deuda-inicial')
  async setInitialDebt(
    @Param('id') id: string,
    @Body() body: SetInitialDebtDto,
  ) {
    if (!id?.trim()) {
      throw new HttpException('id requerido', HttpStatus.BAD_REQUEST);
    }
    const year = Number(body?.year);
    const month = Number(body?.month);
    const outstandingAmount = parseMoneyAmountInput(body?.outstanding_amount);
    const dueDate = body?.due_date;

    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new HttpException('year inválido', HttpStatus.BAD_REQUEST);
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new HttpException('month inválido', HttpStatus.BAD_REQUEST);
    }
    if (!Number.isFinite(outstandingAmount) || outstandingAmount < 0) {
      throw new HttpException(
        'outstanding_amount inválido: usá número JSON (892754.96) o string es-AR (892754,96 / 892.754,96)',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (dueDate !== undefined && (typeof dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))) {
      throw new HttpException('due_date inválida (YYYY-MM-DD)', HttpStatus.BAD_REQUEST);
    }

    try {
      const row = await this.tarjetas.setInitialDebt(id.trim(), {
        year,
        month,
        outstanding_amount: outstandingAmount,
        due_date: dueDate,
      });
      if (!row) throw new NotFoundException('Tarjeta no encontrada');
      return row;
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post()
  async create(@Body() body: CreateTarjetaDto) {
    const bank = body?.bank;
    const type_card = body?.type_card;
    const payment_card = body?.payment_card;
    const closing_day = body?.closing_day;
    const due_day = body?.due_day;
    const credit_limit = body?.credit_limit;
    if (typeof bank !== 'string' || !bank.trim()) {
      throw new HttpException('Campo "bank" requerido', HttpStatus.BAD_REQUEST);
    }
    if (typeof payment_card !== 'string' || !payment_card.trim()) {
      throw new HttpException(
        'Campo "payment_card" requerido',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (typeof type_card !== 'string' || !isTypeCard(type_card)) {
      throw new HttpException(
        'Campo "type_card" debe ser credito, debito o prepaga',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      typeof closing_day !== 'number' ||
      !Number.isInteger(closing_day) ||
      closing_day < 1 ||
      closing_day > 31
    ) {
      throw new HttpException(
        'Campo "closing_day" requerido y debe ser un entero entre 1 y 31',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      due_day !== undefined &&
      due_day !== null &&
      (typeof due_day !== 'number' || !Number.isInteger(due_day) || due_day < 1 || due_day > 31)
    ) {
      throw new HttpException(
        'Campo "due_day" debe ser null o un entero entre 1 y 31',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      credit_limit !== undefined &&
      credit_limit !== null &&
      (typeof credit_limit !== 'number' || !Number.isFinite(credit_limit) || credit_limit <= 0)
    ) {
      throw new HttpException(
        'Campo "credit_limit" debe ser null o un número > 0',
        HttpStatus.BAD_REQUEST,
      );
    }
    try {
      return await this.tarjetas.create({
        bank,
        type_card,
        payment_card,
        closing_day,
        due_day,
        credit_limit,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: UpdateTarjetaDto) {
    if (!id?.trim()) {
      throw new HttpException('id requerido', HttpStatus.BAD_REQUEST);
    }
    const patch: {
      bank?: string;
      type_card?: 'credito' | 'debito' | 'prepaga';
      payment_card?: string;
      closing_day?: number;
      due_day?: number | null;
      apply_due_day_to_current?: boolean;
      credit_limit?: number | null;
    } = {};
    if (body.bank !== undefined) {
      if (typeof body.bank !== 'string' || !body.bank.trim()) {
        throw new HttpException('"bank" inválido', HttpStatus.BAD_REQUEST);
      }
      patch.bank = body.bank;
    }
    if (body.payment_card !== undefined) {
      if (typeof body.payment_card !== 'string' || !body.payment_card.trim()) {
        throw new HttpException('"payment_card" inválido', HttpStatus.BAD_REQUEST);
      }
      patch.payment_card = body.payment_card;
    }
    if (body.type_card !== undefined) {
      if (typeof body.type_card !== 'string' || !isTypeCard(body.type_card)) {
        throw new HttpException(
          '"type_card" debe ser credito, debito o prepaga',
          HttpStatus.BAD_REQUEST,
        );
      }
      patch.type_card = body.type_card;
    }
    if (body.credit_limit !== undefined) {
      const cl = body.credit_limit;
      if (
        cl !== null &&
        (typeof cl !== 'number' || !Number.isFinite(cl) || cl <= 0)
      ) {
        throw new HttpException(
          '"credit_limit" debe ser null o un número > 0',
          HttpStatus.BAD_REQUEST,
        );
      }
      patch.credit_limit = cl;
    }
    if (body.closing_day !== undefined) {
      const cd = body.closing_day;
      if (
        typeof cd !== 'number' ||
        !Number.isInteger(cd) ||
        cd < 1 ||
        cd > 31
      ) {
        throw new HttpException(
          '"closing_day" debe ser un entero entre 1 y 31',
          HttpStatus.BAD_REQUEST,
        );
      }
      patch.closing_day = cd;
    }
    if (body.due_day !== undefined) {
      const dd = body.due_day;
      if (
        dd !== null &&
        (typeof dd !== 'number' || !Number.isInteger(dd) || dd < 1 || dd > 31)
      ) {
        throw new HttpException(
          '"due_day" debe ser null o un entero entre 1 y 31',
          HttpStatus.BAD_REQUEST,
        );
      }
      patch.due_day = dd;
    }
    if (body.apply_due_day_to_current !== undefined) {
      if (typeof body.apply_due_day_to_current !== 'boolean') {
        throw new HttpException(
          '"apply_due_day_to_current" debe ser boolean',
          HttpStatus.BAD_REQUEST,
        );
      }
      patch.apply_due_day_to_current = body.apply_due_day_to_current;
    }
    if (Object.keys(patch).length === 0) {
      throw new HttpException(
        'Enviá al menos uno de: bank, type_card, payment_card, closing_day, due_day, apply_due_day_to_current, credit_limit',
        HttpStatus.BAD_REQUEST,
      );
    }
    try {
      const row = await this.tarjetas.update(id.trim(), patch);
      if (!row) throw new NotFoundException('Tarjeta no encontrada');
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
      await this.tarjetas.deleteById(id.trim());
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
