/**
 * Interpreta montos desde JSON o texto con convención es-AR (miles con `.`, decimales con `,`).
 * En JSON numérico estándar, el punto es siempre decimal (ej. 892754.96).
 */
export function parseMoneyAmountInput(raw: unknown): number {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : Number.NaN;
  }
  if (typeof raw !== 'string') return Number.NaN;
  const s = raw.trim().replace(/\s/g, '');
  if (!s) return Number.NaN;

  if (s.includes(',')) {
    const normalized = s.replace(/\./g, '').replace(',', '.');
    const n = Number(normalized);
    return Number.isFinite(n) ? n : Number.NaN;
  }

  if (/^\d+$/.test(s)) return Number(s);

  const dotCount = (s.match(/\./g) ?? []).length;
  if (dotCount === 1) {
    const after = s.slice(s.indexOf('.') + 1);
    if (after.length === 3 && /^\d{3}$/.test(after) && /^\d+\.\d{3}$/.test(s)) {
      return Number(s.replace(/\./g, ''));
    }
    return Number(s);
  }

  if (/^(\d{1,3})(\.\d{3})+$/.test(s)) {
    return Number(s.replace(/\./g, ''));
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : Number.NaN;
}
