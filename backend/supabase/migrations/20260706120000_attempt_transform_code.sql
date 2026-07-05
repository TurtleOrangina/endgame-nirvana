-- Replaces the full duplicated transformed FEN on attempts with a short code
-- describing which transformations were applied (e.g. "XYC") — the puzzle's
-- original FEN (puzzle_id) plus this code fully reconstructs the position the
-- user actually played.

alter table public.attempts drop column transformed_fen;
alter table public.attempts add column transform_code text;

create or replace function public.record_attempts(p_attempts jsonb)
returns jsonb
security definer
set search_path = ''
language plpgsql
as $$
declare
  v_attempt jsonb;
  v_inserted_id bigint;
  v_puzzle_id text;
  v_current_elo integer;
  v_attempt_count integer;
  v_k numeric;
  v_expected numeric;
  v_actual numeric;
  v_delta integer;
  v_new_puzzle_elo integer;
  v_touched_puzzles jsonb := '[]'::jsonb;
begin
  for v_attempt in select * from jsonb_array_elements(p_attempts)
  loop
    v_puzzle_id := v_attempt ->> 'puzzle_id';

    insert into public.attempts (
      user_id, client_attempt_id, puzzle_id, transform_code,
      solved, user_elo_before, elo_change, new_elo, attempted_at
    )
    values (
      auth.uid(),
      (v_attempt ->> 'client_attempt_id')::uuid,
      v_puzzle_id,
      v_attempt ->> 'transform_code',
      (v_attempt ->> 'solved')::boolean,
      (v_attempt ->> 'user_elo_before')::integer,
      (v_attempt ->> 'elo_change')::integer,
      (v_attempt ->> 'new_elo')::integer,
      (v_attempt ->> 'attempted_at')::timestamptz
    )
    on conflict (user_id, client_attempt_id) do nothing
    returning id into v_inserted_id;

    -- Only newly-inserted attempts affect puzzle Elo, so replaying the same
    -- attempt twice (e.g. a retried sync) never double-counts it.
    if v_inserted_id is not null and v_puzzle_id is not null then
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
  end loop;

  -- Trim: this user's sync history only needs to cover the recent-attempt
  -- exclusion window the frontend uses to avoid repeating puzzles.
  delete from public.attempts
  where user_id = auth.uid()
    and attempted_at < now() - interval '8 weeks';

  return v_touched_puzzles;
end;
$$;
