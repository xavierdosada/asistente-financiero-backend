create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  account_type text not null check (account_type in ('efectivo', 'banco', 'virtual')),
  currency text not null default 'ARS',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

alter table public.movements
  add column if not exists account_id uuid references public.accounts(id) on delete set null;

create index if not exists idx_movements_user_account_date
  on public.movements (user_id, account_id, movement_date desc);
