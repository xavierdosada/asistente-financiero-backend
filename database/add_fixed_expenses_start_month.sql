alter table public.fixed_expenses
  add column if not exists start_month date;

alter table public.fixed_expenses
  add column if not exists accrual_day smallint;

update public.fixed_expenses
set start_month = date_trunc('month', coalesce(created_at, now()))::date
where start_month is null;

alter table public.fixed_expenses
  alter column start_month set not null;

alter table public.fixed_expenses
  add constraint fixed_expenses_accrual_day_check
  check (accrual_day is null or accrual_day between 1 and 31);
