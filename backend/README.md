# backend

Self-hosted Supabase (Docker Compose) for **endgame-nirvana**. See [`CLAUDE.md`](CLAUDE.md) for the schema/RPC reference; this file is the operational how-to.

Claude cannot run any of the commands below — Docker isn't available inside its container. Run these yourself on the host!

## Install

- Docker Engine + Compose plugin.
- [Supabase CLI](https://supabase.com/docs/guides/cli) — needed for migrations, type generation, and seeding (`scripts/db.sh`).

## First-time setup

Run `sh setup.sh` — it installs Docker (if missing), copies `.env.example` to `.env`, and generates secrets via `utils/generate-keys.sh` and `utils/add-new-auth-keys.sh` (both `JWT_KEYS` **and** `JWT_JWKS` must come out of that step non-empty — see `CLAUDE.md`'s Configuration section for why).

1. **Start the stack:**
   ```sh
   sh run.sh start
   ```
   This runs `docker compose up -d --wait` and blocks until every service reports healthy.

2. **Apply the app schema, generate frontend types, and seed puzzles:**
   ```sh
   sh scripts/db.sh all
   ```
   Requires the [Supabase CLI](https://supabase.com/docs/guides/cli). This applies `supabase/migrations/`, regenerates `../frontend/src/types/database.ts`, and seeds `public.puzzles` from an `exercises.json` file you supply (`sh scripts/db.sh all path/to/exercises.json`). See [Migrations](#migrations) below to run these steps individually.

3. **Get the API keys the frontend needs:**
   ```sh
   sh run.sh secrets
   ```
   Copy `frontend/.env.example` to `frontend/.env.local` and fill in:
   - `VITE_SUPABASE_URL` ← this backend's `.env` `SUPABASE_PUBLIC_URL` (`http://localhost:8000` by default)
   - `VITE_SUPABASE_ANON_KEY` ← `SUPABASE_PUBLISHABLE_KEY` from the `secrets` output above

4. **Check it's up:**
   - Studio (dashboard): http://localhost:8000 — login with `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` from `.env`
   - API gateway: http://localhost:8000

## Starting and stopping

```sh
sh run.sh start                # docker compose up -d --wait
sh run.sh stop                 # docker compose down
sh run.sh restart [service]    # restart the stack, or one named service
sh run.sh status                # docker compose ps
sh run.sh logs [service]       # follow logs (all services, or one)
```

Full teardown, including deleting the Postgres data volume (asks for confirmation):
```sh
sh reset.sh
```

## Migrations

Migrations live in `supabase/migrations/` and are applied with the Supabase CLI against the running stack:

```sh
sh scripts/db.sh push                        # apply pending migrations
sh scripts/db.sh types                        # regenerate ../frontend/src/types/database.ts (commit the result)
sh scripts/db.sh seed <path-to-exercises.json> # seed public.puzzles from an exercises.json file
sh scripts/db.sh all <path-to-exercises.json>  # push + types + seed
```

To add a new migration, create a timestamped `.sql` file in `supabase/migrations/` (following the existing `20260702120000_app_schema.sql`), then run `sh scripts/db.sh push`. Always run `db.sh types` after a schema change — `frontend/src/types/database.ts` is committed and must stay in sync; never hand-edit it.

If the connection pooler rejects the CLI, connect directly instead:
```sh
docker exec -i supabase-db psql -U postgres -d postgres < supabase/migrations/<file>.sql
```

## Applying migrations to production (Supabase Cloud)

Production runs on Supabase Cloud, not this Docker stack (see the root `CLAUDE.md`'s Deployment section) — `scripts/db.sh push` only ever targets the local stack via `.env`'s pooler connection, so it cannot reach production. Claude also can't do this step; it has no network access to Supabase Cloud and shouldn't hold production DB credentials, so ask it to write the migration file and then run these yourself.

**One-time CLI login and linking:**
```sh
supabase login                                    # opens a browser to authenticate the CLI
supabase link --project-ref <your-project-ref>    # project ref is in the dashboard URL, or Settings > General
```
`link` will prompt for the database password (Settings → Database in the dashboard).

**Applying pending migrations:**
```sh
supabase migration list   # optional: see what's already applied remotely vs. locally
supabase db push          # applies any supabase/migrations/*.sql not yet recorded remotely
```

Run `db push` from `backend/` (or anywhere inside the linked project) after adding a new migration file. It only applies the ones not already tracked in the project's `supabase_migrations.schema_migrations` table.

## Regenerating frontend client types

```sh
sh scripts/db.sh types
```

Requires a running stack. Writes `../frontend/src/types/database.ts` from the live schema — run this any time you change `supabase/migrations/`.

## Config reference

- `.env` holds all secrets and URLs (generated from `.env.example`, never committed).
- `CONFIG.md` documents every environment variable.
- Optional service overlays (pg17, caddy, nginx, s3, logs, rustfs, envoy) are toggled with `sh run.sh config add <name>` / `config remove <name>`, and listed with `sh run.sh config`.
- Dev overlay (mounts local volumes, debug flags): `docker compose -f docker-compose.yml -f dev/docker-compose.dev.yml up -d`

See [`CLAUDE.md`](CLAUDE.md) for the app schema, RPCs, and the required `.env` auth settings (`SITE_URL`, `ENABLE_EMAIL_AUTOCONFIRM`, `SMTP_*`).
