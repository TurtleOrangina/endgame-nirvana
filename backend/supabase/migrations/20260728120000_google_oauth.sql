-- "Sign in with Google" support.
--
-- Three concerns, in dependency order:
--   1. `profiles.username` must become nullable — an OAuth signup carries no
--      signup metadata, so `handle_new_user` has nothing to put there.
--   2. Google's surplus profile claims (name, picture, locale, …) must never be
--      persisted; only the subject id and email are kept.
--   3. An OAuth user needs a way to fill in the username / starting Elo that an
--      email signup passes as metadata.

-- =============================================================================
-- 1. profiles.username is only known after onboarding
-- =============================================================================

-- An email signup supplies `username` as signup metadata, so the profile row is
-- complete the moment it is created. An OAuth signup has no such hook: the row
-- is created by the trigger below during the redirect back from Google, before
-- the user has been asked anything. A null username is therefore the marker for
-- "signed in, but onboarding is not finished" — see initialize_oauth_profile.
alter table public.profiles alter column username drop not null;

-- Unchanged in behaviour for email signups (the metadata is still read); the
-- coalesce on start_elo already covered a missing value, and username may now
-- legitimately arrive as null.
create or replace function public.handle_new_user()
returns trigger
security definer
set search_path = ''
language plpgsql
as $$
begin
  insert into public.profiles (id, username, endgame_elo)
  values (
    new.id,
    new.raw_user_meta_data ->> 'username',
    coalesce((new.raw_user_meta_data ->> 'start_elo')::integer, 1400)
  );
  return new;
end;
$$;

-- =============================================================================
-- 2. Keep only the claims we actually need
-- =============================================================================

-- Google returns name, given_name, family_name, picture, locale and more
-- alongside the subject id, and GoTrue persists the whole payload — into
-- `auth.users.raw_user_meta_data` and `auth.identities.identity_data`, both
-- rewritten on *every* sign-in, not just the first. None of it is used by this
-- app, and storing a user's real name and avatar URL is a materially different
-- privacy posture than storing a self-chosen nickname, so it is pruned on the
-- way in.
--
-- Both filters are allowlists rather than "drop these keys": a provider adding
-- a new claim later should be discarded by default, not silently stored.

-- `sub`/`email`/`email_verified` are load-bearing for GoTrue itself (identity
-- matching and the email it surfaces on the session), so they stay.
create function public.strip_surplus_identity_claims()
returns trigger
set search_path = ''
language plpgsql
as $$
begin
  new.identity_data = (
    select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
    from jsonb_each(new.identity_data)
    where key in ('sub', 'email', 'email_verified')
  );
  return new;
end;
$$;

create trigger strip_surplus_identity_claims
  before insert or update of identity_data on auth.identities
  for each row
  execute function public.strip_surplus_identity_claims();

-- `username`/`start_elo` are this app's own email-signup metadata; the rest are
-- written by GoTrue and read back by it in some flows.
create function public.strip_surplus_user_claims()
returns trigger
set search_path = ''
language plpgsql
as $$
begin
  new.raw_user_meta_data = (
    select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
    from jsonb_each(new.raw_user_meta_data)
    where key in ('username', 'start_elo', 'sub', 'email', 'email_verified', 'phone_verified')
  );
  return new;
end;
$$;

create trigger strip_surplus_user_claims
  before insert or update of raw_user_meta_data on auth.users
  for each row
  execute function public.strip_surplus_user_claims();

-- Retroactively prune anything already stored (no-op on a fresh database, but
-- this migration may land after Google login has been live for a while).
update auth.identities
set identity_data = identity_data
where identity_data ?| array['name', 'full_name', 'given_name', 'family_name',
                             'picture', 'avatar_url', 'locale'];

update auth.users
set raw_user_meta_data = raw_user_meta_data
where raw_user_meta_data ?| array['name', 'full_name', 'given_name', 'family_name',
                                  'picture', 'avatar_url', 'locale'];

-- =============================================================================
-- 3. Onboarding an OAuth user
-- =============================================================================

-- The email-signup path carries username/start_elo as signup metadata, which
-- `handle_new_user` reads. OAuth has no equivalent, so the client collects both
-- after the redirect and calls this.
--
-- Deliberately one-shot: it only ever fills a *null* username, so it cannot be
-- replayed to reset a played-in Elo (`endgame_elo` is otherwise server-owned and
-- absent from the client's column-scoped update grant — see record_attempts).
-- Renaming later goes through the normal `profiles` update path.
create function public.initialize_oauth_profile(p_username text, p_start_elo integer)
returns void
security definer
set search_path = ''
language plpgsql
as $$
declare
  v_username text := nullif(btrim(p_username), '');
begin
  if v_username is null then
    raise exception 'username must not be empty';
  end if;

  update public.profiles
  set username = left(v_username, 40),
      endgame_elo = greatest(400, least(3000, coalesce(p_start_elo, 1400)))
  where id = (select auth.uid())
    and username is null;
end;
$$;

revoke execute on function public.initialize_oauth_profile(text, integer) from public, anon;
grant execute on function public.initialize_oauth_profile(text, integer) to authenticated;

revoke execute on function public.strip_surplus_identity_claims() from public, anon, authenticated;
revoke execute on function public.strip_surplus_user_claims() from public, anon, authenticated;
