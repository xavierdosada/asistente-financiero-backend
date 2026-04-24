-- Refactor préstamos: usar installment_amount como fuente de cuota.
-- Permite outstanding_amount mayor a principal_amount (caso préstamos con interés/costo financiero).

alter table public.loans
  add column if not exists installment_amount numeric(18,4);

update public.loans
set installment_amount = round(
  case
    when total_installments > 0 then greatest(outstanding_amount, principal_amount) / total_installments
    else principal_amount
  end,
  4
)
where installment_amount is null;

alter table public.loans
  alter column installment_amount set not null;

alter table public.loans
  drop constraint if exists loans_installment_amount_check;

alter table public.loans
  add constraint loans_installment_amount_check
  check (installment_amount > 0);

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

notify pgrst, 'reload schema';
