-- Saldo/deuda arrastrada al inicio del período (POST /tarjetas/:id/deuda-inicial).
-- Se suma al total del resumen en cada recálculo desde líneas, para que no se pierda al generar el resumen.

alter table public.card_statements
  add column if not exists opening_carry_amount numeric(18, 4) not null default 0,
  add column if not exists opening_carry_amount_usd numeric(18, 4) not null default 0;

comment on column public.card_statements.opening_carry_amount is
  'Deuda o saldo inicial ARS del período; se suma al total junto con card_statement_lines.';
comment on column public.card_statements.opening_carry_amount_usd is
  'Equivalente en USD si aplica; se suma al total USD junto con las líneas.';

notify pgrst, 'reload schema';
