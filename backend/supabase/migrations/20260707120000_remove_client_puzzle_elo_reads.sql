-- The frontend no longer consumes server-side puzzle Elo at all: puzzle
-- difficulty comes solely from the bundled exercises.json, which is refreshed
-- by periodically running scripts/export_puzzles.mjs against prod. Puzzle Elo
-- stays server-authoritative (record_attempts keeps updating it) — the server
-- just stops handing it back to clients.
--
--   * pull_state drops the 'puzzles' key and returns only profile + attempts.
--   * record_attempts stops returning the touched-puzzle {id, elo} list (the
--     frontend was its only consumer) and returns nothing.

create or replace function public.pull_state()
returns jsonb
security definer
set search_path = ''
language plpgsql
as $$
declare
  v_profile jsonb;
  v_attempts jsonb;
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

  return jsonb_build_object(
    'profile', v_profile,
    'attempts', v_attempts
  );
end;
$$;

-- Return type changes from jsonb to void, which create or replace can't do.
drop function public.record_attempts(jsonb);

create function public.record_attempts(p_attempts jsonb)
returns void
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
          where id = v_puzzle_id;
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
end;
$$;

revoke execute on function public.record_attempts(jsonb) from public, anon;
grant execute on function public.record_attempts(jsonb) to authenticated;
