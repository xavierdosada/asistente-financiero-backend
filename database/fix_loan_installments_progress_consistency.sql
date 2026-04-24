-- Fix loan progress inconsistencies after mixed schema migrations.
-- Goal: keep installments_paid and next installment in sync when registering loan payments.

begin;

-- 1) Normalize loan_installments status vocabulary to Spanish (current backend expects this).
update public.loan_installments
set status = case
  when status = 'paid' then 'pagada'
  when status = 'pending' then 'pendiente'
  when status = 'overdue' then 'vencida'
  when status = 'cancelled' then 'vencida'
  else status
end
where status in ('paid', 'pending', 'overdue', 'cancelled');

-- 2) Ensure paid installments have full paid_amount.
update public.loan_installments
set paid_amount = amount
where status = 'pagada'
  and coalesce(paid_amount, 0) < amount;

-- 3) Recompute status from paid_amount for all installments.
update public.loan_installments
set status = case
  when coalesce(paid_amount, 0) >= amount then 'pagada'
  when due_date < current_date then 'vencida'
  else 'pendiente'
end;

-- 4) Recompute loans.installments_paid/outstanding_amount/status from installments.
with agg as (
  select
    i.loan_id,
    coalesce(sum(case when coalesce(i.paid_amount, 0) >= i.amount then 1 else 0 end), 0) as paid_count,
    round(coalesce(sum(greatest(i.amount - coalesce(i.paid_amount, 0), 0)), 0), 4) as outstanding,
    bool_or(i.status = 'vencida') as has_overdue
  from public.loan_installments i
  group by i.loan_id
)
update public.loans l
set
  installments_paid = a.paid_count,
  outstanding_amount = a.outstanding,
  status = case
    when a.outstanding = 0 then 'pagada'
    when a.has_overdue then 'mora'
    else 'activa'
  end,
  updated_at = now()
from agg a
where l.id = a.loan_id;

-- 5) Keep loan-level recalc fully deterministic for future events too.
create or replace function public.recalc_loan(p_loan_id uuid)
returns void
language plpgsql
as $$
declare
  v_outstanding numeric(18,4);
  v_paid_count integer;
  v_has_overdue boolean;
begin
  select
    round(coalesce(sum(greatest(i.amount - coalesce(i.paid_amount, 0), 0)), 0), 4),
    coalesce(sum(case when coalesce(i.paid_amount, 0) >= i.amount then 1 else 0 end), 0),
    bool_or(
      coalesce(i.paid_amount, 0) < i.amount
      and coalesce(i.status, 'pendiente') = 'vencida'
    )
  into v_outstanding, v_paid_count, v_has_overdue
  from public.loan_installments i
  where i.loan_id = p_loan_id;

  update public.loans l
  set
    outstanding_amount = v_outstanding,
    installments_paid = v_paid_count,
    status = case
      when v_outstanding = 0 then 'pagada'
      when coalesce(v_has_overdue, false) then 'mora'
      else 'activa'
    end,
    updated_at = now()
  where l.id = p_loan_id;
end;
$$;

-- 6) Harden allocator so it skips already-paid installments even with dirty legacy rows.
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
      coalesce(i.paid_amount, 0) as paid_amount,
      i.due_date,
      i.installment_number
    from public.loan_installments i
    where i.loan_id = v_loan_id
      and i.status <> 'pagada'
      and coalesce(i.paid_amount, 0) < i.amount
    order by i.due_date, i.installment_number
    for update of i
  loop
    exit when v_remaining <= 0;
    v_apply := least(v_remaining, rec.amount - rec.paid_amount);

    update public.loan_installments
    set
      paid_amount = round(coalesce(paid_amount, 0) + v_apply, 4),
      status = case
        when round(coalesce(paid_amount, 0) + v_apply, 4) >= amount then 'pagada'
        when due_date < current_date then 'vencida'
        else 'pendiente'
      end,
      paid_at = case when round(coalesce(paid_amount, 0) + v_apply, 4) >= amount then current_date else paid_at end
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

notify pgrst, 'reload schema';

commit;
