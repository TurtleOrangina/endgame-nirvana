-- Endgame Nirvana app schema: profiles, puzzles, attempts, and the RPCs that
-- keep puzzle Elo server-authoritative while user Elo stays client-authoritative.

-- =============================================================================
-- profiles
-- =============================================================================

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null,
  endgame_elo integer not null,
  puzzles_attempted integer not null default 0,
  puzzles_solved integer not null default 0,
  puzzles_failed integer not null default 0,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles are readable by their owner"
  on public.profiles for select
  to authenticated
  using (auth.uid() = id);

create policy "profiles are updatable by their owner"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Client updates to `profiles` go through PostgREST directly (not an RPC), so
-- `updated_at` must be stamped server-side rather than trusting the client.
create function public.set_profiles_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_profiles_updated_at
  before update on public.profiles
  for each row
  execute function public.set_profiles_updated_at();

-- Creates the profile row on signup, reading the username/starting Elo the
-- client passed as auth signup metadata.
create function public.handle_new_user()
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

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- =============================================================================
-- puzzles
-- =============================================================================

-- id is the normalized FEN itself
create table public.puzzles (
  id text primary key,
  category_path text not null,
  expected_result text not null check (expected_result in ('win', 'draw')),
  initial_elo integer not null,
  current_elo integer not null,
  attempt_count integer not null default 0,
  solve_count integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.puzzles enable row level security;

create policy "puzzles are readable by authenticated users"
  on public.puzzles for select
  to authenticated
  using (true);

-- No insert/update/delete policies: puzzles are only ever written by the
-- security-definer functions below (record_attempts, seed_puzzles).

-- =============================================================================
-- attempts
-- =============================================================================

create table public.attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  client_attempt_id uuid not null,
  puzzle_id text references public.puzzles (id) on delete set null,
  transformed_fen text,
  solved boolean not null,
  user_elo_before integer not null,
  elo_change integer not null,
  new_elo integer not null,
  attempted_at timestamptz not null,
  unique (user_id, client_attempt_id)
);

create index attempts_user_id_attempted_at_idx
  on public.attempts (user_id, attempted_at desc);

alter table public.attempts enable row level security;

create policy "attempts are readable by their owner"
  on public.attempts for select
  to authenticated
  using (auth.uid() = user_id);

-- No insert policy: attempts are only ever written by record_attempts below.

-- =============================================================================
-- RPCs
-- =============================================================================

-- Batched, idempotent write-behind sync of a client's pending attempts.
-- For every attempt that wasn't already recorded (client_attempt_id dedupe),
-- atomically updates the matching puzzle's server-authoritative Elo. Puzzle
-- "wins" (its Elo rises) when the user fails the attempt. Returns the
-- {id, elo} of every puzzle actually touched, so the client can merge it
-- straight into its puzzle-Elo override map.
create function public.record_attempts(p_attempts jsonb)
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
      user_id, client_attempt_id, puzzle_id, transformed_fen,
      solved, user_elo_before, elo_change, new_elo, attempted_at
    )
    values (
      auth.uid(),
      (v_attempt ->> 'client_attempt_id')::uuid,
      v_puzzle_id,
      v_attempt ->> 'transformed_fen',
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

revoke execute on function public.record_attempts(jsonb) from public, anon;
grant execute on function public.record_attempts(jsonb) to authenticated;

-- Single login-hydration call: own profile, own recent attempts, and every
-- puzzle's current Elo (small enough to ship in one response).
create function public.pull_state()
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

  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'elo', current_elo)), '[]'::jsonb)
  into v_puzzles
  from public.puzzles;

  return jsonb_build_object(
    'profile', v_profile,
    'attempts', v_attempts,
    'puzzles', v_puzzles
  );
end;
$$;

revoke execute on function public.pull_state() from public, anon;
grant execute on function public.pull_state() to authenticated;

-- Seeds/refreshes the puzzle pool from the deduped exercises.json. Upserting
-- keeps a puzzle's learned current_elo when it already has attempts, and only
-- resets Elo to the (possibly re-scraped) initial_elo when it doesn't.
create function public.seed_puzzles(p_puzzles jsonb)
returns integer
security definer
set search_path = ''
language plpgsql
as $$
declare
  v_count integer;
begin
  with seed as (
    select
      value ->> 'id' as id,
      value ->> 'category_path' as category_path,
      value ->> 'expected_result' as expected_result,
      (value ->> 'initial_elo')::integer as initial_elo
    from jsonb_array_elements(p_puzzles)
  ),
  upserted as (
    insert into public.puzzles (id, category_path, expected_result, initial_elo, current_elo)
    select id, category_path, expected_result, initial_elo, initial_elo
    from seed
    on conflict (id) do update
    set
      category_path = excluded.category_path,
      expected_result = excluded.expected_result,
      initial_elo = excluded.initial_elo,
      current_elo = case
        when public.puzzles.attempt_count > 0 then public.puzzles.current_elo
        else excluded.initial_elo
      end,
      updated_at = now()
    returning 1
  )
  select count(*) into v_count from upserted;

  return v_count;
end;
$$;

revoke execute on function public.seed_puzzles(jsonb) from public, anon, authenticated;
grant execute on function public.seed_puzzles(jsonb) to service_role;
