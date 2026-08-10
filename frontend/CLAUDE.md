# CLAUDE.md — frontend

This file provides guidance to Claude Code (claude.ai/code) when working in `frontend/`.

## Goal

Endgame Nirvana is a chess endgame trainer. The user is presented with endgame
positions and plays them out against a built-in engine, with the goal of reaching
the position's expected result (win or draw). Positions are grouped by category;
the app tracks the user's progress and adjusts an endgame Elo rating as puzzles
are solved or failed. An analysis mode lets the user explore lines with engine
and tablebase feedback.

## Backend

**localStorage is still the on-device source of truth — the app must fully work
offline.** A self-hosted Supabase backend (`../backend/`, see `backend/CLAUDE.md`)
now exists for cross-device sync, but every backend call is
best-effort: it fails silently and leaves state queued for the next attempt,
never blocking the UI. `src/lib/supabaseClient.ts` exports `null` when
`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` aren't set (see `.env.example`),
so a no-backend build keeps working exactly as before.

- `src/stores/auth.ts` — Supabase Auth session state, sign up/in/out, **Google OAuth sign-in**, pending-registration
  retry (email/username/startElo only — never the password), and the `PASSWORD_RECOVERY`
  event. `authStore.init()` is deliberately _not_ awaited by `App.vue`'s `onMounted` —
  with an expired access token it refreshes over the network inside `getSession()`,
  which can hang on a bad connection, and the offline-capable stores must never wait
  behind it. The cloud pull it triggers merges into the stores whenever it lands; the
  password-recovery token is read from the URL synchronously before `init()`'s first
  await, since routing rewrites the URL without waiting for it.
- **Google sign-in** (`signInWithGoogle`) redirects the whole page away and back to the app's
  origin, where supabase-js exchanges the `?code=`. Two consequences worth knowing:
  - The **Lichess link flow uses `?code=` on the same origin**. They're told apart by
    `useLichessAuth.hasPendingLinkFlow()` (its PKCE verifier in `sessionStorage`) — without
    that guard, `handleRedirectCallback` strips the query string and destroys Google's code.
  - Google passes **no signup metadata**, so `handle_new_user` creates the profile row with a
    null username (see `backend/CLAUDE.md`). `pullRemoteState` therefore _claims_ such a row
    instead of applying it: an existing local profile is adopted via `initialize_oauth_profile`
    (so upgrading a local-only user to a cloud account keeps their nickname and Elo), and a
    first-time user sets `oauthOnboardingRequired`, which sends `SetupModal` to its `basics`
    step. Applying a null-username row through the normal "cloud wins" merge would blank out
    a real local profile.
