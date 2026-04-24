-- Financial model v1 RLS policies
-- Run after creating tables in financial_model_v1.sql

alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.accounts enable row level security;
alter table public.cards enable row level security;
alter table public.movements enable row level security;
alter table public.card_statements enable row level security;
alter table public.card_statement_items enable row level security;
alter table public.card_payments enable row level security;
alter table public.debts enable row level security;
alter table public.goals enable row level security;
alter table public.goal_contributions enable row level security;
alter table public.scenarios enable row level security;

drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;

create policy profiles_select_own
  on public.profiles for select
  using (auth.uid() = user_id);

create policy profiles_insert_own
  on public.profiles for insert
  with check (auth.uid() = user_id);

create policy profiles_update_own
  on public.profiles for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists categories_all_own on public.categories;
create policy categories_all_own
  on public.categories for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists accounts_all_own on public.accounts;
create policy accounts_all_own
  on public.accounts for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists cards_all_own on public.cards;
create policy cards_all_own
  on public.cards for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists movements_all_own on public.movements;
create policy movements_all_own
  on public.movements for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists statements_all_own on public.card_statements;
create policy statements_all_own
  on public.card_statements for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists payments_all_own on public.card_payments;
create policy payments_all_own
  on public.card_payments for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists debts_all_own on public.debts;
create policy debts_all_own
  on public.debts for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists goals_all_own on public.goals;
create policy goals_all_own
  on public.goals for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists scenarios_all_own on public.scenarios;
create policy scenarios_all_own
  on public.scenarios for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists statement_items_all_own on public.card_statement_items;
create policy statement_items_all_own
  on public.card_statement_items for all
  using (
    exists (
      select 1
      from public.card_statements cs
      where cs.id = card_statement_items.statement_id
        and cs.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.card_statements cs
      where cs.id = card_statement_items.statement_id
        and cs.user_id = auth.uid()
    )
  );

drop policy if exists goal_contributions_all_own on public.goal_contributions;
create policy goal_contributions_all_own
  on public.goal_contributions for all
  using (
    exists (
      select 1
      from public.goals g
      where g.id = goal_contributions.goal_id
        and g.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.goals g
      where g.id = goal_contributions.goal_id
        and g.user_id = auth.uid()
    )
  );

notify pgrst, 'reload schema';
