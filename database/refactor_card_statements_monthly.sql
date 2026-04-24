-- Refactor: deuda de tarjeta centrada en resumen mensual (mes calendario)
-- - Las cuotas quedan como proyección/armado de resumen, no como imputación directa de pago.
-- - Los pagos de tarjeta se imputan FIFO por resumen pendiente (más viejo primero).

alter table public.card_statements
  add column if not exists paid_amount numeric(18,4) not null default 0,
  add column if not exists outstanding_amount numeric(18,4) not null default 0;

create table if not exists public.card_statement_lines (
  id uuid primary key default gen_random_uuid(),
  statement_id uuid not null references public.card_statements(id) on delete cascade,
  source_type text not null check (source_type in ('movement', 'installment')),
  movement_id uuid references public.movements(id) on delete set null,
  installment_id uuid references public.card_debt_installments(id) on delete set null,
  detail text not null,
  amount numeric(18,4) not null check (amount > 0),
  created_at timestamptz not null default now(),
  constraint card_statement_lines_source_check check (
    (source_type = 'movement' and movement_id is not null and installment_id is null)
    or (source_type = 'installment' and installment_id is not null and movement_id is null)
  )
);

create unique index if not exists ux_card_statement_lines_movement
  on public.card_statement_lines (movement_id)
  where movement_id is not null;

create unique index if not exists ux_card_statement_lines_installment
  on public.card_statement_lines (installment_id)
  where installment_id is not null;

create index if not exists idx_card_statement_lines_statement
  on public.card_statement_lines (statement_id, created_at);

alter table public.card_debt_installments
  add column if not exists statement_id uuid references public.card_statements(id) on delete set null,
  add column if not exists included_at timestamptz;

create table if not exists public.card_statement_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  card_id uuid not null references public.cards(id) on delete restrict,
  movement_id uuid not null unique references public.movements(id) on delete cascade,
  amount numeric(18,4) not null check (amount > 0),
  payment_date date not null,
  created_at timestamptz not null default now()
);

create table if not exists public.card_statement_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.card_statement_payments(id) on delete cascade,
  statement_id uuid not null references public.card_statements(id) on delete cascade,
  applied_amount numeric(18,4) not null check (applied_amount > 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_card_statement_payments_user_date
  on public.card_statement_payments (user_id, payment_date desc);

create index if not exists idx_card_statement_allocs_payment
  on public.card_statement_payment_allocations (payment_id);

create or replace function public.apply_card_statement_payment(p_payment_id uuid)
returns void
language plpgsql
as $$
declare
  v_user_id uuid;
  v_card_id uuid;
  v_remaining numeric(18,4);
  st record;
  v_apply numeric(18,4);
begin
  select p.user_id, p.card_id, p.amount
  into v_user_id, v_card_id, v_remaining
  from public.card_statement_payments p
  where p.id = p_payment_id
  for update;

  if not found then
    raise exception 'card_statement_payment no encontrado';
  end if;

  for st in
    select s.id, s.outstanding_amount
    from public.card_statements s
    where s.user_id = v_user_id
      and s.card_id = v_card_id
      and s.outstanding_amount > 0
      and s.status in ('abierto', 'cerrado', 'vencido')
    order by s.period_year, s.period_month
    for update
  loop
    exit when v_remaining <= 0;
    v_apply := least(v_remaining, st.outstanding_amount);

    update public.card_statements
    set
      paid_amount = round(paid_amount + v_apply, 4),
      outstanding_amount = round(greatest(outstanding_amount - v_apply, 0), 4),
      status = case
        when round(greatest(outstanding_amount - v_apply, 0), 4) = 0 then 'pagado'
        else status
      end
    where id = st.id;

    insert into public.card_statement_payment_allocations (payment_id, statement_id, applied_amount)
    values (p_payment_id, st.id, v_apply);

    v_remaining := round(v_remaining - v_apply, 4);
  end loop;

  if v_remaining > 0 then
    raise exception 'El pago excede la deuda pendiente de tarjeta por %', v_remaining;
  end if;
end;
$$;

create or replace function public.apply_movement_to_debts()
returns trigger
language plpgsql
as $$
declare
  v_event_id uuid;
begin
  if NEW.direction <> 'gasto' then
    return NEW;
  end if;

  if NEW.loan_id is not null and NEW.settled_card_id is not null then
    raise exception 'movement no puede tener loan_id y settled_card_id al mismo tiempo';
  end if;

  if NEW.loan_id is not null then
    insert into public.loan_payment_events (user_id, loan_id, movement_id, amount, payment_date)
    values (NEW.user_id, NEW.loan_id, NEW.id, NEW.amount, NEW.movement_date)
    returning id into v_event_id;

    perform public.allocate_loan_payment_event(v_event_id);
    return NEW;
  end if;

  if NEW.settled_card_id is not null then
    insert into public.card_statement_payments (user_id, card_id, movement_id, amount, payment_date)
    values (NEW.user_id, NEW.settled_card_id, NEW.id, NEW.amount, NEW.movement_date)
    returning id into v_event_id;

    perform public.apply_card_statement_payment(v_event_id);
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

alter table public.card_statement_lines enable row level security;
alter table public.card_statement_payments enable row level security;
alter table public.card_statement_payment_allocations enable row level security;

drop policy if exists card_statement_lines_all_own on public.card_statement_lines;
create policy card_statement_lines_all_own
  on public.card_statement_lines for all
  using (
    exists (
      select 1
      from public.card_statements s
      where s.id = card_statement_lines.statement_id
        and s.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.card_statements s
      where s.id = card_statement_lines.statement_id
        and s.user_id = auth.uid()
    )
  );

drop policy if exists card_statement_payments_all_own on public.card_statement_payments;
create policy card_statement_payments_all_own
  on public.card_statement_payments for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists card_statement_payment_allocations_all_own on public.card_statement_payment_allocations;
create policy card_statement_payment_allocations_all_own
  on public.card_statement_payment_allocations for all
  using (
    exists (
      select 1
      from public.card_statement_payments p
      where p.id = card_statement_payment_allocations.payment_id
        and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.card_statement_payments p
      where p.id = card_statement_payment_allocations.payment_id
        and p.user_id = auth.uid()
    )
  );

notify pgrst, 'reload schema';
