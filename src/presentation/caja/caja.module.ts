import { Module } from '@nestjs/common';
import { ACCOUNT_REPOSITORY } from '../../domain/ports/account-repository.port';
import { SupabaseAccountRepository } from '../../infrastructure/supabase/supabase-account.repository';
import { CajaController } from './caja.controller';

@Module({
  controllers: [CajaController],
  providers: [
    SupabaseAccountRepository,
    {
      provide: ACCOUNT_REPOSITORY,
      useExisting: SupabaseAccountRepository,
    },
  ],
  exports: [ACCOUNT_REPOSITORY],
})
export class CajaModule {}
