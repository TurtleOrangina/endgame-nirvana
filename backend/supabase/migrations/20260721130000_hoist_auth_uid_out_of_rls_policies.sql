-- `auth.uid()` is stable, not immutable, so Postgres re-evaluates it once per
-- candidate row instead of once per statement. Wrapping it in a scalar
-- subquery turns it into an InitPlan the planner evaluates a single time.
-- Semantics are unchanged (the value is constant for the duration of a
-- statement either way).

alter policy "profiles are readable by their owner"
  on public.profiles
  using ((select auth.uid()) = id);

alter policy "profiles are updatable by their owner"
  on public.profiles
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

alter policy "attempts are readable by their owner"
  on public.attempts
  using ((select auth.uid()) = user_id);
