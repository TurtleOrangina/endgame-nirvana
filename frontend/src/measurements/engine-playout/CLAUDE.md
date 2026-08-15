# CLAUDE.md — engine-playout measurement

Guidance for working in `src/measurements/engine-playout/`. [`README.md`](./README.md) next
to this file explains what the measurement does and how to read its output — read it first;
this file only covers what is easy to break.

## What this is

A relative benchmark of `src/composables/useMoveSelector.ts`: a fixed 64-puzzle set is played
out six times each with a strong Syzygy-backed engine as the user, and the defense is scored
on DelayMoves, Trickiness, and `Delay × (1 + Trickiness)`.

## Do not run the full measurement unprompted

One full run is **~2–3 hours of saturated CPU** plus rate-limited Lichess tablebase traffic.
Ask before starting one. To smoke-test a code change instead:

```sh
node scripts/measure-engine-playout.mjs --puzzle-set .playout-runs/smoke.yaml \
  --resample --puzzles 4 --playouts 1
```

`--puzzle-set` there keeps `--resample` away from the committed 64-puzzle set, which it would
otherwise overwrite; `.playout-runs/` is gitignored. Note that a smoke run still overwrites
`engine-playout-baseline.yaml`, so restore it afterwards (`git checkout`) if the working tree
is meant to stay clean.

## The committed artifacts

`engine-playout-puzzles.yaml` (the puzzle set) and `engine-playout-baseline.yaml` are
**committed on purpose**:

- Never regenerate the puzzle set casually. The baseline is only comparable to runs on the
  same set, and re-sampling silently invalidates it.
- Never hand-edit the baseline. It is a generated artifact; a stale field is better than an
  invented number.
- They are written and parsed by `yaml.ts`, whose subset is one flow mapping per line plus
  list entries written as a block of scalars with one nested list (the baseline's per-puzzle
  rows and their `playouts:`). `parseMappingList` reads back only an entry's scalars, which
  is what `scripts/compare-playout-baselines.mjs` pairs on — so keep the per-puzzle scores on
  the puzzle itself, not only inside its playouts. `vite.config.ts` has
  `fmt.ignorePatterns: ['engine-playout-*.yaml']` because the formatter otherwise reflows
  them into something that file cannot read. Keep that entry.

Everything else a run produces goes to `.playout-runs/` (gitignored): one JSONL file per
defender, holding the run's configuration and then one finished puzzle per line. That file is
both the per-ply detail (what `moveDivergence.ts` lifts positions out of) and what
`--continue` resumes from — see `playoutRunStore.ts`. A puzzle is written only once it has
finished, so an interrupted run replays exactly the puzzle that was in progress.

`--continue` with a **higher** `--playouts` tops an existing run up instead of refusing:
every puzzle is played out only for the run numbers it is missing, those are appended as a
second row for that puzzle, and rows are concatenated per puzzle on read. That is how a run
of 3 playouts becomes a run of 6 without repeating the first 3. Keep the file append-only if
you touch this — rewriting rows in place would make a top-up as unresumable as the run it is
extending. The header keeps the count the file was _started_ with; it is only a floor.

## The puzzle set is a plain uniform sample

`playoutPuzzleSelection.ts` takes 64 puzzles at random from the whole catalog, deliberately
**not** stratified over goal and size: the measurement is supposed to say how good an opponent
the selector is for the puzzles users actually meet, so the mix (about two thirds win goals)
has to be the catalog's own. That means subgroups differ in size — the smallest, drawn
positions of more than six men, is around nine puzzles — and small subgroups are read with
that in mind rather than balanced away.

## Draw goals report no delay

Reported metrics split by goal first and by size second (`>6 men` / `≤6 men`, see
`REPORT_MEN_THRESHOLD` — not the same threshold as `MAX_TABLEBASE_MEN`, which is about what a
tablebase can settle). Draw-goal groups report **trickiness only**:

- Making the user sit through a longer hold is not better training. What makes a drawn
  position worth playing is being asked to keep finding the moves that hold it, which is
  exactly what trickiness measures.
