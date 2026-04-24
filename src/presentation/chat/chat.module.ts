import { Module } from '@nestjs/common';
import { ProcessChatMessageUseCase } from '../../application/process-chat-message.use-case';
import { AI_TRANSACTION_PARSER } from '../../domain/ports/ai-transaction-parser.port';
import { CHAT_PREFERENCES_REPOSITORY } from '../../domain/ports/chat-preferences.repository.port';
import { TRANSACTION_REPOSITORY } from '../../domain/ports/transaction-repository.port';
import { GeminiTransactionParserAdapter } from '../../infrastructure/ai/gemini-transaction-parser.adapter';
import { SupabaseChatPreferencesRepository } from '../../infrastructure/supabase/supabase-chat-preferences.repository';
import { SupabaseTransactionRepository } from '../../infrastructure/supabase/supabase-transaction.repository';
import { CajaModule } from '../caja/caja.module';
import { CategoriasModule } from '../categorias/categorias.module';
import { PrestamosModule } from '../prestamos/prestamos.module';
import { PresupuestosModule } from '../presupuestos/presupuestos.module';
import { TarjetasModule } from '../tarjetas/tarjetas.module';
import { GastosFijosModule } from '../gastos-fijos/gastos-fijos.module';
import { ChatController } from './chat.controller';

@Module({
  imports: [
    CategoriasModule,
    TarjetasModule,
    CajaModule,
    PrestamosModule,
    PresupuestosModule,
    GastosFijosModule,
  ],
  controllers: [ChatController],
  providers: [
    ProcessChatMessageUseCase,
    {
      provide: TRANSACTION_REPOSITORY,
      useClass: SupabaseTransactionRepository,
    },
    {
      provide: AI_TRANSACTION_PARSER,
      useClass: GeminiTransactionParserAdapter,
    },
    SupabaseChatPreferencesRepository,
    {
      provide: CHAT_PREFERENCES_REPOSITORY,
      useExisting: SupabaseChatPreferencesRepository,
    },
  ],
})
export class ChatModule {}
