# CLAUDE.md — backend

This file provides guidance to Claude Code (claude.ai/code) when working in `backend/`.

## What this is

Self-hosted Supabase running via Docker Compose. Services: PostgreSQL, PostgREST, GoTrue (Auth), Realtime, Storage, Studio (dashboard), Kong (API gateway), Logflare (analytics), Edge Runtime, Supavisor (connection pooler).

## Important: Claude cannot run Docker commands

Claude runs in an isolated container without access to the host Docker daemon. All file changes in `backend/` can be made directly, but **starting, stopping, or restarting services must be done by the user on the host machine**.

When a change requires a service restart, tell the user which command to run. For example:
> "Please run `sh run.sh restart auth` on the host to apply this change."

## Commands (for the user to run on the host)

```sh
sh run.sh start                # docker compose up -d --wait
sh run.sh stop                 # docker compose down
sh run.sh restart [service]    # restart the stack or a named service
sh run.sh logs [service]       # follow logs (all services or one)
sh run.sh secrets              # print API keys and passwords from .env
sh run.sh config               # show active COMPOSE_FILE overlays
sh run.sh config add <name>    # add an overlay (pg17, caddy, nginx, s3, logs, rustfs, envoy)
sh run.sh config remove <name> # remove an overlay
sh run.sh pull                 # pull latest images
```

Initial setup (first time only): `sh setup.sh` — installs Docker, generates secrets, pulls images.  
Full reset: `sh reset.sh`.

## Configuration

All secrets and public URLs live in `.env` (generated from `.env.example` by `setup.sh` — never commit `.env`). Compose overlays in `docker-compose.*.yml` are opt-in: add them to `COMPOSE_FILE` in `.env` via `sh run.sh config add <name>`.

For a full reference of every environment variable across all services, see [`CONFIG.md`](CONFIG.md).

**`JWT_KEYS` and `JWT_JWKS` must both be populated together** (`utils/add-new-auth-keys.sh` generates both). Kong translates the opaque `SUPABASE_PUBLISHABLE_KEY`/`SUPABASE_SECRET_KEY` into the ES256-signed `ANON_KEY_ASYMMETRIC`/`SERVICE_ROLE_KEY_ASYMMETRIC` before forwarding requests to PostgREST/Realtime/Storage (see `volumes/api/kong-entrypoint.sh`'s `LUA_AUTH_EXPR`). If `JWT_JWKS` is left empty, `PGRST_JWT_SECRET` falls back to the legacy HS256 `JWT_SECRET` (`docker-compose.yml`'s `PGRST_JWT_SECRET: '${JWT_JWKS:-${JWT_SECRET}}'`), which can't verify an ES256 token — requests fail with `PGRST301: No suitable key was found to decode the JWT`, even though the opaque key itself is valid.

## Development overlay

Dev mode (mounts local volumes, enables debug flags):
```sh
docker compose -f docker-compose.yml -f dev/docker-compose.dev.yml up -d
```

## App schema

