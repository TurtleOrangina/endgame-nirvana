-- Deletes every puzzle whose id is not in the given keep-list, so a full re-seed
-- can make the server-side pool exactly match the seed file. Called by
-- scripts/seed_puzzles.mjs after all seed batches (unless --only-add is passed) —
-- it cannot live inside seed_puzzles itself because seeding is batched and each
-- batch only sees its own slice of the pool.
--
-- Deleting a puzzle keeps its attempt history: attempts.puzzle_id is
-- `on delete set null`.

create function public.prune_puzzles(p_keep_ids jsonb)
returns integer
security definer
set search_path = ''
language plpgsql
as $$
declare
  v_count integer;
begin
  if p_keep_ids is null or jsonb_typeof(p_keep_ids) <> 'array' or jsonb_array_length(p_keep_ids) = 0 then
    raise exception 'prune_puzzles requires a non-empty array of puzzle ids to keep';
  end if;

  with deleted as (
    delete from public.puzzles
    where id not in (select jsonb_array_elements_text(p_keep_ids))
    returning 1
  )
  select count(*) into v_count from deleted;

  return v_count;
end;
$$;

revoke execute on function public.prune_puzzles(jsonb) from public, anon, authenticated;
grant execute on function public.prune_puzzles(jsonb) to service_role;
