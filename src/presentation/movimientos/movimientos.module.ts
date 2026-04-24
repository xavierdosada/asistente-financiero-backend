import { Module } from '@nestjs/common';
import { SupabaseMovementQueryRepository } from '../../infrastructure/supabase/supabase-movement-query.repository';
import { MovimientosController } from './movimientos.controller';

@Module({
  controllers: [MovimientosController],
  providers: [SupabaseMovementQueryRepository],
})
export class MovimientosModule {}
