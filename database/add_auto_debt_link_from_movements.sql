-- Vinculación automática desde movements hacia pagos de préstamos y cuotas de tarjeta.
--
-- IDEA CLAVE:
-- 1) El movimiento de salida de dinero (direction='gasto') se guarda en public.movements.
-- 2) Si ese movimiento trae loan_id => se aplica automático a cuotas del préstamo.
-- 3) Si trae settled_card_id => se aplica automático a cuotas pendientes de esa tarjeta.
-- 4) Soporta pago total o parcial: distribuye monto sobre cuotas pendientes (FIFO por vencimiento).
--
-- Requiere haber ejecutado antes:
-- - add_card_installment_debts.sql
-- - add_loans_with_installments.sql

-- =====================================================
-- 1) Extensiones de schema
-- =====================================================

alter table public.movements
  add column if not exists loan_id uuid references public.loans(id) on delete set null,
  add column if not exists settled_card_id uuid references public.cards(id) on delete set null;

-- Cada cuota ahora lleva acumulado pagado para permitir pago parcial real.
alter table public.card_debt_installments
  add column if not exists paid_amount numeric(18,4) not null default 0 check (paid_amount >= 0);

alter table public.loan_installments
  add column if not exists paid_amount numeric(18,4) not null default 0 check (paid_amount >= 0);

-- Backfill: si ya estaban marcadas como pagadas en migraciones previas, reflejar paid_amount completo.
update public.card_debt_installments
set paid_amount = amount
where status = 'pagada'
  and paid_amount < amount;

update public.loan_installments
set paid_amount = amount
where status = 'pagada'
  and paid_amount < amount;

-- =====================================================
-- 2) Eventos y asignaciones automáticas
-- =====================================================

create table if not exists public.card_payment_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  card_id uuid not null references public.cards(id) on delete restrict,
  movement_id uuid not null unique references public.movements(id) on delete cascade,
  amount numeric(18,4) not null check (amount > 0),
  payment_date date not null,
  created_at timestamptz not null default now()
);

create table if not exists public.card_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.card_payment_events(id) on delete cascade,
  debt_id uuid not null references public.card_installment_debts(id) on delete cascade,
  installment_id uuid not null references public.card_debt_installments(id) on delete cascade,
  applied_amount numeric(18,4) not null check (applied_amount > 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_card_payment_events_user_date
  on public.card_payment_events (user_id, payment_date desc);

create index if not exists idx_card_payment_allocations_event
  on public.card_payment_allocations (event_id);

create table if not exists public.loan_payment_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  loan_id uuid not null references public.loans(id) on delete restrict,
  movement_id uuid not null unique references public.movements(id) on delete cascade,
  amount numeric(18,4) not null check (amount > 0),
  payment_date date not null,
  created_at timestamptz not null default now()
);

create table if not exists public.loan_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.loan_payment_events(id) on delete cascade,
  loan_id uuid not null references public.loans(id) on delete cascade,
  installment_id uuid not null references public.loan_installments(id) on delete cascade,
  applied_amount numeric(18,4) not null check (applied_amount > 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_loan_payment_events_user_date
  on public.loan_payment_events (user_id, payment_date desc);

create index if not exists idx_loan_payment_allocations_event
  on public.loan_payment_allocations (event_id);

-- =====================================================
-- 3) Funciones de recálculo de deuda
-- =====================================================

create or replace function public.recalc_card_debt(p_debt_id uuid)
returns void
language plpgsql
as $$
declare
  v_outstanding numeric(18,4);
  v_paid_count integer;
begin
  select
    round(coalesce(sum(greatest(i.amount - i.paid_amount, 0)), 0), 4),
    coalesce(sum(case when i.paid_amount >= i.amount then 1 else 0 end), 0)
  into v_outstanding, v_paid_count
  from public.card_debt_installments i
  where i.debt_id = p_debt_id;

  update public.card_installment_debts d
  set
    outstanding_amount = v_outstanding,
    installments_paid = v_paid_count,
    status = case when v_outstanding = 0 then 'pagada' else d.status end,
    updated_at = now()
  where d.id = p_debt_id;
