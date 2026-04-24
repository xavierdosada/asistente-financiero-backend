alter table public.movements
  add column if not exists entry_mode text not null default 'operativo'
  check (entry_mode in ('operativo', 'historico'));

update public.movements
set entry_mode = 'operativo'
where entry_mode is null;

create index if not exists idx_movements_user_entry_mode_date
  on public.movements (user_id, entry_mode, movement_date desc);

notify pgrst, 'reload schema';
