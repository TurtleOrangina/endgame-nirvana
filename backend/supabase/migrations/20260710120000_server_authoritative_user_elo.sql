-- User Elo becomes server-authoritative, mirroring puzzle Elo: record_attempts
-- now computes profiles.endgame_elo itself from its own running total (built up
-- across the batch in whatever order it arrives — no attempt at reconstructing
-- "true" cross-device temporal order) instead of trusting whatever the client
-- last pushed. This closes a real bug: a device that never got to flush a
-- solve (e.g. closed right after solving) would push its stale cached elo on
-- next launch, silently clobbering more recent progress made on another
-- device. The attempts table was never affected by that bug (still deduped by
-- client_attempt_id), only the profiles.endgame_elo column was.
--
-- Also stops counting a second solve of the same puzzle within the 8-week
-- attempts history at all (most commonly two devices independently solving it
-- before either has synced), rather than double-applying both.

revoke update (endgame_elo) on public.profiles from authenticated;

-- Return type changes from void to jsonb, which create or replace can't do.
drop function public.record_attempts(jsonb);

create function public.record_attempts(p_attempts jsonb)
returns jsonb
security definer
set search_path = ''
language plpgsql
as $$
declare
  v_attempt jsonb;
  v_inserted boolean;
  v_is_duplicate boolean;
  v_puzzle_id text;
  v_puzzle_found boolean;
  v_attempted_at timestamptz;
  v_current_puzzle_elo integer;
  v_puzzle_attempt_count integer;
  v_user_elo integer;
  v_user_attempt_count integer;
  v_k numeric;
  v_expected numeric;
  v_actual numeric;
  v_puzzle_delta integer;
  v_user_delta integer;
  v_newly_solved integer := 0;
  v_newly_failed integer := 0;
begin
  select endgame_elo, puzzles_solved + puzzles_failed
  into v_user_elo, v_user_attempt_count
  from public.profiles
  where id = auth.uid()
  for update;

  for v_attempt in select * from jsonb_array_elements(p_attempts)
  loop
    v_puzzle_id := v_attempt ->> 'puzzle_id';
    v_attempted_at := (v_attempt ->> 'attempted_at')::timestamptz;

    -- We don't count "double solving" of the same puzzle within the 8-week
    -- history window at all — most commonly two devices independently
    -- solving it before either has synced (e.g. one was offline for hours).
    -- attempts only ever holds 8 weeks of rows anyway (see the trailing
    -- delete below), so an unqualified existence check per (user, puzzle) is
    -- already scoped to that window with no timestamp comparison needed.
    select exists (
      select 1
      from public.attempts
      where user_id = auth.uid()
        and puzzle_id = v_puzzle_id
    ) into v_is_duplicate;

    if v_is_duplicate then
      continue;
    end if;

    v_puzzle_delta := 0;
    v_user_delta := 0;
    v_puzzle_found := false;
    v_current_puzzle_elo := null;

    if v_puzzle_id is not null then
      select current_elo, attempt_count into v_current_puzzle_elo, v_puzzle_attempt_count
      from public.puzzles
      where id = v_puzzle_id
      for update;

      v_puzzle_found := found;
      if v_puzzle_found then
        v_actual := case when (v_attempt ->> 'solved')::boolean then 0 else 1 end;
        v_k := greatest(16, 64 - v_puzzle_attempt_count * 0.5);
        v_expected := 1 / (1 + power(10, ((v_user_elo - v_current_puzzle_elo)::numeric / 400)));
        -- floor(x + 0.5) matches JS Math.round for negative halves.
        v_puzzle_delta := floor(v_k * (v_actual - v_expected) + 0.5);

        v_actual := case when (v_attempt ->> 'solved')::boolean then 1 else 0 end;
        v_k := greatest(16, 64 - v_user_attempt_count * 0.5);
        v_expected := 1 / (1 + power(10, ((v_current_puzzle_elo - v_user_elo)::numeric / 400)));
        v_user_delta := floor(v_k * (v_actual - v_expected) + 0.5);
      end if;
    end if;

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
      v_user_delta,
      v_user_elo + v_user_delta,
      v_attempted_at
    )
    on conflict (user_id, client_attempt_id) do nothing
    returning true into v_inserted;

    -- Only newly-inserted attempts are counted and affect puzzle/user Elo, so
    -- replaying the same attempt twice (e.g. a retried sync) never
    -- double-counts it.
    if v_inserted then
      if (v_attempt ->> 'solved')::boolean then
        v_newly_solved := v_newly_solved + 1;
      else
        v_newly_failed := v_newly_failed + 1;
      end if;

      v_user_elo := v_user_elo + v_user_delta;
      v_user_attempt_count := v_user_attempt_count + 1;

      if v_puzzle_found then
        update public.puzzles
        set
          current_elo = current_elo + v_puzzle_delta,
          attempt_count = attempt_count + 1,
          solve_count = solve_count + case when (v_attempt ->> 'solved')::boolean then 1 else 0 end,
          updated_at = now()
        where id = v_puzzle_id;
      end if;
    end if;
  end loop;

  update public.profiles
  set
    endgame_elo = v_user_elo,
    puzzles_solved = puzzles_solved + v_newly_solved,
    puzzles_failed = puzzles_failed + v_newly_failed
  where id = auth.uid();

  -- Trim: this user's sync history only needs to cover the recent-attempt
  -- exclusion window the frontend uses to avoid repeating puzzles.
  delete from public.attempts
  where user_id = auth.uid()
    and attempted_at < now() - interval '8 weeks';

  return jsonb_build_object('endgame_elo', v_user_elo);
end;
$$;

revoke execute on function public.record_attempts(jsonb) from public, anon;
grant execute on function public.record_attempts(jsonb) to authenticated;
