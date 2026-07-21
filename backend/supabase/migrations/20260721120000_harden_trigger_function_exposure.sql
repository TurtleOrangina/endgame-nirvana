-- Supabase advisor cleanup for the two trigger functions in `public`.
--
-- Neither is meant to be reachable from the API — they only ever run as
-- triggers — but living in the `public` schema means PostgREST exposes them at
-- /rest/v1/rpc/<name> and Postgres grants EXECUTE to `public` by default.

-- `set_profiles_updated_at` runs as the caller (`security invoker`), so it
-- inherited whatever `search_path` the session had set. Pin it like every other
-- function in the schema; `now()` resolves from the implicit `pg_catalog`.
create or replace function public.set_profiles_updated_at()
returns trigger
set search_path = ''
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Calling a trigger function directly already errors out, but there is no
-- reason for clients to hold EXECUTE on either of these. Triggers fire
-- regardless of the caller's privileges on the function.
revoke execute on function public.set_profiles_updated_at() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
