# frontend

Vue 3 + TypeScript SPA for **endgame-nirvana**, a chess endgame trainer. See
[`CLAUDE.md`](CLAUDE.md) for architecture and key files; this file is the operational how-to.

The app works fully offline (localStorage-backed); a backend is only needed for account sync
and to download the puzzle catalog remotely instead of pointing at a local copy.

## Install

- Node (see [`.node-version`](.node-version) for the exact version; `^20.19`, `^22.18`, or
  `>=24.11` per `package.json`'s `engines` field).
- This project uses **[Vite+](https://viteplus.dev)** (`vp`), not plain Vite/pnpm/npm directly.
  Install it globally: `npm install -g vite-plus`.

```sh
CI=true vp install   # install dependencies (CI=true needed — no TTY)
```

## Environment

Copy the example env file and fill it in:

```sh
cp .env.example .env.local
```

- `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — only needed for backend sync (account
  login, cross-device progress, downloading the puzzle catalog remotely). Get these from the
  backend: see [`../backend/README.md`](../backend/README.md#first-time-setup) (`sh run.sh
secrets` for the local dev stack, or your Supabase Cloud project settings for prod).
- Leave both unset for a no-backend, local-only build — the app still works, just without
  sync or a remote puzzle catalog.

## Running

```sh
vp dev        # start the dev server
vp build      # type-check + production build (outputs to dist/)
vp preview    # preview a production build locally
```

There's no separate "stop" command — `Ctrl+C` the dev server process.

## Checks

```sh
vp check --fix   # format + lint + type-check, auto-fixing where possible
vp test          # run tests
```

Run `vp check --fix` after every change and resolve all errors before committing.
