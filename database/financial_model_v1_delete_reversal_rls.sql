-- RLS for phase 2 reversible deletion model
-- Run after financial_model_v1_rls.sql and financial_model_v1_delete_reversal.sql

-- Repair columns in case previous schema runs were partial.
alter table public.loan_installments
  add column if not exists debt_id uuid;

alter table public.loan_payment_allocations
  add column if not exists installment_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'loan_installments_debt_id_fkey'
      and conrelid = 'public.loan_installments'::regclass
  ) then
    alter table public.loan_installments
      add constraint loan_installments_debt_id_fkey
      foreign key (debt_id) references public.debts(id) on delete cascade;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'loan_payment_allocations_installment_id_fkey'
      and conrelid = 'public.loan_payment_allocations'::regclass
  ) then
    alter table public.loan_payment_allocations
      add constraint loan_payment_allocations_installment_id_fkey
      foreign key (installment_id) references public.loan_installments(id) on delete cascade;
  end if;
end $$;

alter table public.movement_effects enable row level security;
alter table public.movement_events enable row level security;
alter table public.budgets enable row level security;
alter table public.budget_consumptions enable row level security;
alter table public.loan_installments enable row level security;
alter table public.loan_payment_allocations enable row level security;

drop policy if exists movement_effects_all_own on public.movement_effects;
create policy movement_effects_all_own
  on public.movement_effects for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists movement_events_all_own on public.movement_events;
create policy movement_events_all_own
  on public.movement_events for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists budgets_all_own on public.budgets;
create policy budgets_all_own
  on public.budgets for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists budget_consumptions_all_own on public.budget_consumptions;
create policy budget_consumptions_all_own
  on public.budget_consumptions for all
  using (
    exists (
      select 1
      from public.budgets b
      where b.id = budget_consumptions.budget_id
        and b.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.budgets b
      where b.id = budget_consumptions.budget_id
        and b.user_id = auth.uid()
    )
  );

drop policy if exists loan_installments_all_own on public.loan_installments;
create policy loan_installments_all_own
  on public.loan_installments for all
  using (
    exists (
      select 1
      from public.debts d
      where d.id = loan_installments.debt_id
        and d.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.debts d
      where d.id = loan_installments.debt_id
        and d.user_id = auth.uid()
    )
  );

drop policy if exists loan_payment_allocations_all_own on public.loan_payment_allocations;
create policy loan_payment_allocations_all_own
  on public.loan_payment_allocations for all
  using (
    exists (
      select 1
      from public.loan_installments li
      join public.debts d on d.id = li.debt_id
      where li.id = loan_payment_allocations.installment_id
        and d.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.loan_installments li
      join public.debts d on d.id = li.debt_id
      where li.id = loan_payment_allocations.installment_id
        and d.user_id = auth.uid()
    )
  );

notify pgrst, 'reload schema';
