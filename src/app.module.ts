import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AsesorModule } from './presentation/asesor/asesor.module';
import { ChatModule } from './presentation/chat/chat.module';
import { CajaModule } from './presentation/caja/caja.module';
import { GastosFijosModule } from './presentation/gastos-fijos/gastos-fijos.module';
import { MovimientosModule } from './presentation/movimientos/movimientos.module';
import { PrestamosModule } from './presentation/prestamos/prestamos.module';
import { PresupuestosModule } from './presentation/presupuestos/presupuestos.module';
import { SupabaseAuthGuard } from './auth/supabase-auth.guard';

@Module({
  imports: [
    ChatModule,
    CajaModule,
    PrestamosModule,
    PresupuestosModule,
    GastosFijosModule,
    AsesorModule,
    MovimientosModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: SupabaseAuthGuard,
    },
  ],
})
export class AppModule {}
