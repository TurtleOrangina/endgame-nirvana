# CLAUDE.md — engine-playout measurement

Guidance for working in `src/measurements/engine-playout/`. [`README.md`](./README.md) next
to this file explains what the measurement does and how to read its output — read it first;
this file only covers what is easy to break.

## What this is

A relative benchmark of `src/composables/useMoveSelector.ts`: a fixed 120-puzzle set is
played out with a strong Syzygy-backed engine as the user, and the defense is scored on
DelayMoves, Trickiness, and `Delay × (1 + Trickiness)`.

## Do not run the full measurement unprompted

One full run is **~1–1.5 hours of saturated CPU** plus rate-limited Lichess tablebase
traffic. Ask before starting one. To smoke-test a code change instead:

```sh
node scripts/measure-engine-playout.mjs --puzzles 8 --playouts 1 --resample
```

Note `--resample` there: it overwrites the committed puzzle set, so do it in a throwaway
copy or restore the file afterwards. Without `--resample` the committed 120-puzzle set is
used regardless of `--puzzles`.

## The committed artifacts

`engine-playout-puzzles.yaml` (the puzzle set) and `engine-playout-baseline*.yaml` (one per
defender) live in `frontend/` and are **committed on purpose**:

- Never regenerate the puzzle set casually. Every baseline is only comparable to runs on
  the same set, and re-sampling silently invalidates all of them.
- Never hand-edit a baseline. They are generated artifacts; a stale field is better than an
  invented number.
- They are written and parsed by `yaml.ts`, whose subset is one flow mapping per line plus
  list entries written as a block of scalars with one nested list (the baseline's per-puzzle
  rows and their `playouts:`). `parseMappingList` reads back only an entry's scalars, which
  is what `scripts/compare-playout-baselines.mjs` pairs on — so keep the per-puzzle scores on
  the puzzle itself, not only inside its playouts. `vite.config.ts` has
  `fmt.ignorePatterns: ['engine-playout-*.yaml']` because the formatter otherwise reflows
  them into something that file cannot read. Keep that entry.

## Results are not reproducible

Both engines search by time (`go movetime`), so node counts vary with machine load and a
single playout never repeats — per-puzzle numbers swing widely. Seeding `Math.random` fixes
the selector's sampling, not the engines. Consequences:

- Never assert exact numbers in a test. `enginePlayout.test.ts` only checks the playouts are
  usable as evidence (resolved, ≥1 defender move, trickiness within range).
- Compare runs with `scripts/compare-playout-baselines.mjs`, which pairs by FEN. Pairing
  cancels the (large) between-position variance; an unpaired comparison of means mostly
  measures which positions happened to be in the set.
- Treat a change under two standard errors as noise. The script marks this with `*`.
- Judge on the script's `(relative)` line, not the raw means: delay is right-skewed enough
  that the raw mean spends most of its variance on a few very long draws. See the README's
  _Reading a comparison_ for the validation, and its _What the noise budget actually is_ for
  the effect sizes a standard run can and cannot resolve (raw delay under ~1.6 moves on wins
  and ~5.5 on draws is unresolvable however many playouts you add).

## App seams this depends on

Two pure modules exist so the measurement grades the _real_ logic rather than a copy. Keep
them pure — no Vue reactivity, no stores, no engine calls:

- `src/utils/autoResolve.ts` — `isAutoWin`/`isAutoDraw`, with the board state passed in as an
  `AutoResolveContext`. `ChessBoard.vue` builds that context from its own history and profile
  store; the playout builds it from the puzzle.
- `src/utils/maintainFraction.ts` — `engineMaintainFraction`, used both by the selector's
  Trickster and as the trickiness metric. If these ever diverge, the measurement stops
  measuring the thing it optimizes.

The engine adapters live in `../shared/`. The defender must stay the bundled WASM lite
build (production parity); only the _user_ engine gets the native binary and Syzygy.

## Adding a defender to compare against

`DefenderKind` in `enginePlayout.ts` — add the kind, its branch in `chooseDefenderMove` (or
just an entry in `SELECTOR_TUNINGS` if it is only a `SelectorTuning` difference), and its file
suffix in `playoutHarness.ts`'s `FILE_SUFFIX`. Everything else about the playout must stay
identical across kinds, or the comparison stops isolating the defender.

## Before tuning anything, read the README's "What has already been measured"

Four plausible selector changes have been measured and rejected, and two properties of the
metrics will mislead you if you don't know them: **win-goal delay has no headroom** (every
defender lands within 1.9 moves of a bare single-line search, against ±1.7 noise), and
**trickiness is confounded by game length** (it is a mean over the user's positions, so
defending longer lowers it — the two correlate at -0.59 on wins). A change that "improves
trickiness" by shortening the defense has improved nothing.

## Getting a change out from under the noise

Every defender runs at `MIN_TEMPERATURE`, so the selector's own sampling is already out of the
comparison (see the README's _Evaluation runs at minimum temperature_; `--defender
with-variance` is the one exception, and measures a different opponent). That leaves the
positions: `scripts/find-move-divergence.mjs` builds a puzzle set of only the ones where two
defenders actually play differently. Use it — and keep
a control group in the comparison (rows the change provably cannot affect), because that is
what tells a real effect from the noise floor.

**Before adopting anything, re-run the shipped tuning too** (`--defender trickster-unfocused`,
which is `PRODUCTION_TUNING` under another name). A committed baseline was recorded on some
earlier day, and re-running the shipped tuning against its own baseline — true value zero —
scored a **significant `+0.87±0.56` delay moves on win goals**. That is the same size as the
effects being chased. A change once looked like `+1.43±0.64` and was almost entirely that
offset; measured against a same-session control it was `+0.57±0.84`, i.e. nothing.

Two standard errors cancels between-position variance, not a difference in conditions between
the two runs. Compare the candidate against a control measured in the _same session_; a
committed baseline can rule a change out or drive the in-flight view, but cannot rule one in.