The Endgame Nirvana schema lives in `supabase/migrations/` and is applied with the Supabase CLI against the running Docker stack (the CLI tracks applied migrations in `supabase_migrations.schema_migrations`, so later migrations can be added incrementally — the Docker template's `volumes/db/init/*.sql` scripts only run once, on first init).

**Tables** (`public` schema, RLS enabled on all three):
- `profiles` — one row per `auth.users` row, created by the `handle_new_user` trigger on signup (reads `username`/`start_elo` from signup metadata). Own-row select/update only; `updated_at` is stamped server-side by a trigger since the frontend updates this table directly.
- `puzzles` — one row per puzzle, keyed by its normalized FEN (`id text primary key`, no separate `fen` column). **No client read access at all** (neither `anon` nor `authenticated` — a public, unauthenticated select on the whole pool was an easy DoS vector); the frontend instead ships a static `exercises.json` asset (see `frontend/CLAUDE.md`) refreshed periodically via `scripts/export_puzzles.mjs`. All writes go through `record_attempts`/`seed_puzzles`; the only read path is `pull_state` (below), for authenticated users' own Elo overrides.
- `attempts` — synced completion history, deduped on `(user_id, client_attempt_id)` so replaying a sync batch is a no-op. Own-row select only; all writes go through `record_attempts`.

**RPCs** (`security definer`, `set search_path = ''`, execute revoked from `anon`):
- `record_attempts(p_attempts jsonb) → jsonb` — batched idempotent attempt sync. For each newly-inserted attempt, atomically updates the matching puzzle's Elo (puzzle is server-authoritative; user Elo is client-authoritative and just gets persisted as-is). Trims each user's attempts older than 8 weeks. Returns `{id, elo}` for every puzzle it touched. Granted to `authenticated`.
- `pull_state() → jsonb` — single login-hydration call: own profile, own attempts (last 8 weeks), and `{id, elo}` for only the puzzles referenced in that same recent-attempts window — not the whole pool (this is the only way an authenticated client ever learns puzzle Elo, since there's no direct table read access; a puzzle attempted longer ago falls back to the bundled `exercises.json` difficulty client-side until attempted again). Granted to `authenticated`.
- `seed_puzzles(p_puzzles jsonb) → int` — upserts the puzzle pool; keeps a puzzle's learned `current_elo` if it already has attempts, otherwise resets to the (possibly re-scraped) `initial_elo`. Granted to `service_role` only.
- `export_puzzles() → jsonb` — inverse of `seed_puzzles`: returns every puzzle's `{id, category_path, expected_result, current_elo}`, for `scripts/export_puzzles.mjs` to rebuild `exercises.json` with up-to-date learned difficulties. Granted to `service_role` only.

## Migration workflow, type generation, and seeding

```sh
sh run.sh start                              # start the stack
sh scripts/db.sh push                        # apply pending migrations in supabase/migrations/
sh scripts/db.sh types                       # regenerate ../frontend/src/types/database.ts (committed)
sh scripts/db.sh seed <path-to-exercises.json> # seed public.puzzles from an exercises.json file
sh scripts/db.sh all <path-to-exercises.json>  # push + types + seed
```

`db.sh` sources `.env` and connects through Supavisor's session pooler (`POSTGRES_PORT`, port `5432`) rather than a direct Postgres connection. If the pooler rejects the CLI, fall back to a direct exec: `docker exec -i supabase-db psql -U postgres -d postgres < supabase/migrations/<file>.sql`.

**Production is Supabase Cloud, not this Docker stack** (see the root `CLAUDE.md`'s Deployment section), so `scripts/db.sh push` only ever reaches the local dev stack — it cannot apply migrations to production. Claude cannot run this either way (no network access to Supabase Cloud from its container, and it shouldn't hold production DB credentials). When a schema change needs to reach production, tell the user to run `supabase db push` themselves against the linked cloud project (see `README.md`'s "Supabase CLI login and linking" for one-time setup) — never attempt this over the Docker/local `db.sh` path.

`scripts/seed_puzzles.mjs` is a zero-dependency Node script — it takes a path to an already-deduped `exercises.json` file as its one CLI argument and POSTs its contents to `seed_puzzles` in batches of ~500, authenticating with `SUPABASE_SECRET_KEY` (from `sh run.sh secrets`). It fails loudly if it finds duplicate FENs, since puzzle identity is the FEN itself. This `exercises.json` is produced by a separate puzzle-scraping project, not part of this repo — you just need a copy of the file on disk to seed from.

`scripts/export_puzzles.mjs` is the inverse: it POSTs to `export_puzzles` and writes the result back out in the same `exercises.json` shape, so an operator can periodically pull the current, server-learned puzzle difficulties out of prod and drop the result into `frontend/public/exercises.json` to update the frontend's bundled catalog. **This one must be run against Supabase Cloud, outside the Docker container** (Claude has no network access to prod, and this script has nothing to do with the local dev stack `db.sh` otherwise wraps). It reuses the Supabase CLI's already-linked project and authenticated session — the same state that lets `supabase db push` run with no flags:

```sh
node scripts/export_puzzles.mjs   # defaults to ../frontend/public/exercises.json
```

It deliberately does **not** read `SUPABASE_PUBLIC_URL`/`SUPABASE_SECRET_KEY` — those are `.env`'s names for the local dev stack, and if your shell auto-loads that file (direnv, a dotenv plugin, etc.) they'd silently redirect this script at the wrong database instead of prod. Set `SUPABASE_PROJECT_REF` to target a project explicitly if `supabase link`'s `.temp/project-ref` isn't present. The script logs the resolved URL it's about to hit before exporting — check that it says `https://<prod-ref>.supabase.co`, not a local one, if anything looks off.

Puzzle data (fen, category, expected result, elo) has no direct client read path at all anymore — see the `puzzles` table entry above and `frontend/CLAUDE.md`'s note on the static `exercises.json` asset.

`frontend/src/types/database.ts` is generated output, committed so the frontend builds without a running DB — always regenerate it with `db.sh types` after changing the schema, never hand-edit it.

## Required `.env` changes for auth

- `SITE_URL` → the frontend's origin (e.g. `http://localhost:5173` in dev).
- `ADDITIONAL_REDIRECT_URLS` → any extra dev/preview origins that need to receive Supabase auth redirects.
- `ENABLE_EMAIL_AUTOCONFIRM=true` — there's no SMTP configured yet, so signups must auto-confirm. Flip back to `false` once `SMTP_*` is set and the frontend's password-recovery flow is unhidden.
- `SMTP_*` — leave as placeholders until an SMTP provider is wired up; the "forgot password" UI stays hidden until then.

Restart the `auth` service after editing any of these: `sh run.sh restart auth`.
