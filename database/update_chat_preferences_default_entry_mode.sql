alter table public.profiles
  add column if not exists default_entry_mode text not null default 'operativo'
  check (default_entry_mode in ('operativo', 'historico'));

update public.profiles
set default_entry_mode = 'operativo'
where default_entry_mode is null;

notify pgrst, 'reload schema';
