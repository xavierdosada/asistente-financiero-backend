import { Module } from '@nestjs/common';
import { TARJETA_REPOSITORY } from '../../domain/ports/tarjeta-repository.port';
import { SupabaseTarjetaRepository } from '../../infrastructure/supabase/supabase-tarjeta.repository';
import { TarjetasController } from './tarjetas.controller';

@Module({
  controllers: [TarjetasController],
  providers: [
    SupabaseTarjetaRepository,
    {
      provide: TARJETA_REPOSITORY,
      useExisting: SupabaseTarjetaRepository,
    },
  ],
  exports: [TARJETA_REPOSITORY],
})
export class TarjetasModule {}
