import { Module } from '@nestjs/common';
import { ProcessAdvisorMessageUseCase } from '../../application/process-advisor-message.use-case';
import { AI_FINANCIAL_ADVISOR } from '../../domain/ports/ai-financial-advisor.port';
import { GeminiFinancialAdvisorAdapter } from '../../infrastructure/ai/gemini-financial-advisor.adapter';
import { CajaModule } from '../caja/caja.module';
import { PrestamosModule } from '../prestamos/prestamos.module';
import { TarjetasModule } from '../tarjetas/tarjetas.module';
import { AsesorController } from './asesor.controller';

@Module({
  imports: [TarjetasModule, PrestamosModule, CajaModule],
  controllers: [AsesorController],
  providers: [
    ProcessAdvisorMessageUseCase,
    {
      provide: AI_FINANCIAL_ADVISOR,
      useClass: GeminiFinancialAdvisorAdapter,
    },
  ],
})
export class AsesorModule {}
