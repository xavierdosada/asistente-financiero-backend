-- Período de facturación (año/mes) por cuota, alineado con calendario de vencimiento de la cuota.
-- Se usa en el resumen de tarjeta para sumar cuotas del mes en curso sin prorrateo.

alter table public.card_debt_installments
  add column if not exists billing_period_year smallint,
  add column if not exists billing_period_month smallint;

update public.card_debt_installments
set
  billing_period_year = extract(year from due_date)::smallint,
  billing_period_month = extract(month from due_date)::smallint
where billing_period_year is null
   or billing_period_month is null;

alter table public.card_debt_installments
  alter column billing_period_year set not null,
  alter column billing_period_month set not null;

alter table public.card_debt_installments
  drop constraint if exists card_debt_installments_billing_period_chk;

alter table public.card_debt_installments
  add constraint card_debt_installments_billing_period_chk
  check (billing_period_month between 1 and 12);

create index if not exists idx_card_debt_installments_billing_period
  on public.card_debt_installments (billing_period_year, billing_period_month, status);

create or replace function public.seed_card_debt_installments_after_insert()
returns trigger
language plpgsql
as $$
declare
  i integer;
  base_amount numeric(18,4);
  last_amount numeric(18,4);
  due_i date;
begin
  base_amount := round(NEW.principal_amount / NEW.total_installments, 4);
  last_amount := NEW.principal_amount - (base_amount * (NEW.total_installments - 1));

  for i in 1..NEW.total_installments loop
    due_i := (NEW.first_due_date + ((i - 1) || ' months')::interval)::date;
    insert into public.card_debt_installments (
      debt_id,
      installment_number,
      due_date,
      amount,
      status,
      billing_period_year,
      billing_period_month
    )
    values (
      NEW.id,
      i,
      due_i,
      case when i = NEW.total_installments then round(last_amount, 4) else base_amount end,
      case when i <= NEW.installments_paid then 'pagada' else 'pendiente' end,
      extract(year from due_i)::smallint,
      extract(month from due_i)::smallint
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

notify pgrst, 'reload schema';
