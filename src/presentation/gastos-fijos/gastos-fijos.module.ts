import { Module } from '@nestjs/common';
import { ACCOUNT_REPOSITORY } from '../../domain/ports/account-repository.port';
import { FIXED_EXPENSE_REPOSITORY } from '../../domain/ports/fixed-expense-repository.port';
import { TRANSACTION_REPOSITORY } from '../../domain/ports/transaction-repository.port';
import { SupabaseAccountRepository } from '../../infrastructure/supabase/supabase-account.repository';
import { SupabaseFixedExpenseRepository } from '../../infrastructure/supabase/supabase-fixed-expense.repository';
import { SupabaseTransactionRepository } from '../../infrastructure/supabase/supabase-transaction.repository';
import { GastosFijosController } from './gastos-fijos.controller';

@Module({
  controllers: [GastosFijosController],
  providers: [
    SupabaseFixedExpenseRepository,
    {
      provide: FIXED_EXPENSE_REPOSITORY,
      useExisting: SupabaseFixedExpenseRepository,
    },
    SupabaseTransactionRepository,
    {
      provide: TRANSACTION_REPOSITORY,
      useExisting: SupabaseTransactionRepository,
    },
    SupabaseAccountRepository,
    {
      provide: ACCOUNT_REPOSITORY,
      useExisting: SupabaseAccountRepository,
    },
  ],
  exports: [FIXED_EXPENSE_REPOSITORY],
})
export class GastosFijosModule {}
