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
import { isEntryMode, type EntryMode } from '../../domain/ports/entry-mode.port';

class CreateFixedExpenseDto {
  name!: string;
  aliases?: string[];
  amount!: number;
  currency?: string;
  category_id!: string;
  payment_method!: 'efectivo' | 'tarjeta';
  card_id?: string | null;
  due_day!: number;
  start_month?: string | null;
  accrual_day?: number | null;
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
  start_month?: string | null;
  accrual_day?: number | null;
  is_active?: boolean;
}

class PayFixedExpenseInstanceDto {
  entry_mode?: EntryMode;
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
    const startMonth = normalizeStartMonth(body.start_month, body.payment_method);
    const accrualDay = normalizeAccrualDay(body.accrual_day, body.payment_method);
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
        start_month: startMonth,
        accrual_day: accrualDay,
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
      const startMonthPatch =
        body.start_month === undefined ?
          undefined
        : normalizeStartMonth(body.start_month, body.payment_method ?? 'tarjeta');
      const accrualDayPatch =
        body.accrual_day === undefined ?
          undefined
        : normalizeAccrualDay(body.accrual_day, body.payment_method ?? 'tarjeta');
      const updated = await this.fixed.update(id.trim(), {
        ...body,
        start_month: startMonthPatch,
        accrual_day: accrualDayPatch,
      });
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
      const instances = await this.fixed.listInstances(targetMonth);
      await this.autoCreateCardFixedExpenseMovements(instances);
      const finalInstances = await this.fixed.listInstances(targetMonth);
      return finalInstances;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('instances/:id/pay')
  async payInstance(@Param('id') id: string, @Body() body?: PayFixedExpenseInstanceDto) {
    if (!id?.trim()) {
      throw new HttpException('id requerido', HttpStatus.BAD_REQUEST);
    }
    const entryMode = body?.entry_mode ?? 'operativo';
    if (!isEntryMode(entryMode)) {
      throw new HttpException('Campo "entry_mode" debe ser operativo o historico', HttpStatus.BAD_REQUEST);
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
        fixed.payment_method === 'efectivo' && entryMode === 'operativo'
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
        entryMode,
        `pago automático gasto fijo ${fixed.name}`,
        null,
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

  private async autoCreateCardFixedExpenseMovements(
    instances: Array<{
      id: string;
      fixed_expense_id: string;
      period_month: string;
      due_date: string;
      expected_amount: number;
      status: 'pendiente' | 'pagado' | 'omitido';
      movement_id: string | null;
    }>,
  ): Promise<void> {
    const pendingCardInstances = instances.filter(
      (instance) => instance.status === 'pendiente' && !instance.movement_id,
    );
    if (!pendingCardInstances.length) return;

    const fixedById = new Map<string, Awaited<ReturnType<FixedExpenseRepositoryPort['findById']>>>();
    for (const instance of pendingCardInstances) {
      if (!fixedById.has(instance.fixed_expense_id)) {
        fixedById.set(instance.fixed_expense_id, await this.fixed.findById(instance.fixed_expense_id));
      }
    }

    for (const instance of pendingCardInstances) {
      const fixed = fixedById.get(instance.fixed_expense_id);
      if (!fixed || fixed.payment_method !== 'tarjeta' || !fixed.card_id) continue;
      const movementDate = movementDateForInstance(instance.period_month, fixed.accrual_day ?? fixed.due_day);

      const movement = new IngresoEgreso(
        fixed.currency,
        instance.expected_amount,
        'gasto',
        `${fixed.name} [gasto fijo]`,
        fixed.category_id,
        'tarjeta',
        fixed.card_id,
        null,
        null,
        null,
        null,
        movementDate,
        null,
        'operativo',
        `auto_registro_gasto_fijo:${fixed.id}:${instance.id}`,
        null,
        null,
      );
      const saved = await this.transactions.save(movement);
      const paid = await this.fixed.markInstancePaid(instance.id, saved.id);
      if (!paid) {
        throw new HttpException('No se pudo consolidar el movimiento del gasto fijo', HttpStatus.CONFLICT);
      }
    }
  }
}

function normalizeStartMonth(
  value: string | null | undefined,
  paymentMethod: 'efectivo' | 'tarjeta',
): string | null {
  if (paymentMethod === 'efectivo') return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpException('Campo "start_month" requerido para tarjeta', HttpStatus.BAD_REQUEST);
  }
  const raw = value.trim();
  const monthOnly = /^\d{4}-\d{2}$/.test(raw) ? `${raw}-01` : raw;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(monthOnly)) {
    throw new HttpException('Campo "start_month" inválido', HttpStatus.BAD_REQUEST);
  }
  const d = new Date(`${monthOnly}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new HttpException('Campo "start_month" inválido', HttpStatus.BAD_REQUEST);
  }
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function normalizeAccrualDay(
  value: number | null | undefined,
  paymentMethod: 'efectivo' | 'tarjeta',
): number | null {
  if (paymentMethod === 'efectivo') return null;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 31) {
    throw new HttpException('Campo "accrual_day" inválido', HttpStatus.BAD_REQUEST);
  }
  return Number(value);
}

function movementDateForInstance(periodMonth: string, accrualDay: number): string {
  const base = new Date(`${periodMonth}T12:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return new Date().toISOString().slice(0, 10);
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const safeDay = Math.min(Math.max(accrualDay, 1), lastDay);
  return new Date(Date.UTC(year, month, safeDay)).toISOString().slice(0, 10);
}