- **Sign-out is `scope: 'local'`** (`auth.ts`'s `signOut`/`deleteAccount`). supabase-js
  defaults to `'global'`, which revokes the user's refresh tokens on _every_ device — the
  others then silently fall back to local-only training (nothing pulls, the outbox just
  grows) while still showing their last local Elo, which looks like the backend having gone
  quiet rather than a sign-out. A session lost anyway (revoked elsewhere, password change)
  is detected via the `lastSignedInEmail` localStorage key, which records that this device
  was signed in and is cleared only by a deliberate sign-out/reset: `authStore.sessionExpired`
  is "no session but this device had one", and `SettingsPage` says so instead of claiming the
  user never made an account. Recovery is just signing in again — the `SIGNED_IN` pull flushes
  whatever queued up while the device was signed out, then applies the cloud profile.
- `SettingsPage`'s account section has **create-account/sign-in mode tabs** mirroring
  `SetupModal`'s. Sign-in has to be reachable from both: the wizard only opens when there is
  no local profile at all, so a device that has a profile but lost its session would otherwise
  have no way in except a password-reset email.
- `src/stores/sync.ts` — the write-behind outbox: batches `PendingAttempt[]` and a
  `profileDirty` flag into at most two requests (one `record_attempts` RPC, one `profiles`
  update) per 2s debounce window, flushing also on reconnect, tab-hide, and login.
- **Both user Elo and puzzle Elo are server-authoritative**, computed inside the
  `record_attempts` RPC from its own running totals (not reordered by client-reported
  timestamps across devices) — the client only ever sends `{puzzle_id, transform_code,
solved, attempted_at}` per attempt (`PendingAttempt`) and computes its own optimistic
  local `endgameElo` delta (`userProfile.ts: recordResult`) purely for instant UI
  feedback, which `applyServerElo()` overwrites once the RPC's response lands. Puzzle
  difficulty is never read back by the client either way — it always comes from the
  bundled `exercises.json`, which is what the periodic `export_puzzles.mjs` refresh is
  for. `record_attempts` also skips a second attempt at the same puzzle anywhere in
  the current 8-week attempts history (e.g. two devices solving it before either has
  synced) — no insert, no Elo effect — instead of double-counting it.
- **Merge policy on login**: cloud profile wins for Elo/settings; any attempts queued
  locally before login are replayed to the server afterward. No conflict prompt — this
  was a flagged-for-review default, not a hard requirement.
- Puzzle identity is the **normalized FEN** (see `src/utils/exerciseId.ts`) — not a
  category path, so exercise ids survive the puzzle being moved between categories
  in a future re-scrape. **URLs (`/train?puzzle=…`, and therefore shared links) carry the
  _transformed_ fen** currently on the board instead, so both people looking at a shared
  link see the same orientation and colours and can talk about the same moves. The puzzle
  behind such a fen is recovered by undoing each candidate transformation until one hits a
  known id (`exercises.ts`'s `resolveTransformedFen`), so attempts are still reported under
  the original fen and no transformed-fen lookup table is needed.
- The puzzle catalog itself (`src/stores/exercises.ts`) is a **static frontend asset**
  (`public/exercises.json`, committed to the repo), not downloaded from the
  backend: the `public.puzzles` table has no client read access at all (see
  `backend/CLAUDE.md`), since an unauthenticated, unrestricted select on the whole
  puzzle pool was an easy DoS vector. `exercises.json` is refreshed periodically by
  running `backend/scripts/export_puzzles.mjs` against prod and copying the result into
  `public/exercises.json`. `vite.config.ts`'s `exercisesCatalogPlugin` serves it under a
  content-hashed filename (`/data/exercises-<hash>.json`) behind a tiny, always-revalidated
  manifest (`/exercises-manifest.json`) — see `public/_headers` for the corresponding
  Cache-Control split (immutable for the hashed file, `no-cache` for the manifest). This
  means an update to `exercises.json` reaches clients on their next load without needing
  a cache-busting query param, while the (large, rarely-changing) catalog itself can be
  cached by the browser indefinitely. The parsed result is also cached in `localStorage`
  so the app renders instantly and works fully offline; every load still fetches the
  manifest in the background to pick up a newer export, without blocking rendering of the
  cached data.
- `src/types/database.ts` is generated by `backend/scripts/db.sh types` and committed;
  never hand-edit it (regenerate after any schema change in `backend/supabase/migrations/`).

## Technology

- **Vue 3** (`<script setup>` + Composition API) with **TypeScript**.
- **Vite+** (`vp`) for dev/build/lint/format — see Toolchain below.
- **Pinia** for state management (`src/stores/`).
- **chess.js** for move generation, legality, and game-state logic.
- **@lichess-org/chessground** for the interactive board UI.
- **stockfish** (WASM, served from `public/engines/`) runs in a Web Worker as
  the opponent and analysis engine.
- **Web Audio API** for sound: board move sounds play CC0 samples from
  `src/assets/sounds/` (see `ATTRIBUTION.md` there); success/failure result
  sounds are still procedurally generated.
- **canvas-confetti** for solve celebrations.

## File layout

- `src/pages/` — one component per entry in the header's navigation menu (plus the
  legal pages): `TrainingPage`, `SolveProgressPage`, `BrowseExercisesPage`,
  `SettingsPage`, `AboutPage`, `LegalPage`. A page is only ever rendered by `App.vue`.
- `src/components/` — everything reusable or embedded: the board, the analysis panel,
  the header, modals, and small shared widgets.

## Key files

- `src/App.vue` — root component; owns app-level routing (which page is shown, browser
  back/forward, the Lichess OAuth return), theme/language/engine-thread preferences,
  auth + sync startup, the header and the app-level modals. It holds no training state:
  it drives `TrainingPage` through the small API that component exposes
  (`loadCatalog`, `restoreSession`, `applyRoute`, `loadPuzzle`, `navigateHere`,
  `headerTitle`, `headerVersusPieces`).
- `src/pages/TrainingPage.vue` — the training/analysis view and everything behind it:
  board, sidebar, puzzle status, analysis mode, category filter, the pagehide session
  snapshot (`src/utils/trainingSessionState.ts`), and the `/train` ↔ `/analysis` URL
  writes. Stays mounted (hidden via `v-show` on its `active` prop) while another page is
  shown, so a puzzle in progress survives navigating away and back.
- `src/components/ChessBoard.vue` — the heart of the app. Owns the Chessground
  board and a chess.js instance; handles player moves, promotions, premoves,
  move history / takeback, engine replies, tablebase-driven opponent moves, and
  analysis mode. Decides win/draw/loss outcomes and whether an exercise was failed.
- `src/components/AnalysisPanel.vue` — shows engine lines and tablebase results,
  analysis settings, and lets the user replay/execute moves.
- `src/components/SetupModal.vue` — first-run profile creation (username + starting Elo),
  with a mode toggle for creating/signing into a Supabase account (only shown when a
  backend is configured) alongside the default local-only flow.
- `src/components/GoogleSignInButton.vue` — the shared "Continue with Google" button (used by
  `SetupModal` and `SettingsPage`). The Google mark is an inline SVG, never a Google-hosted
  image: the app must work offline, and a remote logo would ping Google on every render.
- `src/components/PasswordRecoveryModal.vue` — shown on the `PASSWORD_RECOVERY` auth event.
- `src/pages/SolveProgressPage.vue` — Elo stats, category progress, and a replayable
  history of recent attempts.
- `src/pages/BrowseExercisesPage.vue` — searchable/filterable catalog of every puzzle.
- `src/pages/SettingsPage.vue` — difficulty preference, theme/language, engine threads,
  Lichess account linking, Endgame Nirvana account, and the account deletion entry point.
- `src/components/DeleteAccountModal.vue` — confirmation modal for permanent account deletion
  (backed by the `delete_own_account` RPC, see `backend/CLAUDE.md`).
- `src/pages/LegalPage.vue` — static Impressum/Datenschutz content for the deployed site
  (`/impressum`, `/datenschutz`); real contact details, not a placeholder — see `useAppRouter.ts`.
- `src/composables/useAppRouter.ts` — the hand-rolled client-side routing referenced in the
  root `CLAUDE.md`'s Deployment section (real paths, not hash routing).
- `src/composables/useLocale.ts` — the `t()` translation composable (shared
  `currentLocale` singleton); locale strings live in `src/locales/` — see
  Localization below.
- `src/composables/useStockfishEngine.ts` — wraps the Stockfish WASM worker;
  exposes `getBestMove` and multi-line `getAnalysis`. Single shared instance.
- `src/composables/useLichessTablebase.ts` — queries the Lichess online tablebase,
  ranks/sorts moves, and selects the opponent's move (deterministic fastest win,
  weighted-random defense). Exports `CATEGORY_RANK` / `CATEGORY_FLIP`.
