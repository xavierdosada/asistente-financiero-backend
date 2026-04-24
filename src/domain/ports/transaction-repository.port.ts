import { IngresoEgreso } from '../entities/ingreso-egreso.entity';

export interface TransactionRepositoryPort {
  save(row: IngresoEgreso): Promise<{ id: string }>;
}

export const TRANSACTION_REPOSITORY = Symbol('TRANSACTION_REPOSITORY');
