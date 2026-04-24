alter table public.profiles
  add column if not exists auto_create_category_default boolean not null default false;

notify pgrst, 'reload schema';
