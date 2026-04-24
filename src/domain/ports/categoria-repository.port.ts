export type CategoriaRow = { id: string; nombre: string; icon_key: string | null };

export interface CategoriaRepositoryPort {
  list(): Promise<CategoriaRow[]>;
  findById(id: string): Promise<CategoriaRow | null>;
  create(nombre: string, iconKey?: string | null): Promise<CategoriaRow>;
  update(
    id: string,
    patch: { nombre?: string; icon_key?: string | null },
  ): Promise<CategoriaRow | null>;
  deleteById(id: string): Promise<void>;
}

export const CATEGORIA_REPOSITORY = Symbol('CATEGORIA_REPOSITORY');
