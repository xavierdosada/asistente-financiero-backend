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

  -- Carril histórico: no impacta deudas ni imputaciones automáticas.
  if coalesce(NEW.entry_mode, 'operativo') = 'historico' then
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
