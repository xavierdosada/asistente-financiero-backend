import { Module } from '@nestjs/common';
import { LOAN_REPOSITORY } from '../../domain/ports/loan-repository.port';
import { SupabaseLoanRepository } from '../../infrastructure/supabase/supabase-loan.repository';
import { PrestamosController } from './prestamos.controller';

@Module({
  controllers: [PrestamosController],
  providers: [
    SupabaseLoanRepository,
    {
      provide: LOAN_REPOSITORY,
      useExisting: SupabaseLoanRepository,
    },
  ],
  exports: [LOAN_REPOSITORY],
})
export class PrestamosModule {}