- `combined` is delay scaled by trickiness, so it inherits the problem and is dropped too.
- Therefore the `all` group's delay and combined figures come from its **win-goal rows
  alone**, while its trickiness spans everything. Each figure carries its own `n` so the
  narrower base is visible.

The same rule holds in `inFlightComparison.ts` and `scripts/compare-playout-baselines.mjs`.
Do not reintroduce a draw-delay number "for information": it is the number people optimize.

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
  that the raw mean spends most of its variance on a few very long games. See the README's
  _Reading a comparison_.

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

## The defenders

`DefenderKind` in `enginePlayout.ts`:

- `move-selector` — what ships, and what `engine-playout-baseline.yaml` records.
- `engine-best-move` — the floor: one 800 ms multipv-1 search on the same multithreaded WASM
  build, top line played, no tablebase and no selector at all. Like the user engine it is
  searched from the puzzle's start position with the game replayed onto it (`position fen …
moves …`), because a plain search of the current FEN is blind to the history and will shuffle
  into a threefold it cannot see coming — `useMoveSelector` avoids that with its own
  `seenPositionKeys`, a bare search has nothing. Writes
  `engine-playout-baseline-engine-best-move.yaml`.
- `offline` — the shipped selector and the shipped tuning, with every tablebase
  request failing the way it does with no connection (`createOfflineTablebaseClient` in
  `../shared/tablebaseClient.ts`). It measures what the offline user gets, not a tuning: the
  selector still asks for the tablebase and still copes without the answer. The awaited
  pre-warm in `enginePlayout.ts` is skipped for this kind only — awaiting a lookup that fails
  by design would end the playout instead of leaving the selector to defend without one — and
  its tablebase coverage is 0% by construction, so the coverage check says nothing here.
  Writes `engine-playout-baseline-offline.yaml`. Note `scripts/find-move-divergence.mjs`
  cannot narrow this one down: it tells two kinds apart by their `SelectorTuning`, and this
  arm's tuning is identical — what differs is the tablebase it is given.

Adding another is: the new kind, its entry in `SELECTOR_TUNINGS` (if it is only a
`SelectorTuning` difference) or a branch in `chooseDefenderMove`, its file suffix in
`playoutHarness.ts`'s `FILE_SUFFIX`, and a line in `runEnginePlayout.ts`'s description map.
Everything else about the playout must stay identical across kinds, or the comparison stops
isolating the defender.

Earlier arms — a tablebase-fed multipv-1 search, the Trickster switched off, and several
tunings — were removed in the clean-up that introduced this file's current shape, along with
their baselines. Their code is in git history if one of them is wanted back; their _numbers_
are not, since they were measured on the old 120-puzzle stratified set.

## Before tuning anything, read the README's "What has already been measured"

Several plausible selector changes have been measured and rejected, and two properties of the
metrics will mislead you if you don't know them: **win-goal delay has no headroom** (every
defender ever measured landed within 1.9 moves of a bare single-line search, against ±1.7
noise), and **trickiness is confounded by game length** (it is a mean over the user's
positions, so defending longer lowers it — the two correlate at -0.59 on wins). A change that
"improves trickiness" by shortening the defense has improved nothing.

## Getting a change out from under the noise

The defender runs at `MIN_TEMPERATURE`, so the selector's own sampling is already out of the
comparison (see the README's _Evaluation runs at minimum temperature_). That leaves the
positions: `scripts/find-move-divergence.mjs` builds a puzzle set of only the ones where two
defenders actually play differently. Use it — and keep a control group in the comparison (rows
the change provably cannot affect), because that is what tells a real effect from the noise
floor.

**Before adopting anything, measure a control in the same session.** A committed baseline was
recorded on some earlier day, and re-running the shipped tuning against its own baseline —
true value zero — once scored a **significant `+0.87±0.56` delay moves on win goals**. That is
the same size as the effects being chased. A change once looked like `+1.43±0.64` and was
almost entirely that offset; measured against a same-session control it was `+0.57±0.84`, i.e.
nothing.

Two standard errors cancels between-position variance, not a difference in conditions between
the two runs. Compare the candidate against a control measured in the _same session_ (add it
as a second `DefenderKind` identical to what ships); a committed baseline can rule a change
out or drive the in-flight view, but cannot rule one in.
