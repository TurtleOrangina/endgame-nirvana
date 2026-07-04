-- Puzzle catalog data (fen, category, expected result, elo) isn't sensitive,
-- and the frontend now downloads it directly (no more bundled exercises.json
-- frontend asset) before the user has an account — see
-- frontend/src/stores/exercises.ts. Allow anon read access alongside the
-- existing authenticated access.
drop policy "puzzles are readable by authenticated users" on public.puzzles;

create policy "puzzles are readable by anyone"
  on public.puzzles for select
  to anon, authenticated
  using (true);

grant select on public.puzzles to anon;
