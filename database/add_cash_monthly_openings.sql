create table if not exists public.cash_monthly_openings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  period_year smallint not null,
  period_month smallint not null check (period_month between 1 and 12),
  opening_balance numeric(18, 4) not null check (opening_balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, account_id, period_year, period_month)
);

create index if not exists idx_cash_monthly_openings_user_period
  on public.cash_monthly_openings (user_id, period_year desc, period_month desc);
