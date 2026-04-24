-- Optional icon for categories (Lucide icon component name, e.g. "ShoppingCart").
alter table public.categories
  add column if not exists icon_key text;

comment on column public.categories.icon_key is 'Lucide React icon name chosen in the app UI; null = default icon.';
