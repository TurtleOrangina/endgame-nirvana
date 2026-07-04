-- The original app_schema migration created RLS policies for `profiles` but
-- never granted the base table privileges to `authenticated`. RLS policies
-- only restrict which rows are visible/writable — without a GRANT, Postgres
-- rejects access to the whole table first (42501 permission denied),
-- regardless of policy. record_attempts/pull_state never hit this because
-- they're `security definer` (run as the table owner); the client's plain
-- `.from('profiles').update(...)` in src/stores/sync.ts does not have that
-- exemption.
grant select, update on public.profiles to authenticated;
