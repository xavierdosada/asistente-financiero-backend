-- Normalización y unicidad case-insensitive para categorías por usuario.
-- Evita duplicados como "Viajes" vs "viajes".

-- 1) Normalizar espacios en nombres existentes
update public.categories
set name = regexp_replace(trim(name), '\\s+', ' ', 'g')
where name <> regexp_replace(trim(name), '\\s+', ' ', 'g');

-- 2) Detectar posibles duplicados por case-insensitive (revisar antes de crear índice único)
-- select user_id, lower(name), count(*)
-- from public.categories
-- group by user_id, lower(name)
-- having count(*) > 1;

-- 3) Índice único case-insensitive por usuario
create unique index if not exists ux_categories_user_name_ci
  on public.categories (user_id, lower(name));

notify pgrst, 'reload schema';
