-- pull_state previously returned every row of public.puzzles on every login — the
-- same unrestricted full-pool read we just removed direct client access to in
-- 20260705120000, just moved behind auth instead of in front of it. Scope it down to
-- only the puzzles referenced in the same 8-week attempt window it already returns.
-- A puzzle attempted longer ago than that falls back to the bundled exercises.json
-- difficulty client-side until the user attempts it again — same staleness tradeoff
-- already accepted for the attempts list itself.
create or replace function public.pull_state()
returns jsonb
security definer
set search_path = ''
language plpgsql
as $$
declare
  v_profile jsonb;
  v_attempts jsonb;
  v_puzzles jsonb;
begin
  select to_jsonb(p) into v_profile
  from public.profiles p
  where p.id = auth.uid();

  select coalesce(jsonb_agg(a), '[]'::jsonb) into v_attempts
  from (
    select *
    from public.attempts
    where user_id = auth.uid()
      and attempted_at >= now() - interval '8 weeks'
    order by attempted_at desc
  ) a;

  select coalesce(jsonb_agg(jsonb_build_object('id', pz.id, 'elo', pz.current_elo)), '[]'::jsonb)
  into v_puzzles
  from public.puzzles pz
  where pz.id in (
    select distinct puzzle_id
    from public.attempts
    where user_id = auth.uid()
      and attempted_at >= now() - interval '8 weeks'
      and puzzle_id is not null
  );

  return jsonb_build_object(
    'profile', v_profile,
    'attempts', v_attempts,
    'puzzles', v_puzzles
  );
end;
$$;

revoke execute on function public.pull_state() from public, anon;
grant execute on function public.pull_state() to authenticated;
