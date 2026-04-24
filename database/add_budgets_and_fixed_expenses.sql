-- Presupuestos mensuales por categoría + gastos fijos recurrentes.

create table if not exists public.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  currency text not null default 'ARS',
  amount numeric(18, 4) not null check (amount > 0),
  active_from date not null,
  active_to date,
  created_at timestamptz not null default now(),
  check (active_to is null or active_to >= active_from)
);

create unique index if not exists budgets_one_active_per_category
  on public.budgets(user_id, category_id)
  where active_to is null;

create table if not exists public.fixed_expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  aliases text[] not null default '{}',
  amount numeric(18, 4) not null check (amount > 0),
  currency text not null default 'ARS',
  category_id uuid not null references public.categories(id) on delete restrict,
  payment_method text not null check (payment_method in ('efectivo', 'tarjeta')),
  card_id uuid references public.cards(id) on delete set null,
  due_day smallint not null check (due_day between 1 and 31),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (payment_method = 'tarjeta' and card_id is not null)
    or (payment_method = 'efectivo' and card_id is null)
  )
);

create index if not exists fixed_expenses_user_active_idx
  on public.fixed_expenses(user_id, is_active);

create table if not exists public.fixed_expense_instances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  fixed_expense_id uuid not null references public.fixed_expenses(id) on delete cascade,
  period_month date not null,
  due_date date not null,
  expected_amount numeric(18, 4) not null check (expected_amount > 0),
  status text not null check (status in ('pendiente', 'pagado', 'omitido')) default 'pendiente',
  movement_id uuid references public.movements(id) on delete set null,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (fixed_expense_id, period_month)
);

create index if not exists fixed_expense_instances_user_month_idx
  on public.fixed_expense_instances(user_id, period_month, status);

create or replace function public.generate_fixed_expense_instances_for_month(
  p_user_id uuid,
  p_month date
)
returns integer
language plpgsql
as $$
declare
  v_month_start date := date_trunc('month', p_month)::date;
  v_inserted integer := 0;
begin
  insert into public.fixed_expense_instances (
    user_id,
    fixed_expense_id,
    period_month,
    due_date,
    expected_amount,
    status
  )
  select
    fe.user_id,
    fe.id,
    v_month_start,
    (
      v_month_start
      + (
          least(
            fe.due_day,
            extract(day from (date_trunc('month', v_month_start) + interval '1 month - 1 day'))::int
          ) - 1
        ) * interval '1 day'
    )::date,
    fe.amount,
    'pendiente'
  from public.fixed_expenses fe
  where fe.user_id = p_user_id
    and fe.is_active = true
  on conflict (fixed_expense_id, period_month) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;
