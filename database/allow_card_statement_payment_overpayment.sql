-- Permite pagos de tarjeta que excedan la deuda pendiente (saldo a favor sin asignar).
-- El remanente queda sin filas en card_statement_payment_allocations hasta el próximo resumen.

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

  -- Sobrepago: v_remaining > 0 se deja como crédito sin asignar (sin excepción).
end;
$$;

notify pgrst, 'reload schema';
