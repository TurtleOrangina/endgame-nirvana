# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Environment

Claude runs inside an isolated Docker container. Only the project root is mounted — there is no access to the host machine, host Docker daemon, or any running services. This means:

- Docker commands cannot be executed (the Docker socket is not available).
- The backend (Supabase) cannot be started or managed from within this container.
- When a task requires running or restarting backend services, ask the user to run the relevant command on the host machine.

The user is managing git, please don't try alter the git state in any way. You may view, but not alter.

## Project overview

Chess endgame training app called **endgame-nirvana**. Two independent components — read the relevant sub-file before working in that area:

- `backend/` — Self-hosted Supabase stack (Docker Compose) → [`backend/CLAUDE.md`](backend/CLAUDE.md)
- `frontend/` — Vue 3 SPA (Vite+ / TypeScript / Pinia) → [`frontend/CLAUDE.md`](frontend/CLAUDE.md)

Puzzle data (`exercises.json`) is produced by a separate scraping project, not part of this repo. The frontend bundles it as a static asset (`frontend/public/exercises.json`, not committed) rather than downloading it from the backend at runtime — see `frontend/src/stores/exercises.ts`. `backend/scripts/seed_puzzles.mjs` takes a path to an `exercises.json` file to seed a fresh database, and `backend/scripts/export_puzzles.mjs` does the inverse (pulls the current, server-learned puzzle pool out of prod) so `exercises.json` can periodically be refreshed with up-to-date difficulties.

## Deployment

- **Backend**: Supabase Cloud (Free tier) — not the self-hosted Docker stack described
  in `backend/CLAUDE.md`, which is for local dev only. Free-tier caveats to keep in mind
  when designing features: **500 MB max database size** (be careful with per-user data
  growth if usage picks up) and **5 GB egress/month** (another potential limiter at
  scale — one reason the puzzle catalog ships as a static frontend asset instead of
  being served from the backend).
- **Email**: Resend (Free tier), wired up as Supabase's SMTP provider for confirmation
  and password-reset emails. Main caveat: **100 emails/day** — fine at current usage,
  but reachable with many signups or someone intentionally spamming reset requests.
- **Frontend**: Cloudflare Pages (Free tier — no caveats in sight that would force an
  upgrade; see `frontend/wrangler.jsonc`), deployed under
  the custom domain `endgame-nirvana.space`. The app uses hand-rolled client-side
  routing with real paths (e.g. `/profile`, `/training/<fen>`) rather than hash routing,
  so the Cloudflare `assets` config must keep
  `not_found_handling: "single-page-application"` so unmatched paths fall back to
  `index.html` instead of 404ing.

## Code quality principles

These apply across all three components:

- **DRY**: extract shared logic rather than duplicating it. If the same logic appears twice, it belongs in a shared function or module.
- **Descriptive names**: function and variable names should read like plain English and make the intent obvious without a comment. Avoid abbreviations unless they are universally understood (e.g. `url`, `id`).
- **Use the type system fully**: avoid `any` / untyped fallbacks. Types are the first line of defence against bugs — lean on them, not on runtime checks.
- **Lint and type-check before committing**: each component has its own toolchain; see the sub-file for the exact commands. Code that fails linting or type checking is not ready to commit.
- **Minimal comments**: a well-named function needs no comment explaining what it does. Only add a comment when the *why* is non-obvious.
