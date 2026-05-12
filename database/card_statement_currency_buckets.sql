-- Resúmenes de tarjeta: separar montos ARS y USD (líneas en moneda original; pagos por moneda).

-- 1) card_statements: totales USD además de ARS (columnas existentes = ARS)
alter table public.card_statements
  add column if not exists total_amount_usd numeric(18, 4) not null default 0,
  add column if not exists paid_amount_usd numeric(18, 4) not null default 0,
  add column if not exists outstanding_amount_usd numeric(18, 4) not null default 0;

comment on column public.card_statements.total_amount is 'Total consumos en ARS del período.';
comment on column public.card_statements.total_amount_usd is 'Total consumos en USD del período.';
comment on column public.card_statements.paid_amount is 'Pagos imputados en ARS.';
comment on column public.card_statements.paid_amount_usd is 'Pagos imputados en USD.';
comment on column public.card_statements.outstanding_amount is 'Saldo pendiente en ARS.';
comment on column public.card_statements.outstanding_amount_usd is 'Saldo pendiente en USD.';

-- 2) card_statement_lines: moneda original + FX opcional (referencia histórica)
alter table public.card_statement_lines
  add column if not exists currency text not null default 'ARS'
    check (currency in ('ARS', 'USD')),
  add column if not exists fx_ars_per_usd numeric(18, 4);

comment on column public.card_statement_lines.amount is 'Importe en la moneda de currency.';
comment on column public.card_statement_lines.fx_ars_per_usd is 'ARS por 1 USD al registrar el movimiento (solo referencia).';

-- Histórico: las líneas existentes se guardaron en ARS (equivalente); marcarlas ARS.
update public.card_statement_lines
set currency = 'ARS', fx_ars_per_usd = null
where currency is null or trim(currency) = '';

-- 3) Pagos y asignaciones por moneda
alter table public.card_statement_payments
  add column if not exists currency text not null default 'ARS'
    check (currency in ('ARS', 'USD'));

alter table public.card_statement_payment_allocations
  add column if not exists currency text not null default 'ARS'
    check (currency in ('ARS', 'USD'));

update public.card_statement_payments set currency = 'ARS' where currency is null or trim(currency) = '';
update public.card_statement_payment_allocations set currency = 'ARS' where currency is null or trim(currency) = '';

-- 4) Sincronizar totales USD de statements desde líneas (post-backfill líneas = ARS → USD en 0)
update public.card_statements s
set
  total_amount_usd = coalesce(sub.t_usd, 0),
  outstanding_amount_usd = greatest(
    round(coalesce(sub.t_usd, 0) - coalesce(s.paid_amount_usd, 0), 4),
    0
  )
from (
  select statement_id, sum(amount)::numeric(18,4) as t_usd
  from public.card_statement_lines
  where currency = 'USD'
  group by statement_id
) sub
where s.id = sub.statement_id;

-- 5) apply_card_statement_payment: imputar por moneda del pago; permitir sobrepago
create or replace function public.apply_card_statement_payment(p_payment_id uuid)
returns void
language plpgsql
as $$
declare
  v_user_id uuid;
  v_card_id uuid;
  v_remaining numeric(18,4);
  v_currency text;
  st record;
  v_apply numeric(18,4);
  v_out numeric(18,4);
begin
  select p.user_id, p.card_id, p.amount, upper(trim(coalesce(p.currency, 'ARS')))
  into v_user_id, v_card_id, v_remaining, v_currency
  from public.card_statement_payments p
  where p.id = p_payment_id
  for update;

  if not found then
    raise exception 'card_statement_payment no encontrado';
  end if;

  if v_currency not in ('ARS', 'USD') then
    v_currency := 'ARS';
  end if;

  for st in
    select s.id,
      case when v_currency = 'USD' then s.outstanding_amount_usd else s.outstanding_amount end as out_amt
    from public.card_statements s
    where s.user_id = v_user_id
      and s.card_id = v_card_id
      and (
        (v_currency = 'ARS' and s.outstanding_amount > 0)
        or (v_currency = 'USD' and s.outstanding_amount_usd > 0)
      )
      and s.status in ('abierto', 'cerrado', 'vencido')
    order by s.period_year, s.period_month
    for update
  loop
    exit when v_remaining <= 0;
    v_out := st.out_amt;
    v_apply := least(v_remaining, v_out);

    if v_currency = 'USD' then
      update public.card_statements
      set
        paid_amount_usd = round(paid_amount_usd + v_apply, 4),
        outstanding_amount_usd = round(greatest(outstanding_amount_usd - v_apply, 0), 4),
        status = case
          when round(greatest(outstanding_amount, 0), 4) <= 0
           and round(greatest(outstanding_amount_usd - v_apply, 0), 4) <= 0 then 'pagado'
          when status = 'pagado' then 'cerrado'
          else status
        end
      where id = st.id;
    else
      update public.card_statements
      set
        paid_amount = round(paid_amount + v_apply, 4),
        outstanding_amount = round(greatest(outstanding_amount - v_apply, 0), 4),
        status = case
          when round(greatest(outstanding_amount - v_apply, 0), 4) <= 0
           and round(greatest(outstanding_amount_usd, 0), 4) <= 0 then 'pagado'
          when status = 'pagado' then 'cerrado'
          else status
        end
      where id = st.id;
    end if;

    insert into public.card_statement_payment_allocations (payment_id, statement_id, applied_amount, currency)
    values (p_payment_id, st.id, v_apply, v_currency);

    v_remaining := round(v_remaining - v_apply, 4);
  end loop;

  -- Sobrepago: remanente sin asignar (sin excepción)
end;
$$;

-- Corregir status pagado si ambos outstanding son 0 (tras cada pago parcial)
-- La lógica arriba ya setea pagado cuando ambos quedan 0; reforzar con update por si quedó inconsistente
update public.card_statements s
set status = 'pagado'
where s.outstanding_amount <= 0 and s.outstanding_amount_usd <= 0
  and (s.total_amount > 0 or s.total_amount_usd > 0);

-- 6) Trigger: insertar moneda del movimiento en el pago
create or replace function public.apply_movement_to_debts()
returns trigger
language plpgsql
as $$
declare
  v_event_id uuid;
  v_cur text;
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
    v_cur := upper(trim(coalesce(NEW.currency, 'ARS')));
    if v_cur not in ('ARS', 'USD') then
      v_cur := 'ARS';
    end if;

    insert into public.card_statement_payments (user_id, card_id, movement_id, amount, payment_date, currency)
    values (NEW.user_id, NEW.settled_card_id, NEW.id, NEW.amount, NEW.movement_date, v_cur)
    returning id into v_event_id;

    perform public.apply_card_statement_payment(v_event_id);
    return NEW;
  end if;

  return NEW;
end;
$$;

notify pgrst, 'reload schema';
