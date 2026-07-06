-- Profile puzzle counters were client-reported (pushed along with the rest of
-- the profile row), so a "cloud wins" pull racing an in-flight flush could
-- reset them to the fresh signup row's zeros even though the attempts
-- themselves synced fine. Derive them server-side instead: record_attempts
-- increments puzzles_solved/puzzles_failed for each newly inserted attempt
-- (its client_attempt_id dedupe already guarantees exactly-once counting) and
-- the client stops sending counters entirely. puzzles_attempted is dropped
-- outright — it is always puzzles_solved + puzzles_failed.
--
-- Also slims public.attempts:
--   * user_elo_before is always new_elo - elo_change; it stays an RPC input
--     (the puzzle-Elo expected-score math needs it) but is no longer persisted.
--   * the surrogate bigint id was only used to detect fresh inserts;
--     (user_id, client_attempt_id) is already unique and becomes the primary
--     key, saving a column and an index.

-- Backfill before switching to server-derived counting: the race above only
-- ever made counters too low, and counting synced attempts is a lower bound
-- too (attempts older than 8 weeks are trimmed) — so take the max of the two.
update public.profiles p
set
  puzzles_solved = greatest(p.puzzles_solved, a.solved_count),
  puzzles_failed = greatest(p.puzzles_failed, a.failed_count)
from (
  select
    user_id,
    count(*) filter (where solved) as solved_count,
    count(*) filter (where not solved) as failed_count
  from public.attempts
  group by user_id
) a
where a.user_id = p.id;

alter table public.profiles drop column puzzles_attempted;

-- Counters are server-maintained now, so the client's direct profiles update
-- path must not be able to write them. Replace the table-wide update grant
-- (from 20260703120000) with a column list of what the client legitimately
-- owns; updated_at is stamped by a trigger, which is exempt from column
-- privilege checks.
revoke update on public.profiles from authenticated;
grant update (username, endgame_elo, settings) on public.profiles to authenticated;

alter table public.attempts drop column user_elo_before;
alter table public.attempts drop column id;
alter table public.attempts drop constraint attempts_user_id_client_attempt_id_key;
alter table public.attempts add primary key (user_id, client_attempt_id);

create or replace function public.record_attempts(p_attempts jsonb)
returns jsonb
security definer
set search_path = ''
language plpgsql
as $$
declare
  v_attempt jsonb;
  v_inserted boolean;
  v_puzzle_id text;
  v_current_elo integer;
  v_attempt_count integer;
  v_k numeric;
  v_expected numeric;
  v_actual numeric;
  v_delta integer;
  v_new_puzzle_elo integer;
  v_touched_puzzles jsonb := '[]'::jsonb;
  v_newly_solved integer := 0;
  v_newly_failed integer := 0;
begin
  for v_attempt in select * from jsonb_array_elements(p_attempts)
  loop
    v_puzzle_id := v_attempt ->> 'puzzle_id';

    insert into public.attempts (
      user_id, client_attempt_id, puzzle_id, transform_code,
      solved, elo_change, new_elo, attempted_at
    )
    values (
      auth.uid(),
      (v_attempt ->> 'client_attempt_id')::uuid,
      v_puzzle_id,
      v_attempt ->> 'transform_code',
      (v_attempt ->> 'solved')::boolean,
      (v_attempt ->> 'elo_change')::integer,
      (v_attempt ->> 'new_elo')::integer,
      (v_attempt ->> 'attempted_at')::timestamptz
    )
    on conflict (user_id, client_attempt_id) do nothing
    returning true into v_inserted;

    -- Only newly-inserted attempts are counted and affect puzzle Elo, so
    -- replaying the same attempt twice (e.g. a retried sync) never
    -- double-counts it.
    if v_inserted then
      if (v_attempt ->> 'solved')::boolean then
        v_newly_solved := v_newly_solved + 1;
      else
        v_newly_failed := v_newly_failed + 1;
      end if;

      if v_puzzle_id is not null then
        select current_elo, attempt_count into v_current_elo, v_attempt_count
        from public.puzzles
        where id = v_puzzle_id
        for update;

        if found then
          v_k := greatest(16, 64 - v_attempt_count * 0.5);
          v_expected := 1 / (1 + power(10, (((v_attempt ->> 'user_elo_before')::integer - v_current_elo)::numeric / 400)));
          v_actual := case when (v_attempt ->> 'solved')::boolean then 0 else 1 end;
          -- floor(x + 0.5) matches JS Math.round for negative halves.
          v_delta := floor(v_k * (v_actual - v_expected) + 0.5);

          update public.puzzles
          set
            current_elo = current_elo + v_delta,
            attempt_count = attempt_count + 1,
            solve_count = solve_count + case when (v_attempt ->> 'solved')::boolean then 1 else 0 end,
            updated_at = now()
          where id = v_puzzle_id
          returning current_elo into v_new_puzzle_elo;

          v_touched_puzzles := v_touched_puzzles || jsonb_build_object('id', v_puzzle_id, 'elo', v_new_puzzle_elo);
        end if;
      end if;
    end if;
  end loop;

  if v_newly_solved + v_newly_failed > 0 then
    update public.profiles
    set
      puzzles_solved = puzzles_solved + v_newly_solved,
      puzzles_failed = puzzles_failed + v_newly_failed
    where id = auth.uid();
  end if;

  -- Trim: this user's sync history only needs to cover the recent-attempt
  -- exclusion window the frontend uses to avoid repeating puzzles.
  delete from public.attempts
  where user_id = auth.uid()
    and attempted_at < now() - interval '8 weeks';

  return v_touched_puzzles;
end;
$$;
