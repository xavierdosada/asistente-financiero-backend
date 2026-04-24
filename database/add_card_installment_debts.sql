-- Deudas de tarjeta en cuotas + pagos que descuentan deuda automáticamente

create table if not exists public.card_installment_debts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  card_id uuid not null references public.cards(id) on delete restrict,
  source_movement_id uuid references public.movements(id) on delete set null,
  description text not null,
  currency text not null default 'ARS',
  principal_amount numeric(18,4) not null check (principal_amount > 0),
  outstanding_amount numeric(18,4) not null check (outstanding_amount >= 0),
  total_installments integer not null check (total_installments > 0),
  installments_paid integer not null default 0 check (installments_paid >= 0),
  first_due_date date not null,
  status text not null default 'abierta' check (status in ('abierta', 'pagada', 'cancelada', 'mora')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint card_installment_debts_paid_check check (installments_paid <= total_installments),
  constraint card_installment_debts_source_unique unique (user_id, source_movement_id)
);

create index if not exists idx_card_installment_debts_user_card
  on public.card_installment_debts (user_id, card_id, created_at desc);

create table if not exists public.card_debt_installments (
  id uuid primary key default gen_random_uuid(),
  debt_id uuid not null references public.card_installment_debts(id) on delete cascade,
  installment_number integer not null check (installment_number > 0),
  due_date date not null,
  amount numeric(18,4) not null check (amount > 0),
  status text not null default 'pendiente' check (status in ('pendiente', 'pagada', 'vencida')),
  paid_at date,
  created_at timestamptz not null default now(),
  unique (debt_id, installment_number)
);

create index if not exists idx_card_debt_installments_due
  on public.card_debt_installments (due_date, status);

create table if not exists public.card_installment_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  debt_id uuid not null references public.card_installment_debts(id) on delete cascade,
  amount numeric(18,4) not null check (amount > 0),
  paid_installments integer not null check (paid_installments > 0),
  payment_date date not null,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_card_installment_payments_user_date
  on public.card_installment_payments (user_id, payment_date desc);

create or replace function public.normalize_card_debt_before_insert()
returns trigger
language plpgsql
as $$
begin
  if NEW.outstanding_amount is null then
    NEW.outstanding_amount := NEW.principal_amount;
  end if;

  if NEW.outstanding_amount > NEW.principal_amount then
    raise exception 'outstanding_amount no puede ser mayor a principal_amount';
  end if;

  NEW.updated_at := now();
  if NEW.installments_paid >= NEW.total_installments or NEW.outstanding_amount = 0 then
    NEW.status := 'pagada';
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_normalize_card_debt_before_insert on public.card_installment_debts;
create trigger trg_normalize_card_debt_before_insert
before insert on public.card_installment_debts
for each row
execute function public.normalize_card_debt_before_insert();

create or replace function public.seed_card_debt_installments_after_insert()
returns trigger
language plpgsql
as $$
declare
  i integer;
  base_amount numeric(18,4);
  last_amount numeric(18,4);
begin
  base_amount := round(NEW.principal_amount / NEW.total_installments, 4);
  last_amount := NEW.principal_amount - (base_amount * (NEW.total_installments - 1));

  for i in 1..NEW.total_installments loop
    insert into public.card_debt_installments (
      debt_id,
      installment_number,
      due_date,
      amount,
      status
    )
    values (
      NEW.id,
      i,
      (NEW.first_due_date + ((i - 1) || ' months')::interval)::date,
      case when i = NEW.total_installments then round(last_amount, 4) else base_amount end,
      case when i <= NEW.installments_paid then 'pagada' else 'pendiente' end
    );
  end loop;

  return NEW;
end;
$$;

drop trigger if exists trg_seed_card_debt_installments_after_insert on public.card_installment_debts;
create trigger trg_seed_card_debt_installments_after_insert
after insert on public.card_installment_debts
for each row
execute function public.seed_card_debt_installments_after_insert();

create or replace function public.apply_card_installment_payment()
returns trigger
language plpgsql
as $$
declare
  debt_row public.card_installment_debts%rowtype;
  required_amount numeric(18,4);
  remaining_installments integer;
begin
  select *
  into debt_row
  from public.card_installment_debts
  where id = NEW.debt_id
  for update;

  if not found then
    raise exception 'Deuda de tarjeta no encontrada';
  end if;

  if debt_row.user_id <> NEW.user_id then
    raise exception 'El pago no pertenece al mismo user_id de la deuda';
  end if;

  remaining_installments := debt_row.total_installments - debt_row.installments_paid;
  if NEW.paid_installments > remaining_installments then
    raise exception 'No podés pagar más cuotas de las pendientes (%).', remaining_installments;
  end if;

  with next_installments as (
    select id, amount
    from public.card_debt_installments
    where debt_id = NEW.debt_id
      and status = 'pendiente'
    order by installment_number
    limit NEW.paid_installments
    for update
  )
  select round(coalesce(sum(amount), 0), 4)
  into required_amount
  from next_installments;

  if required_amount <= 0 then
    raise exception 'No hay cuotas pendientes para aplicar pago';
  end if;

  if round(NEW.amount, 4) <> required_amount then
    raise exception 'Monto inválido. Esperado para % cuota(s): %', NEW.paid_installments, required_amount;
  end if;

  update public.card_debt_installments
  set
    status = 'pagada',
    paid_at = NEW.payment_date
  where id in (
    select id
    from public.card_debt_installments
    where debt_id = NEW.debt_id
      and status = 'pendiente'
    order by installment_number
    limit NEW.paid_installments
  );

  update public.card_installment_debts
  set
    installments_paid = installments_paid + NEW.paid_installments,
    outstanding_amount = greatest(round(outstanding_amount - required_amount, 4), 0),
    status = case
      when installments_paid + NEW.paid_installments >= total_installments
        or greatest(round(outstanding_amount - required_amount, 4), 0) = 0
      then 'pagada'
      else status
    end,
    updated_at = now()
  where id = NEW.debt_id;

  return NEW;
end;
$$;

drop trigger if exists trg_apply_card_installment_payment on public.card_installment_payments;
create trigger trg_apply_card_installment_payment
before insert on public.card_installment_payments
for each row
execute function public.apply_card_installment_payment();

create or replace view public.v_card_installment_debts_status as
select
  d.id,
  d.user_id,
  d.card_id,
  d.description,
  d.currency,
  d.principal_amount,
  d.outstanding_amount,
  d.total_installments,
  d.installments_paid,
  (d.total_installments - d.installments_paid) as installments_remaining,
  d.first_due_date,
  d.status,
  d.created_at,
  d.updated_at
from public.card_installment_debts d;

alter table public.card_installment_debts enable row level security;
alter table public.card_debt_installments enable row level security;
alter table public.card_installment_payments enable row level security;

drop policy if exists card_installment_debts_all_own on public.card_installment_debts;
create policy card_installment_debts_all_own
  on public.card_installment_debts for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists card_installment_payments_all_own on public.card_installment_payments;
create policy card_installment_payments_all_own
  on public.card_installment_payments for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists card_debt_installments_all_own on public.card_debt_installments;
create policy card_debt_installments_all_own
  on public.card_debt_installments for all
  using (
    exists (
      select 1
      from public.card_installment_debts d
      where d.id = card_debt_installments.debt_id
        and d.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.card_installment_debts d
      where d.id = card_debt_installments.debt_id
        and d.user_id = auth.uid()
    )
  );

notify pgrst, 'reload schema';
