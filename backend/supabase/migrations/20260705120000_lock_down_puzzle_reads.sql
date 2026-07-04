-- Puzzle data now ships as a static frontend asset (frontend/public/exercises.json,
-- refreshed periodically via backend/scripts/export_puzzles.mjs) instead of being
-- downloaded from this table at runtime. An unauthenticated, unrestricted select on
-- the whole puzzle pool was an easy DoS vector, so remove all direct client read
-- access — anon and authenticated alike.
drop policy if exists "puzzles are readable by anyone" on public.puzzles;
drop policy if exists "puzzles are readable by authenticated users" on public.puzzles;

revoke select on public.puzzles from anon, authenticated;

-- Inverse of seed_puzzles: lets an operator pull the current pool (including
-- server-learned current_elo) back out, to refresh the frontend asset with
-- up-to-date difficulties. service_role only — see scripts/export_puzzles.mjs.
create function public.export_puzzles()
returns jsonb
security definer
set search_path = ''
language sql
as $$
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'id', id,
      'category_path', category_path,
      'expected_result', expected_result,
      'current_elo', current_elo
    )),
    '[]'::jsonb
  )
  from public.puzzles;
$$;

revoke execute on function public.export_puzzles() from public, anon, authenticated;
grant execute on function public.export_puzzles() to service_role;
