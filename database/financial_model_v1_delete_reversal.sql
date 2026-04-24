-- Phase 2: reversible movement deletion (soft delete + effect tracking)
-- Run after financial_model_v1.sql

begin;

alter table public.movements
  add column if not exists status text not null default 'active',
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_reason text,
  add column if not exists deleted_by uuid references auth.users(id) on delete set null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'movements_status_check'
      and conrelid = 'public.movements'::regclass
  ) then
    alter table public.movements
      add constraint movements_status_check check (status in ('active', 'deleted'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'movements_deleted_metadata_check'
      and conrelid = 'public.movements'::regclass
  ) then
    alter table public.movements
      add constraint movements_deleted_metadata_check check (
        (status = 'active' and deleted_at is null)
        or (status = 'deleted' and deleted_at is not null)
      );
  end if;
end $$;

create table if not exists public.movement_effects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_movement_id uuid not null references public.movements(id) on delete cascade,
  effect_type text not null check (
    effect_type in (
      'card_installment',
      'card_statement_charge',
      'loan_payment',
      'goal_contribution',
      'budget_consumption'
    )
  ),
  target_table text not null,
  target_id uuid,
  effect_amount numeric(18, 4) not null check (effect_amount >= 0),
  status text not null default 'active' check (status in ('active', 'reversed')),
  created_at timestamptz not null default now(),
  reversed_at timestamptz,
  reversal_movement_id uuid references public.movements(id) on delete set null
);

create table if not exists public.movement_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  movement_id uuid not null references public.movements(id) on delete cascade,
  event_type text not null check (
    event_type in ('created', 'updated', 'deleted', 'restored', 'reversal_applied')
  ),
  event_payload jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  planned_amount numeric(18, 4) not null check (planned_amount > 0),
  status text not null default 'active' check (status in ('active', 'archived', 'cancelled')),
  created_at timestamptz not null default now(),
  unique (user_id, category_id, period_start, period_end),
  check (period_end >= period_start)
);

create table if not exists public.budget_consumptions (
  id uuid primary key default gen_random_uuid(),
  budget_id uuid not null references public.budgets(id) on delete cascade,
  movement_id uuid not null references public.movements(id) on delete cascade,
  amount numeric(18, 4) not null check (amount > 0),
  status text not null default 'active' check (status in ('active', 'reversed')),
  created_at timestamptz not null default now(),
  reversed_at timestamptz,
  unique (budget_id, movement_id)
);

alter table public.goal_contributions
  add column if not exists status text not null default 'active',
  add column if not exists reversed_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'goal_contributions_status_check'
      and conrelid = 'public.goal_contributions'::regclass
  ) then
    alter table public.goal_contributions
      add constraint goal_contributions_status_check
      check (status in ('active', 'reversed'));
  end if;
end $$;

create table if not exists public.loan_installments (
  id uuid primary key default gen_random_uuid(),
  debt_id uuid not null references public.debts(id) on delete cascade,
  installment_number integer not null check (installment_number > 0),
  due_date date not null,
  principal_amount numeric(18, 4) not null check (principal_amount >= 0),
  interest_amount numeric(18, 4) not null check (interest_amount >= 0),
  fee_amount numeric(18, 4) not null default 0 check (fee_amount >= 0),
  total_due numeric(18, 4) not null check (total_due >= 0),
  paid_amount numeric(18, 4) not null default 0 check (paid_amount >= 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'overdue', 'cancelled')),
  created_at timestamptz not null default now(),
  unique (debt_id, installment_number)
);

create table if not exists public.loan_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  installment_id uuid not null references public.loan_installments(id) on delete cascade,
  movement_id uuid not null references public.movements(id) on delete cascade,
  amount_allocated numeric(18, 4) not null check (amount_allocated > 0),
  status text not null default 'active' check (status in ('active', 'reversed')),
  created_at timestamptz not null default now(),
  reversed_at timestamptz
);

-- Backfill/repair status columns in case tables were created in a partial run.
alter table public.movement_effects
  add column if not exists status text;
update public.movement_effects set status = 'active' where status is null;
alter table public.movement_effects alter column status set default 'active';
alter table public.movement_effects alter column status set not null;
alter table public.movement_effects drop constraint if exists movement_effects_status_check;
alter table public.movement_effects
  add constraint movement_effects_status_check
  check (status in ('active', 'reversed'));

alter table public.budgets
  add column if not exists status text;
update public.budgets set status = 'active' where status is null;
alter table public.budgets alter column status set default 'active';
alter table public.budgets alter column status set not null;
alter table public.budgets drop constraint if exists budgets_status_check;
alter table public.budgets
  add constraint budgets_status_check
  check (status in ('active', 'archived', 'cancelled'));

alter table public.budget_consumptions
  add column if not exists status text;
update public.budget_consumptions set status = 'active' where status is null;
alter table public.budget_consumptions alter column status set default 'active';
alter table public.budget_consumptions alter column status set not null;
alter table public.budget_consumptions drop constraint if exists budget_consumptions_status_check;
alter table public.budget_consumptions
  add constraint budget_consumptions_status_check
  check (status in ('active', 'reversed'));

alter table public.loan_installments
  add column if not exists status text;
update public.loan_installments set status = 'pending' where status is null;
alter table public.loan_installments alter column status set default 'pending';
alter table public.loan_installments alter column status set not null;
alter table public.loan_installments drop constraint if exists loan_installments_status_check;
alter table public.loan_installments
  add constraint loan_installments_status_check
  check (status in ('pending', 'paid', 'overdue', 'cancelled'));

alter table public.loan_payment_allocations
  add column if not exists status text;
update public.loan_payment_allocations set status = 'active' where status is null;
alter table public.loan_payment_allocations alter column status set default 'active';
alter table public.loan_payment_allocations alter column status set not null;
alter table public.loan_payment_allocations drop constraint if exists loan_payment_allocations_status_check;
alter table public.loan_payment_allocations
  add constraint loan_payment_allocations_status_check
  check (status in ('active', 'reversed'));

create index if not exists idx_movements_user_status_date
  on public.movements (user_id, status, movement_date desc);

create index if not exists idx_movement_effects_source_status
  on public.movement_effects (source_movement_id, status);

create index if not exists idx_movement_effects_user_status
  on public.movement_effects (user_id, status, created_at desc);

create index if not exists idx_movement_events_user_created
  on public.movement_events (user_id, created_at desc);

create index if not exists idx_budgets_user_period
  on public.budgets (user_id, period_start, period_end);

create index if not exists idx_budget_consumptions_budget_status
  on public.budget_consumptions (budget_id, status);

create index if not exists idx_loan_installments_due_status
  on public.loan_installments (due_date, status);

create index if not exists idx_loan_payment_allocations_installment_status
  on public.loan_payment_allocations (installment_id, status);

notify pgrst, 'reload schema';

commit;
