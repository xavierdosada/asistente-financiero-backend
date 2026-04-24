import { Injectable } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  CategoriaRepositoryPort,
  CategoriaRow,
} from '../../domain/ports/categoria-repository.port';

@Injectable()
export class SupabaseCategoriaRepository implements CategoriaRepositoryPort {
  private readonly client: SupabaseClient;
  private readonly userId: string;

  constructor() {
    const url = process.env.SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url || !key) {
      throw new Error(
        'Definí SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el entorno del servidor.',
      );
    }
    this.userId = process.env.APP_USER_ID?.trim() ?? '';
    if (!this.userId) {
      throw new Error('Definí APP_USER_ID (uuid de auth.users) en el entorno del servidor.');
    }
    this.client = createClient(url, key);
  }

  async list(): Promise<CategoriaRow[]> {
    const { data, error } = await this.client
      .from('categories')
      .select('id, name, icon_key')
      .eq('user_id', this.userId)
      .order('name', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map((row: { id: string; name: string; icon_key?: string | null }) => ({
      id: row.id as string,
      nombre: row.name as string,
      icon_key: row.icon_key == null || row.icon_key === '' ? null : String(row.icon_key),
    }));
  }

  async findById(id: string): Promise<CategoriaRow | null> {
    const { data, error } = await this.client
      .from('categories')
      .select('id, name, icon_key')
      .eq('id', id)
      .eq('user_id', this.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const row = data as { id: string; name: string; icon_key?: string | null };
    return {
      id: row.id,
      nombre: row.name,
      icon_key: row.icon_key == null || row.icon_key === '' ? null : String(row.icon_key),
    };
  }

  async create(nombre: string, iconKey?: string | null): Promise<CategoriaRow> {
    const n = normalizeCategoryName(nombre);
    if (!n) throw new Error('El nombre de la categoría no puede estar vacío');
    const icon = normalizeIconKey(iconKey);
    const { data, error } = await this.client
      .from('categories')
      .insert({ user_id: this.userId, name: n, kind: 'mixta', icon_key: icon })
      .select('id, name, icon_key')
      .single();
    if (error) throw mapCategoriaDbError(error);
    if (!data) throw new Error('Supabase no devolvió fila');
    const row = data as { id: string; name: string; icon_key?: string | null };
    return {
      id: row.id,
      nombre: row.name,
      icon_key: row.icon_key == null || row.icon_key === '' ? null : String(row.icon_key),
    };
  }

  async update(
    id: string,
    patch: { nombre?: string; icon_key?: string | null },
  ): Promise<CategoriaRow | null> {
    const updates: Record<string, unknown> = {};
    if (patch.nombre !== undefined) {
      const n = normalizeCategoryName(patch.nombre);
      if (!n) throw new Error('El nombre de la categoría no puede estar vacío');
      updates.name = n;
    }
    if (patch.icon_key !== undefined) {
      updates.icon_key = normalizeIconKey(patch.icon_key);
    }
    if (Object.keys(updates).length === 0) {
      return this.findById(id);
    }
    const { data, error } = await this.client
      .from('categories')
      .update(updates)
      .eq('id', id)
      .eq('user_id', this.userId)
      .select('id, name, icon_key')
      .maybeSingle();
    if (error) throw mapCategoriaDbError(error);
    if (!data) return null;
    const row = data as { id: string; name: string; icon_key?: string | null };
    return {
      id: row.id,
      nombre: row.name,
      icon_key: row.icon_key == null || row.icon_key === '' ? null : String(row.icon_key),
    };
  }

  async deleteById(id: string): Promise<void> {
    const { error } = await this.client
      .from('categories')
      .delete()
      .eq('id', id)
      .eq('user_id', this.userId);
    if (error) throw new Error(error.message);
  }
}

function normalizeCategoryName(nombre: string): string {
  return nombre.trim().replace(/\s+/g, ' ');
}

function normalizeIconKey(iconKey: string | null | undefined): string | null {
  if (iconKey == null) return null;
  const t = String(iconKey).trim();
  if (!t) return null;
  return t.slice(0, 64);
}

function mapCategoriaDbError(error: {
  code?: string;
  message: string;
}): Error {
  if (error.code === '23505') {
    return new Error('Ya existe una categoría con ese nombre');
  }
  return new Error(error.message);
}
