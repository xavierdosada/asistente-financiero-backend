import { Module } from '@nestjs/common';
import { CATEGORIA_REPOSITORY } from '../../domain/ports/categoria-repository.port';
import { SupabaseCategoriaRepository } from '../../infrastructure/supabase/supabase-categoria.repository';
import { CategoriasController } from './categorias.controller';

@Module({
  controllers: [CategoriasController],
  providers: [
    SupabaseCategoriaRepository,
    {
      provide: CATEGORIA_REPOSITORY,
      useExisting: SupabaseCategoriaRepository,
    },
  ],
  exports: [CATEGORIA_REPOSITORY],
})
export class CategoriasModule {}