end;
$$;

create or replace function public.recalc_loan(p_loan_id uuid)
returns void
language plpgsql
as $$
declare
  v_outstanding numeric(18,4);
  v_paid_count integer;
begin
  select
    round(coalesce(sum(greatest(i.amount - i.paid_amount, 0)), 0), 4),
    coalesce(sum(case when i.paid_amount >= i.amount then 1 else 0 end), 0)
  into v_outstanding, v_paid_count
  from public.loan_installments i
  where i.loan_id = p_loan_id;

  update public.loans l
  set
    outstanding_amount = v_outstanding,
    installments_paid = v_paid_count,
    status = case when v_outstanding = 0 then 'pagada' else l.status end,
    updated_at = now()
  where l.id = p_loan_id;
end;
$$;

-- =====================================================
-- 4) Asignación FIFO de pagos (parcial o total)
-- =====================================================

create or replace function public.allocate_card_payment_event(p_event_id uuid)
returns void
language plpgsql
as $$
declare
  v_user_id uuid;
  v_card_id uuid;
  v_remaining numeric(18,4);
  rec record;
  v_apply numeric(18,4);
begin
  select e.user_id, e.card_id, e.amount
  into v_user_id, v_card_id, v_remaining
  from public.card_payment_events e
  where e.id = p_event_id
  for update;

  if not found then
    raise exception 'card_payment_event no encontrado';
  end if;

  for rec in
    select
      i.id as installment_id,
      i.debt_id,
      i.amount,
      i.paid_amount,
      i.due_date,
      i.installment_number
    from public.card_debt_installments i
    join public.card_installment_debts d on d.id = i.debt_id
    where d.user_id = v_user_id
      and d.card_id = v_card_id
      and d.status <> 'pagada'
      and i.paid_amount < i.amount
    order by i.due_date, i.installment_number
    for update of i
  loop
    exit when v_remaining <= 0;
    v_apply := least(v_remaining, rec.amount - rec.paid_amount);

    update public.card_debt_installments
    set
      paid_amount = round(paid_amount + v_apply, 4),
      status = case when round(paid_amount + v_apply, 4) >= amount then 'pagada' else status end,
      paid_at = case when round(paid_amount + v_apply, 4) >= amount then current_date else paid_at end
    where id = rec.installment_id;

    insert into public.card_payment_allocations (event_id, debt_id, installment_id, applied_amount)
    values (p_event_id, rec.debt_id, rec.installment_id, v_apply);

    v_remaining := round(v_remaining - v_apply, 4);
  end loop;

  if v_remaining > 0 then
    raise exception 'El pago excede deuda pendiente de tarjeta por %', v_remaining;
  end if;

  perform public.recalc_card_debt(x.debt_id)
  from (
    select distinct debt_id
    from public.card_payment_allocations
    where event_id = p_event_id
  ) x;
end;
$$;

create or replace function public.allocate_loan_payment_event(p_event_id uuid)
returns void
language plpgsql
as $$
declare
  v_user_id uuid;
  v_loan_id uuid;
  v_remaining numeric(18,4);
  rec record;
  v_apply numeric(18,4);
