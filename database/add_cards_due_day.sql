alter table public.cards add column if not exists due_day int;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'cards_due_day_check'
      and conrelid = 'public.cards'::regclass
  ) then
    alter table public.cards
      add constraint cards_due_day_check
      check (due_day is null or (due_day between 1 and 31)) not valid;
  end if;
end
$$;

alter table public.cards validate constraint cards_due_day_check;

update public.cards
set due_day = 10
where due_day is null;

notify pgrst, 'reload schema';
