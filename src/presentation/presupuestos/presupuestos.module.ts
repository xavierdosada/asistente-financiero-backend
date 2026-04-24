import { Module } from '@nestjs/common';
import { BUDGET_REPOSITORY } from '../../domain/ports/budget-repository.port';
import { SupabaseBudgetRepository } from '../../infrastructure/supabase/supabase-budget.repository';
import { PresupuestosController } from './presupuestos.controller';

@Module({
  controllers: [PresupuestosController],
  providers: [
    SupabaseBudgetRepository,
    {
      provide: BUDGET_REPOSITORY,
      useExisting: SupabaseBudgetRepository,
    },
  ],
  exports: [BUDGET_REPOSITORY],
})
export class PresupuestosModule {}