begin
  select e.user_id, e.loan_id, e.amount
  into v_user_id, v_loan_id, v_remaining
  from public.loan_payment_events e
  where e.id = p_event_id
  for update;

  if not found then
    raise exception 'loan_payment_event no encontrado';
  end if;

  if not exists (
    select 1
    from public.loans l
    where l.id = v_loan_id and l.user_id = v_user_id
  ) then
    raise exception 'loan_id inválido para el user_id del evento';
  end if;

  for rec in
    select
      i.id as installment_id,
      i.amount,
      i.paid_amount,
      i.due_date,
      i.installment_number
    from public.loan_installments i
    where i.loan_id = v_loan_id
      and i.paid_amount < i.amount
    order by i.due_date, i.installment_number
    for update of i
  loop
    exit when v_remaining <= 0;
    v_apply := least(v_remaining, rec.amount - rec.paid_amount);

    update public.loan_installments
    set
      paid_amount = round(paid_amount + v_apply, 4),
      status = case when round(paid_amount + v_apply, 4) >= amount then 'pagada' else status end,
      paid_at = case when round(paid_amount + v_apply, 4) >= amount then current_date else paid_at end
    where id = rec.installment_id;

    insert into public.loan_payment_allocations (event_id, loan_id, installment_id, applied_amount)
    values (p_event_id, v_loan_id, rec.installment_id, v_apply);

    v_remaining := round(v_remaining - v_apply, 4);
  end loop;

  if v_remaining > 0 then
    raise exception 'El pago excede deuda pendiente del préstamo por %', v_remaining;
  end if;

  perform public.recalc_loan(v_loan_id);
end;
$$;

-- =====================================================
-- 5) Trigger automático desde movements
-- =====================================================

create or replace function public.apply_movement_to_debts()
returns trigger
language plpgsql
as $$
declare
  v_event_id uuid;
begin
  -- Solo salida de dinero.
  if NEW.direction <> 'gasto' then
    return NEW;
  end if;

  -- Evitar ambigüedad: un movimiento no puede ser préstamo y tarjeta al mismo tiempo.
  if NEW.loan_id is not null and NEW.settled_card_id is not null then
    raise exception 'movement no puede tener loan_id y settled_card_id al mismo tiempo';
  end if;

  -- Pago de préstamo (automático)
  if NEW.loan_id is not null then
    insert into public.loan_payment_events (user_id, loan_id, movement_id, amount, payment_date)
    values (NEW.user_id, NEW.loan_id, NEW.id, NEW.amount, NEW.movement_date)
    returning id into v_event_id;

    perform public.allocate_loan_payment_event(v_event_id);
    return NEW;
  end if;

  -- Pago de tarjeta (automático)
  if NEW.settled_card_id is not null then
    insert into public.card_payment_events (user_id, card_id, movement_id, amount, payment_date)
    values (NEW.user_id, NEW.settled_card_id, NEW.id, NEW.amount, NEW.movement_date)
    returning id into v_event_id;

    perform public.allocate_card_payment_event(v_event_id);
    return NEW;
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_apply_movement_to_debts on public.movements;
create trigger trg_apply_movement_to_debts
after insert on public.movements
for each row
execute function public.apply_movement_to_debts();

-- =====================================================
-- 6) RLS para eventos/asignaciones
-- =====================================================

alter table public.card_payment_events enable row level security;
alter table public.card_payment_allocations enable row level security;
alter table public.loan_payment_events enable row level security;
alter table public.loan_payment_allocations enable row level security;

drop policy if exists card_payment_events_all_own on public.card_payment_events;
create policy card_payment_events_all_own
  on public.card_payment_events for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists loan_payment_events_all_own on public.loan_payment_events;
create policy loan_payment_events_all_own
  on public.loan_payment_events for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists card_payment_allocations_all_own on public.card_payment_allocations;
create policy card_payment_allocations_all_own
  on public.card_payment_allocations for all
  using (
    exists (
      select 1
      from public.card_payment_events e
      where e.id = card_payment_allocations.event_id
        and e.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.card_payment_events e
      where e.id = card_payment_allocations.event_id
        and e.user_id = auth.uid()
    )
  );

drop policy if exists loan_payment_allocations_all_own on public.loan_payment_allocations;
create policy loan_payment_allocations_all_own
  on public.loan_payment_allocations for all
  using (
    exists (
      select 1
      from public.loan_payment_events e
      where e.id = loan_payment_allocations.event_id
        and e.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.loan_payment_events e
      where e.id = loan_payment_allocations.event_id
        and e.user_id = auth.uid()
    )
  );

notify pgrst, 'reload schema';
