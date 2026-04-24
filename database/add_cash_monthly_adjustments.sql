create table if not exists public.cash_monthly_adjustments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  period_year smallint not null,
  period_month smallint not null check (period_month between 1 and 12),
  previous_balance numeric(18, 4) not null check (previous_balance >= 0),
  new_balance numeric(18, 4) not null check (new_balance >= 0),
  adjustment_amount numeric(18, 4) not null,
  reason text not null check (char_length(trim(reason)) > 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_cash_monthly_adjustments_user_period
  on public.cash_monthly_adjustments (user_id, period_year desc, period_month desc, created_at asc);

create index if not exists idx_cash_monthly_adjustments_account_period
  on public.cash_monthly_adjustments (account_id, period_year, period_month, created_at asc);
