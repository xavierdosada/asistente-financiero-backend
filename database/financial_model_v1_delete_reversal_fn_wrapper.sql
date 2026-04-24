-- Stable RPC wrapper to avoid overloaded function cache issues in PostgREST.
-- Run after financial_model_v1_delete_reversal_fn.sql

create or replace function public.delete_movement_with_reversal_v1(
  p_user_id uuid,
  p_movement_id uuid,
  p_deleted_by uuid,
  p_reason text default null
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.delete_movement_with_reversal(
    p_user_id,
    p_movement_id,
    p_deleted_by,
    p_reason
  );
$$;

grant execute on function public.delete_movement_with_reversal_v1(uuid, uuid, uuid, text)
to authenticated, service_role;

notify pgrst, 'reload schema';
