-- Ejecutar en Supabase SQL Editor o como migración.
-- Categorías y tarjetas: catálogos editables (alta/baja desde la API).

create table if not exists public.categorias (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  created_at timestamptz not null default now()
);

comment on table public.categorias is 'Categorías de gasto/ingreso definidas por el usuario';
comment on column public.categorias.nombre is 'Ej. Comida, Ropa, Gastos fijos';

create table if not exists public.tarjetas (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  bank text not null,
  type_card text not null check (type_card in ('credito', 'debito', 'prepaga')),
  payment_card text not null,
  created_at timestamptz not null default now()
);

comment on table public.tarjetas is 'Tarjetas registradas por el usuario para asociar pagos';
comment on column public.tarjetas.name is 'Derivado en API: "{payment_card} {bank} ({type_card})" para matching del chat';
comment on column public.tarjetas.bank is 'Ej. NARANJA, Galicia';
comment on column public.tarjetas.type_card is 'credito | debito | prepaga';
comment on column public.tarjetas.payment_card is 'Ej. VISA, MASTERCARD';

create table if not exists public.ingresos_egresos (
  id uuid primary key default gen_random_uuid(),
  currency text not null,
  amount numeric(18, 4) not null check (amount > 0),
  type text not null check (type in ('ingreso', 'gasto')),
  detail text not null,
  categoria_id uuid not null references public.categorias (id) on delete restrict,
  medio_pago text not null check (medio_pago in ('efectivo', 'tarjeta')),
  tarjeta_id uuid references public.tarjetas (id) on delete set null,
  movement_date date not null,
  raw_message text not null,
  created_at timestamptz not null default now(),
  constraint ingresos_egresos_medio_tarjeta check (
    (medio_pago = 'efectivo' and tarjeta_id is null)
    or (medio_pago = 'tarjeta')
  )
);

comment on table public.ingresos_egresos is 'Ingresos y egresos inferidos desde el chat';
comment on column public.ingresos_egresos.currency is 'ISO 4217, ej. ARS, USD';
comment on column public.ingresos_egresos.type is 'ingreso | gasto';
comment on column public.ingresos_egresos.detail is 'Descripción breve del movimiento';
comment on column public.ingresos_egresos.categoria_id is 'FK a categorias';
comment on column public.ingresos_egresos.medio_pago is 'efectivo | tarjeta';
comment on column public.ingresos_egresos.tarjeta_id is 'Solo si medio_pago = tarjeta; FK a tarjetas';
comment on column public.ingresos_egresos.movement_date is 'Fecha en que ocurrió el ingreso o gasto (día calendario)';
comment on column public.ingresos_egresos.raw_message is 'Texto original del usuario';

alter table public.categorias enable row level security;
alter table public.tarjetas enable row level security;
alter table public.ingresos_egresos enable row level security;

-- ---------- Migraciones (tablas ya existentes con categoria text) ----------
--
-- create table if not exists public.categorias (...);
-- insert into public.categorias (nombre) values ('Otros') returning id;  -- guardar id
--
-- alter table public.ingresos_egresos add column if not exists categoria_id uuid;
-- update public.ingresos_egresos set categoria_id = '<uuid-de-Otros>' where categoria_id is null;
-- alter table public.ingresos_egresos drop column if exists categoria;
-- alter table public.ingresos_egresos alter column categoria_id set not null;
-- alter table public.ingresos_egresos
--   add constraint ingresos_egresos_categoria_id_fkey
--   foreign key (categoria_id) references public.categorias(id) on delete restrict;
--
-- Migración de columnas legacy → ver database/migrate_tarjetas_english.sql
