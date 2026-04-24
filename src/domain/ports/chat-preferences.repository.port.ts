import type { EntryMode } from './entry-mode.port';

export type ChatPreferences = {
  auto_create_category_default: boolean;
  default_entry_mode: EntryMode;
  /** ARS por 1 USD; preferencia para registrar gastos con tarjeta en USD. */
  default_usd_ars_rate: number | null;
};

export type ChatPreferencesPatch = Partial<ChatPreferences>;

export interface ChatPreferencesRepositoryPort {
  get(): Promise<ChatPreferences>;
  update(patch: ChatPreferencesPatch): Promise<ChatPreferences>;
}

export const CHAT_PREFERENCES_REPOSITORY = Symbol('CHAT_PREFERENCES_REPOSITORY');
