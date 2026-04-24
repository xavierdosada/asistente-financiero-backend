-- RPC function: soft delete movement with financial reversals
-- Run after financial_model_v1_delete_reversal.sql

create or replace function public.delete_movement_with_reversal(
  p_user_id uuid,
  p_movement_id uuid,
  p_deleted_by uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_movement_status text;
  v_goal_count integer := 0;
  v_budget_count integer := 0;
  v_loan_alloc_count integer := 0;
  v_loan_installment_count integer := 0;
  v_effect_count integer := 0;
  v_statement_count integer := 0;
  v_card_debt_count integer := 0;
  v_loan_ids uuid[] := array[]::uuid[];
  v_loan_id uuid;
begin
  select m.status
    into v_movement_status
  from public.movements m
  where m.id = p_movement_id
    and m.user_id = p_user_id
  for update;

  if not found then
    raise exception 'movement_not_found';
  end if;

  if v_movement_status = 'deleted' then
    return jsonb_build_object(
      'deleted', false,
      'already_deleted', true,
      'movement_id', p_movement_id,
      'reversed_goal_contributions', 0,
      'reversed_budget_consumptions', 0,
      'reversed_loan_allocations', 0,
      'recalculated_loan_installments', 0,
      'reversed_movement_effects', 0,
      'recalculated_card_statements', 0,
      'deleted_card_installment_debts', 0
    );
  end if;

  with upd as (
    update public.goal_contributions gc
    set status = 'reversed',
        reversed_at = v_now
    where gc.movement_id = p_movement_id
      and gc.status = 'active'
    returning 1
  )
  select count(*) into v_goal_count from upd;

  with upd as (
    update public.budget_consumptions bc
    set status = 'reversed',
        reversed_at = v_now
    where bc.movement_id = p_movement_id
      and bc.status = 'active'
    returning 1
  )
  select count(*) into v_budget_count from upd;

  -- Préstamo: esquema real (add_auto_debt_link_from_movements) usa loan_payment_events.movement_id
  -- y loan_payment_allocations (event_id, applied_amount). El bloque legacy con movement_id en
  -- allocations nunca aplicaba y la cuota no volvía al estado anterior al borrar el movimiento.
  select coalesce(array_agg(distinct e.loan_id), array[]::uuid[])
  into v_loan_ids
  from public.loan_payment_events e
  where e.movement_id = p_movement_id
    and e.user_id = p_user_id;

  with ev as (
    select e.id
    from public.loan_payment_events e
    where e.movement_id = p_movement_id
      and e.user_id = p_user_id
  ),
  alloc_by_inst as (
    select
      lpa.installment_id,
      sum(lpa.applied_amount)::numeric(18, 4) as to_reverse
    from public.loan_payment_allocations lpa
    where lpa.event_id in (select id from ev)
    group by lpa.installment_id
  ),
  alloc_count as (
    select count(*)::int as cnt
    from public.loan_payment_allocations lpa
    where lpa.event_id in (select id from ev)
  ),
  upd_inst as (
    update public.loan_installments li
    set
      paid_amount = round(
        greatest(coalesce(li.paid_amount, 0) - abi.to_reverse, 0),
        4
      ),
      status = case
        when round(
          greatest(coalesce(li.paid_amount, 0) - abi.to_reverse, 0),
          4
        ) >= li.amount then 'pagada'
        when li.due_date < current_date then 'vencida'
        else 'pendiente'
      end,
      paid_at = case
        when round(
          greatest(coalesce(li.paid_amount, 0) - abi.to_reverse, 0),
          4
        ) >= li.amount then li.paid_at
        else null
      end
    from alloc_by_inst abi
    where li.id = abi.installment_id
    returning li.id
  ),
  del_ev as (
    delete from public.loan_payment_events e
    where e.id in (select id from ev)
    returning e.id
  )
  select
    (select c.cnt from alloc_count c),
    (select count(*)::int from upd_inst)
  into v_loan_alloc_count, v_loan_installment_count;

  foreach v_loan_id in array v_loan_ids
  loop
    perform public.recalc_loan(v_loan_id);
  end loop;

  with upd as (
    update public.movement_effects me
    set status = 'reversed',
        reversed_at = v_now
    where me.source_movement_id = p_movement_id
      and me.status = 'active'
    returning 1
  )
  select count(*) into v_effect_count from upd;

  with touched as (
    select distinct csi.statement_id
    from public.card_statement_items csi
    where csi.movement_id = p_movement_id
  ),
  totals as (
    select csi.statement_id,
           coalesce(sum(m.amount), 0) as total_amount
    from public.card_statement_items csi
    join public.movements m on m.id = csi.movement_id
    where csi.statement_id in (select statement_id from touched)
      and m.status = 'active'
    group by csi.statement_id
  ),
  upd as (
    update public.card_statements cs
    set total_amount = coalesce(t.total_amount, 0),
        minimum_payment = least(coalesce(cs.minimum_payment, 0), coalesce(t.total_amount, 0))
    from touched tt
    left join totals t on t.statement_id = tt.statement_id
    where cs.id = tt.statement_id
    returning cs.id
  )
  select count(*) into v_statement_count from upd;

  -- Compra en cuotas: quitar deuda de tarjeta generada por este movimiento (cuotas en card_debt_installments).
  delete from public.card_statement_lines csl
  using public.card_statements cs
  where csl.movement_id = p_movement_id
    and cs.id = csl.statement_id
    and cs.user_id = p_user_id;

  delete from public.card_statement_items csi
  using public.card_statements cs
  where csi.movement_id = p_movement_id
    and cs.id = csi.statement_id
    and cs.user_id = p_user_id;

  with dd as (
    delete from public.card_installment_debts d
    where d.source_movement_id = p_movement_id
      and d.user_id = p_user_id
    returning 1
  )
  select count(*)::int into v_card_debt_count from dd;

  update public.movements m
  set status = 'deleted',
      deleted_at = v_now,
      deleted_reason = p_reason,
      deleted_by = p_deleted_by
  where m.id = p_movement_id
    and m.user_id = p_user_id;

  insert into public.movement_events (
    user_id,
    movement_id,
    event_type,
    event_payload,
    created_at
  ) values (
    p_user_id,
    p_movement_id,
    'deleted',
    jsonb_build_object(
      'reason', p_reason,
      'reversed_goal_contributions', v_goal_count,
      'reversed_budget_consumptions', v_budget_count,
      'reversed_loan_allocations', v_loan_alloc_count,
      'recalculated_loan_installments', v_loan_installment_count,
      'reversed_movement_effects', v_effect_count,
      'recalculated_card_statements', v_statement_count,
      'deleted_card_installment_debts', v_card_debt_count
    ),
    v_now
  );

  return jsonb_build_object(
    'deleted', true,
    'already_deleted', false,
    'movement_id', p_movement_id,
    'reversed_goal_contributions', v_goal_count,
    'reversed_budget_consumptions', v_budget_count,
    'reversed_loan_allocations', v_loan_alloc_count,
    'recalculated_loan_installments', v_loan_installment_count,
    'reversed_movement_effects', v_effect_count,
    'recalculated_card_statements', v_statement_count,
    'deleted_card_installment_debts', v_card_debt_count
  );
end;
$$;

grant execute on function public.delete_movement_with_reversal(uuid, uuid, uuid, text)
to authenticated, service_role;

notify pgrst, 'reload schema';
