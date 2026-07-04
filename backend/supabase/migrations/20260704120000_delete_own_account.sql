-- Lets a signed-in user delete their own account. Deleting from auth.users
-- cascades to public.profiles and public.attempts (both declared
-- `on delete cascade` against auth.users in the app schema), so this function
-- alone is enough to remove all of a user's data. Deleting from auth.users
-- requires elevated privileges the `authenticated` role doesn't have, hence
-- `security definer` (runs as the function owner, not the caller).
create function public.delete_own_account()
returns void
security definer
set search_path = ''
language plpgsql
as $$
begin
  delete from auth.users where id = auth.uid();
end;
$$;

revoke execute on function public.delete_own_account() from public, anon;
grant execute on function public.delete_own_account() to authenticated;
