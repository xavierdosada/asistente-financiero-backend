-- Si tarjetas tiene bank, payment_card, type_card pero NO tiene name (error schema cache).
-- Ejecutar en Supabase SQL Editor; luego Settings → API → Reload schema.

alter table public.tarjetas add column if not exists name text;

-- Rellenar filas existentes (mismo patrón que el backend: "{payment_card} {bank} ({type_card})")
update public.tarjetas
set name = trim(payment_card) || ' ' || trim(bank) || ' (' || lower(trim(type_card)) || ')'
where name is null or trim(name) = '';

alter table public.tarjetas alter column name set not null;

notify pgrst, 'reload schema';