- `src/composables/useLichessAuth.ts` — Lichess OAuth (PKCE) link flow; gates
  tablebase use behind a linked account.
- `src/composables/useBoardAudio.ts` — sampled board sounds
  (move/capture/castle/check/promote/checkmate); `useResultAudio.ts`,
  `audioContext.ts` — synthesized result sounds and the shared AudioContext.
- `src/stores/exercises.ts` — downloads/caches the puzzle catalog from the backend,
  derives categories, tracks the current exercise and completion.
- `src/stores/userProfile.ts` — user profile, session stats, and Elo, persisted
  to `localStorage`; `applyRemoteProfile()` merges a pulled cloud profile (cloud wins).
- `src/stores/auth.ts` / `src/stores/sync.ts` — see Backend below.
- `src/lib/supabaseClient.ts` — the shared Supabase client, `null` when unconfigured.
- `src/utils/chess.ts` — SAN/figurine and UCI-line formatting helpers.
- `src/utils/exerciseId.ts` — normalized-FEN exercise ids + the legacy `path::fen` migration.
- `src/utils/boardAppearance.ts` — the board-theme and piece-set catalog (14 boards,
  12 piece sets, a hand-picked selection adopted from lichess and ordered best-first — see
  `public/board/ATTRIBUTION.md` and `public/piece/ATTRIBUTION.md`, and note two of
  lichess's featured piece sets are deliberately excluded as non-redistributable).
  Assets live at fixed paths under `public/board/` and `public/piece/<set>/`, so a
  single static stylesheet (`src/assets/board-appearance.css`) covers all of them: it
  only reads CSS variables, which `applyBoardTheme`/`applyPieceSet` point at the
  selected files. No per-theme CSS is generated and the browser downloads only what
  the variables currently reference; `preloadAssets.ts` fetches the active set first
  and then, on idle, everything else, so all options stay selectable offline.
- `src/types.ts` — shared domain types (results, engine, tablebase, profile).
- `src/types/database.ts` — generated Supabase schema types (see Backend below).
- `src/main.ts` — entry point; mounts the app and imports Chessground/board CSS.
- `src/registerServiceWorker.ts` — registers `public/sw.js`, which makes the app
  installable as a PWA (`public/manifest.webmanifest`) and serves cached assets
  stale-while-revalidate so the app keeps working offline.

## Localization (i18n)

The app is bilingual (English/German) via a hand-rolled composable — **no vue-i18n**.

- **Every user-visible string must go through `t()`** from `src/composables/useLocale.ts`:
  `t((s) => s.profile.mode.title)` or `t((s) => s.app.solvedCount, { count })` with
  `{name}` interpolation tokens. This includes attribute-bound text (`title=`,
  `placeholder=`, `aria-label=`) and script-side strings (error messages, computed
  labels — use a `computed` so they re-render on locale change). Never hardcode
  English copy in a component.
- **Locale files**: `src/locales/en.ts` (source of truth) and `src/locales/de.ts`.
  When adding a string, add it to **both** files in the same change. `de` is typed
  `typeof en`, so a missing/extra key is a type error. Deliberately no `as const`
  on `en` — that would make `typeof en` demand the literal English strings in `de.ts`.
- Key naming: `<component-or-feature>.<subsection>.<element>`, lowerCamelCase segments;
  shared strings (generic buttons, form labels) live under `common.*`.
- German translations are written directly, natural and idiomatic, with correct chess
  terminology (Matt, Remis, Patt, Zugzwang, …) — never left as English placeholders.
- The language preference lives on `UserProfile.language` (persisted + synced like
  `themeMode`); browser detection (`src/utils/detectLocale.ts`) is only the first-run
  default. `App.vue` watches `profile.language` and calls `setLocale`.
- **Exception**: `src/pages/LegalPage.vue` (Impressum/Datenschutz) is intentionally
  hardcoded German-only — legal content required under Austrian law, not UI copy. Do
  not wire it to `t()`.

## Toolchain

`vp` is the Vite+ CLI — a unified wrapper around Vite, Rolldown, Vitest, Oxlint, and Oxfmt. It is **not** plain Vite. Run `vp help` for the full command list; docs are at `node_modules/vite-plus/docs`.

## Commands

Do NOT use pnpm/yarn/npm. Use vp instead to install dependencies, format files, run linter, run typer checker.

`vp install` requires `CI=true` because there is no TTY.

```sh
CI=true vp install              # install / sync dependencies
vp test --run                   # tests — must be the project-local vp, see the note below
CI=true vp install <pkg>        # add a new dependency (acts as vp add)
CI=true vp install -D <pkg>     # add a dev dependency
vp check --fix                  # format + lint + type-check, auto-fix where possible
vp run type-check               # vue-tsc: also type-checks .vue templates (vp check does not!)
```

**Tests only run under the project-local `vp`.** The container also has a global vite-plus
(`npm install -g vite-plus` in the Dockerfile, so `vp` exists before dependencies are
installed); its bundled Vitest resolves a test's environment package next to itself, so
`jsdom` — a devDependency of _this_ project — is not found and every test file fails before
it runs, with errors that look like broken test code (`Cannot find package 'jsdom'`, or
`Cannot read properties of undefined (reading 'config')`). The pnpm-generated local shim
exports the `NODE_PATH` that makes resolution work, and the Dockerfile puts
`/workspace/frontend/node_modules/.bin` first on `PATH` so plain `vp` is that shim. In a
container built before that change, run `./node_modules/.bin/vp test` explicitly. Everything
else (`vp check`, `vp fmt`, `vp lint`) only uses bundled binaries and works from either.

## Debugging with Stockfish

A CLI wrapper around the bundled engine is available for ad-hoc position analysis
(run from `frontend/`):

```sh
(printf 'uci\nsetoption name MultiPV value 5\nposition fen 8/3k4/7p/2KP3P/8/8/8/8 b - - 3 2\ngo movetime 400\n'; sleep 1) | node scripts/stockfish-cli.mjs | tail -n 6
```

## Measuring the move selector

`src/measurements/` holds the measurement of `useMoveSelector`, so the opponent can be
tuned without guessing. It runs either as a gated Vitest suite or as a CLI script, on the
engine adapters in `src/measurements/shared/`.

- **`engine-playout/`** — plays a fixed 120-puzzle sample against a strong Syzygy-backed
  engine standing in for the user, and scores how long the defense lasted and how tricky it
  made the user's positions. Draw goals and positions with more than 7 men are included.
  Run: `node scripts/measure-engine-playout.mjs` or
  `RUN_PLAYOUT_MEASUREMENT=1 vp test --run enginePlayout`. A full run costs about an hour of
  saturated CPU and its committed baseline/puzzle-set YAMLs must not be casually
  regenerated → **read [`src/measurements/engine-playout/CLAUDE.md`](src/measurements/engine-playout/CLAUDE.md)
  before working in there.**

It is Node-side tooling that imports app modules, so it has its own TypeScript project
(`tsconfig.measurements.json`, referenced from `tsconfig.json`) — `tsconfig.app.json`
excludes it, since app code must not see Node's globals. Nothing in `src/` imports it,
so it never reaches the bundle. Four seams in the app exist for it and should stay:
`useMoveSelector(engine?)` takes an injectable engine (Node has no Web Worker),
`src/utils/uciSearchCollector.ts` holds the UCI `info`-line parsing shared by the WASM
worker and the native binary, `src/utils/autoResolve.ts` holds the auto-win/auto-draw
verdicts as pure functions (`ChessBoard.vue` passes its own state in as context), and
`src/utils/maintainFraction.ts` holds the Trickster's move-weighting so the measured
trickiness is computed by the very function the selector optimizes.

## Architecture

Vue 3 + TypeScript SPA. Entry point: `src/main.ts`. State management: Pinia (`src/stores/`). The `@` alias resolves to `src/`.

Lint rules are configured in `vite.config.ts` (oxlint + eslint + typescript + unicorn + vue plugins). All correctness-category rules are errors. Formatter is Oxfmt: single quotes, no semicolons.

## Code quality

- `typescript/no-explicit-any` is an error — type everything properly.
- `prefer-const` and `no-var` are errors — use `const` by default, `let` only when reassignment is needed.
- Keep components small and focused. Extract reusable logic into composables (`src/composables/`) or stores rather than repeating it.
- Name components, composables, stores, and variables to make their purpose clear from the name alone.
- After every code change, run `vp check --fix` to auto-fix formatting and lint errors, then run `vp run type-check` — `vp check`'s type checker (tsgolint) does not type-check expressions inside `.vue` templates, but the production build (`vue-tsc --build`) does, so skipping this step lets template type errors slip through to a failed deployment. All errors from both commands must be resolved before the work is done.
- Do not start the dev server (`vp dev`) to test changes — the user runs and tests the app themselves.
