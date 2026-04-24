-- Cotización USD→ARS por defecto (perfil) y FX usada al registrar cada movimiento.
alter table public.profiles
  add column if not exists default_usd_ars_rate numeric(18, 4);

alter table public.movements
  add column if not exists fx_ars_per_usd numeric(18, 4);

comment on column public.profiles.default_usd_ars_rate is 'ARS por 1 USD; preferencia para chat y gastos con tarjeta en USD.';
comment on column public.movements.fx_ars_per_usd is 'ARS por 1 USD aplicado al registrar el movimiento; obligatorio para gasto+tarjeta+USD en operativo.';

notify pgrst, 'reload schema';
