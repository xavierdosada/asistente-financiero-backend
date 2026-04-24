-- Préstamos + cuotas + pagos que descuentan deuda automáticamente

create table if not exists public.loans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  lender text,
  currency text not null default 'ARS',
  principal_amount numeric(18,4) not null check (principal_amount > 0),
  installment_amount numeric(18,4) not null check (installment_amount > 0),
  outstanding_amount numeric(18,4) not null check (outstanding_amount >= 0),
  annual_rate numeric(8,4),
  total_installments integer not null check (total_installments > 0),
  installments_paid integer not null default 0 check (installments_paid >= 0),
  first_due_date date not null,
  status text not null default 'activa' check (status in ('activa', 'pagada', 'cancelada', 'mora')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint loans_paid_check check (installments_paid <= total_installments)
);

create index if not exists idx_loans_user_status
  on public.loans (user_id, status, created_at desc);

create table if not exists public.loan_installments (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references public.loans(id) on delete cascade,
  installment_number integer not null check (installment_number > 0),
  due_date date not null,
  amount numeric(18,4) not null check (amount > 0),
  status text not null default 'pendiente' check (status in ('pendiente', 'pagada', 'vencida')),
  paid_at date,
  created_at timestamptz not null default now(),
  unique (loan_id, installment_number)
);

create index if not exists idx_loan_installments_due
  on public.loan_installments (due_date, status);

create table if not exists public.loan_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  loan_id uuid not null references public.loans(id) on delete cascade,
  amount numeric(18,4) not null check (amount > 0),
  paid_installments integer not null check (paid_installments > 0),
  payment_date date not null,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_loan_payments_user_date
  on public.loan_payments (user_id, payment_date desc);

create or replace function public.normalize_loan_before_insert()
returns trigger
language plpgsql
as $$
begin
  if NEW.outstanding_amount is null then
    NEW.outstanding_amount := NEW.installment_amount * (NEW.total_installments - NEW.installments_paid);
  end if;

  NEW.updated_at := now();
  if NEW.installments_paid >= NEW.total_installments or NEW.outstanding_amount = 0 then
    NEW.status := 'pagada';
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_normalize_loan_before_insert on public.loans;
create trigger trg_normalize_loan_before_insert
before insert on public.loans
for each row
execute function public.normalize_loan_before_insert();

create or replace function public.seed_loan_installments_after_insert()
returns trigger
language plpgsql
as $$
declare
  i integer;
begin
  for i in 1..NEW.total_installments loop
    insert into public.loan_installments (
      loan_id,
      installment_number,
      due_date,
      amount,
      status
    )
    values (
      NEW.id,
      i,
      (NEW.first_due_date + ((i - 1) || ' months')::interval)::date,
      round(NEW.installment_amount, 4),
      case when i <= NEW.installments_paid then 'pagada' else 'pendiente' end
    );
  end loop;

  return NEW;
end;
$$;

drop trigger if exists trg_seed_loan_installments_after_insert on public.loans;
create trigger trg_seed_loan_installments_after_insert
after insert on public.loans
for each row
execute function public.seed_loan_installments_after_insert();

create or replace function public.apply_loan_payment()
returns trigger
language plpgsql
as $$
declare
  loan_row public.loans%rowtype;
  required_amount numeric(18,4);
  remaining_installments integer;
begin
  select *
  into loan_row
  from public.loans
  where id = NEW.loan_id
  for update;

  if not found then
    raise exception 'Préstamo no encontrado';
  end if;

  if loan_row.user_id <> NEW.user_id then
    raise exception 'El pago no pertenece al mismo user_id del préstamo';
  end if;

  remaining_installments := loan_row.total_installments - loan_row.installments_paid;
  if NEW.paid_installments > remaining_installments then
    raise exception 'No podés pagar más cuotas de las pendientes (%).', remaining_installments;
  end if;

  with next_installments as (
    select id, amount
    from public.loan_installments
    where loan_id = NEW.loan_id
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

  update public.loan_installments
  set
    status = 'pagada',
    paid_at = NEW.payment_date
  where id in (
    select id
    from public.loan_installments
    where loan_id = NEW.loan_id
      and status = 'pendiente'
    order by installment_number
    limit NEW.paid_installments
  );

  update public.loans
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
  where id = NEW.loan_id;

  return NEW;
end;
$$;

drop trigger if exists trg_apply_loan_payment on public.loan_payments;
create trigger trg_apply_loan_payment
before insert on public.loan_payments
for each row
execute function public.apply_loan_payment();

create or replace view public.v_loans_status as
select
  l.id,
  l.user_id,
  l.name,
  l.lender,
  l.currency,
  l.principal_amount,
  l.outstanding_amount,
  l.total_installments,
  l.installments_paid,
  (l.total_installments - l.installments_paid) as installments_remaining,
  l.first_due_date,
  l.status,
  l.created_at,
  l.updated_at
from public.loans l;

alter table public.loans enable row level security;
alter table public.loan_installments enable row level security;
alter table public.loan_payments enable row level security;

drop policy if exists loans_all_own on public.loans;
create policy loans_all_own
  on public.loans for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists loan_payments_all_own on public.loan_payments;
create policy loan_payments_all_own
  on public.loan_payments for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists loan_installments_all_own on public.loan_installments;
create policy loan_installments_all_own
  on public.loan_installments for all
  using (
    exists (
      select 1
      from public.loans l
      where l.id = loan_installments.loan_id
        and l.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.loans l
      where l.id = loan_installments.loan_id
        and l.user_id = auth.uid()
    )
  );

notify pgrst, 'reload schema';
