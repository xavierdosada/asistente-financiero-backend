export const ENTRY_MODE_VALUES = ['operativo', 'historico'] as const;
export type EntryMode = (typeof ENTRY_MODE_VALUES)[number];

export const ENTRY_SCOPE_VALUES = ['operativo', 'historico', 'ambos'] as const;
export type EntryScope = (typeof ENTRY_SCOPE_VALUES)[number];

export function isEntryMode(value: unknown): value is EntryMode {
  return typeof value === 'string' && (ENTRY_MODE_VALUES as readonly string[]).includes(value);
}

export function isEntryScope(value: unknown): value is EntryScope {
  return typeof value === 'string' && (ENTRY_SCOPE_VALUES as readonly string[]).includes(value);
}
