import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { IngresoEgreso } from '../../domain/entities/ingreso-egreso.entity';
import { ACCOUNT_REPOSITORY, AccountRepositoryPort } from '../../domain/ports/account-repository.port';
import {
  FIXED_EXPENSE_REPOSITORY,
  FixedExpenseRepositoryPort,
} from '../../domain/ports/fixed-expense-repository.port';
import {
  TRANSACTION_REPOSITORY,
  TransactionRepositoryPort,
} from '../../domain/ports/transaction-repository.port';

class CreateFixedExpenseDto {
  name!: string;
  aliases?: string[];
  amount!: number;
  currency?: string;
  category_id!: string;
  payment_method!: 'efectivo' | 'tarjeta';
  card_id?: string | null;
  due_day!: number;
}

class UpdateFixedExpenseDto {
  name?: string;
  aliases?: string[];
  amount?: number;
  currency?: string;
  category_id?: string;
  payment_method?: 'efectivo' | 'tarjeta';
  card_id?: string | null;
  due_day?: number;
  is_active?: boolean;
}

@Controller('fixed-expenses')
export class GastosFijosController {
  constructor(
    @Inject(FIXED_EXPENSE_REPOSITORY)
    private readonly fixed: FixedExpenseRepositoryPort,
    @Inject(TRANSACTION_REPOSITORY)
    private readonly transactions: TransactionRepositoryPort,
    @Inject(ACCOUNT_REPOSITORY)
    private readonly accounts: AccountRepositoryPort,
  ) {}

  @Get()
  async list() {
    try {
      return await this.fixed.list();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post()
  async create(@Body() body: CreateFixedExpenseDto) {
    if (typeof body?.name !== 'string' || !body.name.trim()) {
      throw new HttpException('Campo "name" requerido', HttpStatus.BAD_REQUEST);
    }
    if (typeof body?.amount !== 'number' || !Number.isFinite(body.amount) || body.amount <= 0) {
      throw new HttpException('Campo "amount" inválido', HttpStatus.BAD_REQUEST);
    }
    if (typeof body?.category_id !== 'string' || !body.category_id.trim()) {
      throw new HttpException('Campo "category_id" requerido', HttpStatus.BAD_REQUEST);
    }
    if (body.payment_method !== 'efectivo' && body.payment_method !== 'tarjeta') {
      throw new HttpException('Campo "payment_method" inválido', HttpStatus.BAD_REQUEST);
    }
    if (!Number.isInteger(body?.due_day) || body.due_day < 1 || body.due_day > 31) {
      throw new HttpException('Campo "due_day" inválido', HttpStatus.BAD_REQUEST);
    }
    try {
      return await this.fixed.create({
        name: body.name,
        aliases: Array.isArray(body.aliases) ? body.aliases : [],
        amount: body.amount,
        currency: body.currency?.trim().toUpperCase() || 'ARS',
        category_id: body.category_id.trim(),
        payment_method: body.payment_method,
        card_id: body.payment_method === 'tarjeta' ? (body.card_id ?? null) : null,
        due_day: body.due_day,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: UpdateFixedExpenseDto) {
    if (!id?.trim()) {
      throw new HttpException('id requerido', HttpStatus.BAD_REQUEST);
    }
    try {
      const updated = await this.fixed.update(id.trim(), body);
      if (!updated) throw new HttpException('Gasto fijo no encontrado', HttpStatus.NOT_FOUND);
      return updated;
    } catch (e) {
      if (e instanceof HttpException) throw e;
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('instances')
  async instances(@Query('month') month?: string) {
    const targetMonth = month ?? new Date().toISOString().slice(0, 10);
    try {
      await this.fixed.generateInstancesForMonth(targetMonth);
      return await this.fixed.listInstances(targetMonth);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('instances/:id/pay')
  async payInstance(@Param('id') id: string) {
    if (!id?.trim()) {
      throw new HttpException('id requerido', HttpStatus.BAD_REQUEST);
    }
    try {
      const instance = await this.fixed.findInstanceById(id.trim());
      if (!instance) throw new HttpException('Instancia no encontrada', HttpStatus.NOT_FOUND);
      if (instance.status !== 'pendiente') {
        throw new HttpException('La instancia no está pendiente', HttpStatus.BAD_REQUEST);
      }
      const fixed = await this.fixed.findById(instance.fixed_expense_id);
      if (!fixed) throw new HttpException('Gasto fijo no encontrado', HttpStatus.NOT_FOUND);

      const sourceAccountId =
        fixed.payment_method === 'efectivo'
          ? (await this.accounts.getOrCreateCashAccount(fixed.currency)).id
          : null;
      const movement = new IngresoEgreso(
        fixed.currency,
        instance.expected_amount,
        'gasto',
        fixed.name,
        fixed.category_id,
        fixed.payment_method,
        fixed.card_id,
        null,
        null,
        null,
        null,
        new Date().toISOString().slice(0, 10),
        sourceAccountId,
        'operativo',
        `pago automático gasto fijo ${fixed.name}`,
        null,
      );
      const saved = await this.transactions.save(movement);
      const paid = await this.fixed.markInstancePaid(instance.id, saved.id);
      if (!paid) {
        throw new HttpException('No se pudo marcar la instancia como pagada', HttpStatus.CONFLICT);
      }
      return { ok: true, movement_id: saved.id };
    } catch (e) {
      if (e instanceof HttpException) throw e;
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
