alter table public.cards
  add column if not exists credit_limit numeric(18, 4);

alter table public.cards
  drop constraint if exists cards_credit_limit_check;

alter table public.cards
  add constraint cards_credit_limit_check
  check (credit_limit is null or credit_limit > 0);
