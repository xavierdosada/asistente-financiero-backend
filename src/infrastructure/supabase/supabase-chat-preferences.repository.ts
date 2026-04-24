import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  ChatPreferences,
  ChatPreferencesPatch,
  ChatPreferencesRepositoryPort,
} from '../../domain/ports/chat-preferences.repository.port';
import { EntryMode, isEntryMode } from '../../domain/ports/entry-mode.port';
import type { AuthenticatedRequest } from '../../auth/auth.types';
import { getAuthenticatedUserId } from '../../auth/request-user.util';

@Injectable({ scope: Scope.REQUEST })
export class SupabaseChatPreferencesRepository
  implements ChatPreferencesRepositoryPort
{
  private readonly client: SupabaseClient;
  private readonly userId: string;

  constructor(@Inject(REQUEST) request: AuthenticatedRequest) {
    const url = process.env.SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url || !key) {
      throw new Error(
        'Definí SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el entorno del servidor.',
      );
    }
    this.userId = getAuthenticatedUserId(request);
    this.client = createClient(url, key);
  }

  async get(): Promise<ChatPreferences> {
    const { data, error } = await this.client
      .from('profiles')
      .select('auto_create_category_default, default_entry_mode, default_usd_ars_rate')
      .eq('user_id', this.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);

    if (!data) {
      return this.upsertResolved({
        auto_create_category_default: false,
        default_entry_mode: 'operativo',
        default_usd_ars_rate: null,
      });
    }

    const mode = normalizeEntryMode(data.default_entry_mode);
    return {
      auto_create_category_default: Boolean(data.auto_create_category_default),
      default_entry_mode: mode,
      default_usd_ars_rate: normalizeUsdArsRate(data.default_usd_ars_rate),
    };
  }

  async update(patch: ChatPreferencesPatch): Promise<ChatPreferences> {
    const current = await this.get();
    const auto_create_category_default =
      patch.auto_create_category_default ?? current.auto_create_category_default;
    const default_entry_mode = patch.default_entry_mode ?? current.default_entry_mode;
    const default_usd_ars_rate =
      patch.default_usd_ars_rate !== undefined ?
        patch.default_usd_ars_rate
      : current.default_usd_ars_rate;

    return this.upsertResolved({
      auto_create_category_default,
      default_entry_mode,
      default_usd_ars_rate,
    });
  }

  private async upsertResolved(resolved: ChatPreferences): Promise<ChatPreferences> {
    const { data, error } = await this.client
      .from('profiles')
      .upsert(
        {
          user_id: this.userId,
          auto_create_category_default: resolved.auto_create_category_default,
          default_entry_mode: resolved.default_entry_mode,
          default_usd_ars_rate: resolved.default_usd_ars_rate,
        },
        { onConflict: 'user_id' },
      )
      .select('auto_create_category_default, default_entry_mode, default_usd_ars_rate')
      .single();

    if (error) throw new Error(error.message);
    if (!data) throw new Error('No se pudo guardar preferencia de chat');
    return {
      auto_create_category_default: Boolean(data.auto_create_category_default),
      default_entry_mode: normalizeEntryMode(data.default_entry_mode),
      default_usd_ars_rate: normalizeUsdArsRate(data.default_usd_ars_rate),
    };
  }
}

function normalizeEntryMode(value: unknown): EntryMode {
  if (typeof value === 'string' && isEntryMode(value)) return value;
  return 'operativo';
}

function normalizeUsdArsRate(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 10000) / 10000;
}
