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
  LOAN_REPOSITORY,
  LoanRepositoryPort,
  UpdateLoanInput,
  isLoanStatus,
} from '../../domain/ports/loan-repository.port';

class CreatePrestamoDto {
  name!: string;
  lender?: string | null;
  currency?: string;
  principal_amount!: number;
  installment_amount!: number;
  outstanding_amount?: number;
  total_installments!: number;
  installments_paid?: number;
  first_due_date!: string;
  annual_rate?: number | null;
  notes?: string | null;
}

class UpdatePrestamoDto {
  name?: string;
  lender?: string | null;
  currency?: string;
  principal_amount?: number;
  installment_amount?: number;
  outstanding_amount?: number;
  total_installments?: number;
  installments_paid?: number;
  first_due_date?: string;
  annual_rate?: number | null;
  notes?: string | null;
  status?: string;
}

const LOAN_CURRENCIES = ['ARS', 'USD'] as const;
function isLoanCurrency(v: string): boolean {
  return LOAN_CURRENCIES.includes(v as (typeof LOAN_CURRENCIES)[number]);
}

@Controller('prestamos')
export class PrestamosController {
  constructor(
    @Inject(LOAN_REPOSITORY)
    private readonly loans: LoanRepositoryPort,
  ) {}

  @Get()
  async list() {
    try {
      return await this.loans.list();
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
      const row = await this.loans.findById(id.trim());
      if (!row) throw new NotFoundException('Préstamo no encontrado');
      return row;
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id/cuotas')
  async cuotas(@Param('id') id: string) {
    if (!id?.trim()) {
      throw new HttpException('id requerido', HttpStatus.BAD_REQUEST);
    }
    try {
      const rows = await this.loans.installmentsByLoanId(id.trim());
      if (!rows) throw new NotFoundException('Préstamo no encontrado');
      return rows;
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post()
  async create(@Body() body: CreatePrestamoDto) {
    if (typeof body?.name !== 'string' || !body.name.trim()) {
      throw new HttpException('Campo "name" requerido', HttpStatus.BAD_REQUEST);
    }
    if (typeof body?.principal_amount !== 'number' || !Number.isFinite(body.principal_amount) || body.principal_amount <= 0) {
      throw new HttpException('Campo "principal_amount" debe ser número > 0', HttpStatus.BAD_REQUEST);
    }
    if (typeof body?.installment_amount !== 'number' || !Number.isFinite(body.installment_amount) || body.installment_amount <= 0) {
      throw new HttpException('Campo "installment_amount" debe ser número > 0', HttpStatus.BAD_REQUEST);
    }
    if (!Number.isInteger(body?.total_installments) || body.total_installments <= 0) {
      throw new HttpException('Campo "total_installments" debe ser entero > 0', HttpStatus.BAD_REQUEST);
    }
    if (body.installments_paid !== undefined && (!Number.isInteger(body.installments_paid) || body.installments_paid < 0)) {
      throw new HttpException('Campo "installments_paid" debe ser entero >= 0', HttpStatus.BAD_REQUEST);
    }
    if (typeof body?.first_due_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.first_due_date)) {
      throw new HttpException('Campo "first_due_date" inválido (YYYY-MM-DD)', HttpStatus.BAD_REQUEST);
    }
    if (body.currency !== undefined) {
      const c = String(body.currency).trim().toUpperCase();
      if (!isLoanCurrency(c)) {
        throw new HttpException('Campo "currency" debe ser ARS o USD', HttpStatus.BAD_REQUEST);
      }
      body.currency = c;
    }
    if (
      body.installment_amount !== undefined &&
      (typeof body.installment_amount !== 'number' || !Number.isFinite(body.installment_amount) || body.installment_amount <= 0)
    ) {
      throw new HttpException('Campo "installment_amount" debe ser número > 0', HttpStatus.BAD_REQUEST);
    }
    try {
      return await this.loans.create(body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: UpdatePrestamoDto) {
    if (!id?.trim()) {
      throw new HttpException('id requerido', HttpStatus.BAD_REQUEST);
    }
    if (body.status !== undefined && (typeof body.status !== 'string' || !isLoanStatus(body.status))) {
      throw new HttpException('Campo "status" inválido', HttpStatus.BAD_REQUEST);
    }
    if (body.currency !== undefined) {
      const c = String(body.currency).trim().toUpperCase();
      if (!isLoanCurrency(c)) {
        throw new HttpException('Campo "currency" debe ser ARS o USD', HttpStatus.BAD_REQUEST);
      }
      body.currency = c;
    }

    const patch: UpdateLoanInput = {
      ...body,
      status:
        body.status === undefined ? undefined : (body.status.trim() as UpdateLoanInput['status']),
    };

    try {
      const row = await this.loans.update(id.trim(), patch);
      if (!row) throw new NotFoundException('Préstamo no encontrado');
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
      await this.loans.deleteById(id.trim());
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
