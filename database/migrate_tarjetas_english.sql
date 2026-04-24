-- Migra public.tarjetas a columnas en inglés: name, bank, type_card, payment_card.
-- Ejecutá en el SQL Editor de Supabase; después: Settings → API → Reload schema (o NOTIFY abajo).

begin;

-- nombre → name (si aún no existe name)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tarjetas' and column_name = 'nombre'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tarjetas' and column_name = 'name'
  ) then
    alter table public.tarjetas rename column nombre to name;
  end if;
end $$;

-- banco → bank
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tarjetas' and column_name = 'banco'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tarjetas' and column_name = 'bank'
  ) then
    alter table public.tarjetas rename column banco to bank;
  end if;
end $$;

-- tipo_tarjeta → type_card
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tarjetas' and column_name = 'tipo_tarjeta'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tarjetas' and column_name = 'type_card'
  ) then
    alter table public.tarjetas rename column tipo_tarjeta to type_card;
  end if;
end $$;

-- card_type → type_card (variante inglés previa)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tarjetas' and column_name = 'card_type'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tarjetas' and column_name = 'type_card'
  ) then
    alter table public.tarjetas rename column card_type to type_card;
  end if;
end $$;

alter table public.tarjetas add column if not exists payment_card text;

-- Valor por defecto para filas viejas sin red
update public.tarjetas
set payment_card = 'GENERICA'
where payment_card is null or trim(payment_card) = '';

alter table public.tarjetas alter column payment_card set not null;

-- Recalcular name al formato del backend: "{payment_card} {bank} ({type_card})"
update public.tarjetas
set name = trim(payment_card) || ' ' || trim(bank) || ' (' || type_card || ')'
where bank is not null
  and type_card is not null
  and payment_card is not null;

-- Asegurar check en type_card (eliminar restricciones viejas por nombre si existieran)
alter table public.tarjetas drop constraint if exists tarjetas_tipo_tarjeta_chk;
alter table public.tarjetas drop constraint if exists tarjetas_card_type_chk;
alter table public.tarjetas drop constraint if exists tarjetas_type_card_chk;
alter table public.tarjetas
  add constraint tarjetas_type_card_chk
  check (type_card in ('credito', 'debito', 'prepaga'));

notify pgrst, 'reload schema';

commit;
