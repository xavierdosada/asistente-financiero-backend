-- Financial model v1 for Asistente Financiero
-- Create core tables for multi-user finance assistant features.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  base_currency text not null default 'ARS',
  timezone text not null default 'America/Argentina/Buenos_Aires',
  created_at timestamptz not null default now()
);

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('ingreso', 'gasto', 'mixta')),
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  account_type text not null check (account_type in ('efectivo', 'banco', 'virtual')),
  currency text not null default 'ARS',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  bank text not null,
  network text not null,
  card_type text not null check (card_type in ('credito', 'debito', 'prepaga')),
  closing_day smallint check (closing_day between 1 and 31),
  due_day smallint check (due_day between 1 and 31),
  credit_limit numeric(18, 4) check (credit_limit is null or credit_limit > 0),
  annual_nominal_rate numeric(8, 4),
  monthly_late_rate numeric(8, 4),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.movements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  direction text not null check (direction in ('ingreso', 'gasto', 'transferencia')),
  amount numeric(18, 4) not null check (amount > 0),
  currency text not null,
  detail text not null,
  category_id uuid references public.categories(id) on delete set null,
  payment_method text not null check (payment_method in ('efectivo', 'tarjeta', 'transferencia', 'debito')),
  account_id uuid references public.accounts(id) on delete set null,
  card_id uuid references public.cards(id) on delete set null,
  movement_date date not null,
  installments_total integer check (installments_total is null or installments_total > 0),
  installment_number integer check (
    installment_number is null
    or (installment_number > 0 and installments_total is not null and installment_number <= installments_total)
  ),
  raw_message text,
  ai_payload jsonb,
  created_at timestamptz not null default now(),
  constraint movements_payment_card_check check (
    (payment_method = 'tarjeta' and card_id is not null)
    or (payment_method <> 'tarjeta')
  )
);

create table if not exists public.card_statements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  card_id uuid not null references public.cards(id) on delete cascade,
  period_year smallint not null,
  period_month smallint not null check (period_month between 1 and 12),
  opened_at date not null,
  closed_at date not null,
  due_date date not null,
  total_amount numeric(18, 4) not null default 0,
  minimum_payment numeric(18, 4) not null default 0,
  interest_amount numeric(18, 4) not null default 0,
  status text not null check (status in ('abierto', 'cerrado', 'pagado', 'vencido')),
  created_at timestamptz not null default now(),
  unique (card_id, period_year, period_month)
);

create table if not exists public.card_statement_items (
  statement_id uuid not null references public.card_statements(id) on delete cascade,
  movement_id uuid not null references public.movements(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (statement_id, movement_id)
);

create table if not exists public.card_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  card_id uuid not null references public.cards(id) on delete cascade,
  statement_id uuid references public.card_statements(id) on delete set null,
  source_account_id uuid references public.accounts(id) on delete set null,
  amount numeric(18, 4) not null check (amount > 0),
  payment_date date not null,
  created_at timestamptz not null default now()
);

create table if not exists public.debts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  creditor text,
  principal_amount numeric(18, 4) not null check (principal_amount > 0),
  outstanding_amount numeric(18, 4) not null check (outstanding_amount >= 0),
  annual_rate numeric(8, 4),
  due_date date,
  priority smallint not null default 3 check (priority between 1 and 5),
  status text not null default 'activa' check (status in ('activa', 'pagada', 'cancelada')),
  created_at timestamptz not null default now()
);

create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  target_amount numeric(18, 4) not null check (target_amount > 0),
  target_date date,
  strategy text not null check (strategy in ('ahorro', 'mixta', 'financiada')),
  status text not null default 'activa' check (status in ('activa', 'cumplida', 'cancelada')),
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.goal_contributions (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references public.goals(id) on delete cascade,
  movement_id uuid references public.movements(id) on delete set null,
  amount numeric(18, 4) not null check (amount > 0),
  contribution_date date not null,
  created_at timestamptz not null default now()
);

create table if not exists public.scenarios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  assumptions jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_movements_user_date
  on public.movements (user_id, movement_date desc);

create index if not exists idx_movements_user_card_date
  on public.movements (user_id, card_id, movement_date desc);

create index if not exists idx_statements_card_period
  on public.card_statements (card_id, period_year desc, period_month desc);

create index if not exists idx_card_payments_user_date
  on public.card_payments (user_id, payment_date desc);

create index if not exists idx_goals_user_status
  on public.goals (user_id, status);

create index if not exists idx_debts_user_status
  on public.debts (user_id, status);

create index if not exists idx_scenarios_user_created_at
  on public.scenarios (user_id, created_at desc);
