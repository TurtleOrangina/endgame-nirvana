# Engine playout measurement

Scores how good an opponent `src/composables/useMoveSelector.ts` is, across the whole
puzzle catalog, by playing puzzles out against a strong engine standing in for the user.

There is no ground truth to compare against, so its numbers are only meaningful _relative
to another run_ — but it works on every puzzle, including draw-goal ones and positions far
too big for any tablebase, and it scores the Trickster half of the selector.

## Running it

```sh
node scripts/measure-engine-playout.mjs            # the full committed set (hours)
node scripts/measure-engine-playout.mjs --puzzles 8 --playouts 1 --resample   # smoke test
node scripts/measure-engine-playout.mjs --defender no-trickster               # a variant
node scripts/measure-engine-playout.mjs --help
```

The user engine is a native Stockfish build with Syzygy tables beside it. Its directory is
resolved per machine (`src/measurements/shared/enginePaths.ts`): the dev container's
`/home/node/native_stockfish/engines`, else `~/.stockfish/engines`, and
`STOCKFISH_ENGINES_DIR` overrides both — it must hold `stockfish_latest` and `syzygy/`.
`--binary` points at just the binary. A missing binary fails at startup with those paths
spelled out, rather than an hour into a run.

Or as a Vitest suite, gated so a normal `vp test` skips it:

```sh
RUN_PLAYOUT_MEASUREMENT=1 vp test --run enginePlayout
```

Both drive the same harness. Results land in `engine-playout-baseline.yaml` (committed) and
`engine-playout-detail.json` (per-ply, gitignored).

## The three numbers

- **DelayMoves** — defender moves the user had to answer before the position was done.
- **Trickiness** — mean over the user's positions of `1 - engineMaintainFraction(…)`, the
  weighted fraction of the user's legal moves that would _not_ have held the result. It
  uses the very function the selector's Trickster steers by (`src/utils/maintainFraction.ts`),
  so the metric and the objective can't drift apart. Capped at 0.65 by that function's floor.
- **Combined** — `DelayMoves × (1 + Trickiness)`. A long defense the user can sleepwalk
  through and a short one full of traps are both worth less than a long tricky one.

Reported for all puzzles and for three subsplits: >7 men (no tablebase can settle these),
win-goal, and draw-goal.

## When a playout is done

Playing to bare checkmate would drown the signal in mop-up moves nobody needs a training
partner for, so a playout ends as soon as the position stops being training:

- a real game end (mate, stalemate, threefold, 50-move, insufficient material);
- the board's own auto-solves, `isAutoWin`/`isAutoDraw` (`src/utils/autoResolve.ts`),
  applied exactly where `ChessBoard.vue` applies them;
- a legal move by the user _into_ an auto-solved position — the user would have played it,
  so the defense stopped mattering one move earlier. The wide search that measures
  trickiness already enumerates the user's moves with their scores and follow-ups, so this
  costs no extra engine time.

For won puzzles the recorded line is then shortened after the fact:

- **repetition loops** are spliced out between a position's first and last occurrence
  (legal precisely because the positions are identical), repeatedly, so nested loops don't
  survive one pass — otherwise shuffling would read as resistance;
- **the converted tail** is cut: the longest suffix in which every user-to-move position is
  ≥4 pawns up _and_ ≥4 pawns better than where the puzzle started. Winning the defender's
  last piece ends the training, whatever the board still shows.

Drawn puzzles get neither cut: repetition is the legitimate way to hold a draw, and there
is no material breakthrough to convert.

Every playout is listed individually under its puzzle in the baseline, with its own scores,
its end reason, and the trimmed line in algebraic notation — replayable on a board from the
puzzle's starting position, which is what makes a number in the report checkable by eye. A
line whose converted tail was cut reports `material-truncated` instead of how the game
happened to end afterwards, since the game past that point is not what was scored.

## The two engines

|         | Defender (`useMoveSelector`)                         | User                                                   |
| ------- | ---------------------------------------------------- | ------------------------------------------------------ |
| Binary  | the bundled WASM `stockfish-18-lite`, run under Node | native `stockfish_latest`                              |
| Syzygy  | none                                                 | `syzygy/` beside the binary (see Running it)           |
| Threads | the app's own formula, `min(8, cores/2)`             | ~24                                                    |
| Search  | whatever `useMoveSelector` asks for                  | 400 ms multipv 1 to move, 200 ms multipv 64 to measure |

The defender deliberately runs the _shipped_ build rather than the native binary: what this
grades is the opponent users actually face. The user engine is the opposite — as strong as
possible, with perfect endgame knowledge, so it converts won positions instead of wandering
and inflating the measured delay.

The Lichess tablebase is queried exactly where the app queries it (≤8 men), through the
disk cache in `.tablebase-cache/`. `useMoveSelector` never awaits its own lookup — it uses
the answer only if it beats the engine search — so the playout pre-warms the cache first;
without that the rate-limited request would always lose the race and the measurement would
silently grade a tablebase-less defender.

## Evaluation runs at minimum temperature

The app samples its move: `useMoveSelector` draws from the candidate weights at `TEMPERATURE`,
and that variance is the point — it is what keeps a puzzle worth replaying. **The measurement
does not.** Every defender here runs at `MIN_TEMPERATURE`, where the selector always plays its
highest-weighted candidate and only samples between candidates it rates exactly equal.

That is deliberate. A comparison asks which weighting defends better, and the sampling is a
property of the opponent rather than of the weighting — letting each run roll its own dice
just adds a third noise source on top of two time-limited engines. Holding it fixed makes a
difference between two runs attributable to the thing that changed.

The exception is `--defender with-variance`, which uses the app's own temperature so the
sampling is in the measurement. That is what answers "does the variance itself cost anything?"
— a real question, since the shipped opponent is the sampled one. Its numbers are not
comparable to a minimum-temperature run: they measure a different opponent.

Every baseline records which of the two it was in its `config:` line.

## Reading a comparison

Both engines search by _time_, so a single playout is not reproducible: node counts vary
with machine load, the moves diverge, and per-puzzle numbers swing widely. Only the
averages are stable, which is what the seeded 120-puzzle set and 2 playouts per puzzle are
for. The summary reports `sem` (standard error of the mean) alongside `sd` — a difference
between two runs' means is only interesting if it is well outside it.

Better still, compare **per puzzle**: the `puzzles:` rows are keyed by FEN, and a paired
comparison cancels the (large) real differences between positions and leaves just the
change in the selector.

`compare-playout-baselines.mjs` prints two lines per group. The first is the mean of the raw
per-puzzle differences; the second, `(relative)`, is the same comparison as a per-puzzle
_ratio_ (a mean of `log((after+1)/(before+1))`, reported as a percent) plus a Wilcoxon
signed-rank z. **Read the relative line first.** DelayMoves is strongly right-skewed — a
median of 12 moves with a tail past 100 — so a mean of raw differences is dominated by a
handful of long draws and inherits their variance, which is exactly the noise that hides
real effects. On the comparisons whose answer is already known, the ratio roughly doubles
to triples the signal at no extra CPU:

| comparison                        | raw delay t | relative delay t |
| --------------------------------- | ----------- | ---------------- |
| `no-trickster` (real, all)        | 1.19        | **3.50**         |
| `trickster-geomean` (real, draws) | 1.33        | **3.36**         |
| `multipv1` (real, draws)          | 4.47        | **5.83**         |
| `trickster-unfocused` (true null) | -0.32       | -0.80            |

The null pair stays null, so this is a better estimator rather than a looser threshold. The
rank z is the distribution-free cross-check: it uses only the order of the per-puzzle
differences, so no single runaway playout can carry it. Adopt on both agreeing.

While a run is in progress it prints exactly that paired comparison after each puzzle,
always against `engine-playout-baseline.yaml` — the shipping `move-selector` — whichever
defender is being measured, so an alternative defender's deltas answer "better or worse
than what ships?". The line names the file it compared against. A `--defender
move-selector` run therefore compares against its own previous run, which is the noise
floor of the measurement.

The puzzle set lives in `engine-playout-puzzles.yaml` and is **committed rather than
re-derived from the seed**. `public/exercises.json` is refreshed periodically from prod,
and any change to it would silently re-sample the set — making a new run incomparable to
the baseline with nothing looking wrong. `--resample` regenerates it deliberately, which
invalidates every older baseline.

## Getting a change out from under the noise

A full run averages a selector change together with every position the change cannot reach.
The selector's own sampling is already out of the way (see _Evaluation runs at minimum
temperature_), which leaves the positions:

- **Measure only where the change bites.** `scripts/find-move-divergence.mjs` replays a
  previous run's recorded playouts, asks two defenders for a move at each position at minimum
  temperature, and writes the positions where they disagree as a puzzle set. Those rows carry
  `defenderToMoveFirst: true`, so playing one out resumes at the disagreement with the
  defender on move. Feed the set to two ordinary runs via `--puzzle-set` and compare them as
  usual:

  ```sh
  node scripts/find-move-divergence.mjs --baseline move-selector --variant <candidate>
  node scripts/measure-engine-playout.mjs --defender move-selector \
    --puzzle-set engine-playout-puzzles-divergent.yaml
  node scripts/measure-engine-playout.mjs --defender <candidate> \
    --puzzle-set engine-playout-puzzles-divergent.yaml
  node scripts/compare-playout-baselines.mjs \
    engine-playout-baseline.yaml engine-playout-baseline-<candidate>.yaml
  ```

  Scores on such a set are **only** comparable to other runs on that same set. The positions
  are selected precisely because they are contentious, so their absolute delay and trickiness
  say nothing about the catalog. Every baseline records which set it ran on in its `config:`
  line — check it before comparing two files.

## What has already been measured

Kept here so the same ideas don't get re-run from scratch. Every one of these is
reproducible as a `--defender` kind.

**The app's own temperature costs essentially nothing: `with-variance`.** Sampling at the
shipped `TEMPERATURE` instead of `MIN_TEMPERATURE` measured `delay +1.9% ± 4.4%, rank
z=0.97` over all puzzles (`+1.2% ± 4.1%` on wins) — a null under both estimators, i.e. the
variance costs at most ~10% of the defense length and most likely nothing. That is not the
measurement failing to see it: the _dose_ is nearly zero. `TEMPERATURE` is 0.2, and
`applyTemperatureToWeights` raises the normalized weights to `1/0.2 = 5` on top of the
delayer's already-squared weight, so the top candidate wins the draw unless something is
nearly tied with it. In the recorded lines, the two playouts of a puzzle chose different
first moves in **5/120 puzzles at app temperature and the same 5/120 at minimum
temperature** — the sampling adds no more divergence than the two time-limited engines
already do by themselves. (Also note the committed set has exactly **one** pawnless
position, so `TEMPERATURE_PAWNLESS_FIRST_TRY`'s much flatter 0.33 is effectively unmeasured.)

**What the noise budget actually is.** Decomposing the paired variance of a 120-puzzle,
2-playout comparison into playout noise (`W`, reducible by more playouts) and genuine
per-position differences between the two arms (`T`, reducible only by more puzzles):

| group | mean delay | W (within-puzzle var) | T   | share that is playout noise |
| ----- | ---------- | --------------------- | --- | --------------------------- |
| win   | 10.6       | 22                    | 15  | 60%                         |
| draw  | 24.6       | 397                   | 58  | 87%                         |

So the smallest raw effect a standard run can resolve (2 SEM) is **±1.6 delay moves on
wins and ±5.5 on draws**, and quadrupling the playouts per puzzle only takes draws to ±4.1
— the noise is in the trajectories, not in the sample size. Chasing a sub-move effect on
raw delay is hopeless by construction; use the relative estimator (where the same run
resolves ~8% on wins, ~15% on draws), a divergence set, or both.

**Rejected after a drift check: `trickster-focused` — and the drift check is the lesson.**
The Trickster probed all five candidates at 20 ms each, including ones the delayer had already
weighted below the pruning threshold in `normalizeWeights` — search spent on answers that
cannot change the move. Probing only the three the delayer rates highest, each proportionally
longer at unchanged total cost, measured as a clear win against the committed baseline:

```
  win expected  n= 60  delay=+1.43±0.64*  trickiness=-0.02±0.01  combined=+1.94±0.91*
```

It was adopted on that evidence, then measured properly and reverted. Re-running the two arms
**on the same day** leaves nothing:

```
  trickster-unfocused -> trickster-focused, both measured the same day
  win expected  n= 60  delay=+0.57±0.84  trickiness=+0.00±0.01  combined=+0.95±1.16
```

## The drift, and why it matters more than any of the above

The reason the two disagree is that the committed baseline was recorded on an earlier day.
Running the **shipped tuning against its own baseline** — a comparison whose true value is zero
by construction — gives:

```
  engine-playout-baseline.yaml -> the identical tuning, re-run months later
  all puzzles   n=120  delay=+0.75±1.23   trickiness=-0.01±0.01  combined=+0.95±1.72
  win expected  n= 60  delay=+0.87±0.56*  trickiness=-0.02±0.01  combined=+0.98±0.70*
```

A **statistically significant `+0.87` delay moves on win goals, from changing nothing at all.**
The `*` threshold is doing its job on the variance it can see — pairing cancels the differences
between positions — but it cannot see a difference in conditions between the two runs, and that
offset is the same size as the effects worth chasing. On win goals, where the whole spread
across every defender ever measured is under two moves, it is decisive.

So: **a cross-day comparison against a committed baseline cannot support an adoption.** Measure
the candidate and `--defender trickster-unfocused` (the shipped tuning under another name) in the
same session, and compare those two to each other. Committed baselines are still useful for
watching a run in flight and for ruling changes _out_; they are not evidence for ruling one in.

**Win-goal delay has almost no headroom.** Across every defender measured on the committed
set, win delay spans 1.9 moves — `no-trickster` 9.4, `multipv1-tablebase` 10.3,
`move-selector` 10.6, `multipv1` 11.2, `multipv-rank-delayer` 11.3 — against a paired noise
of about ±1.7. A bare 400 ms single-line search and the full selector are within 0.6 moves of
each other. A native Stockfish with Syzygy converts a won endgame in about the same number of
moves whatever the defender does, so work aimed at this number is chasing noise. Draw delay is
the opposite: 24.6 against `multipv1`'s 14.3, and that is where the selector earns its keep.

**Trickiness is confounded by game length.** It is a mean over the user's positions, and a
longer defense accumulates easy ones: within a single baseline, delay and trickiness correlate
at -0.59 on wins and -0.40 on draws, and the short half of the playouts scores 0.517 against
the long half's 0.330. Recomputed over the first four user positions only, `multipv1`'s
apparent draw-trickiness lead over the selector (0.483 vs 0.424) vanishes — 0.515 vs 0.507. So
a trickiness gain bought by defending fewer moves is not a gain, and two defenders' raw
trickiness is only comparable when their delay is too. Judge on `combined`, or control for
length.

**Rejected: rollouts as a delayer fallback.** Where no candidate distance is grounded in a
tablebase or a mate score, play each candidate out with a few-millisecond engine self-play and
weight by how long the defense lasted, instead of guessing from centipawn gaps. Measured on a divergence set — only the positions where it changes the move — it
produced `delay -1.36 ± 1.71` for `+107 ms` per move. The control settles it: on the ≤7-men
rows, where the rollout cannot fire at all, the measured "effect" was the same size
(-1.41 ± 2.34). The implementation has been removed; one refinement was never tested, in that
the rollout's stand-in user was the WASM engine at 8 ms where the real user is native at 400 ms
with Syzygy, so an asymmetric budget might have made its estimate transfer.

**Rejected: `trickster-led`** (the delayer's weight no longer squared, so the Trickster
decides). Aborted in flight at -1.6 delay for +0.02 trickiness on wins — the delay loss costs
far more combined than the trickiness gain returns.

**Rejected: `trickster-geomean` — and this one is worth reading before "fixing" the bias
again.** The Trickster multiplies one survival fraction per probed position, and a line is
probed only as far as its PV reaches, so its weight depends on how deep that line happened to
be searched. The bias is real and pinned by `__tests__/moveSelectorTrickster.test.ts`, where
two candidates identical in every way except PV length are rated more than 5× apart. Dividing
it out with a geometric mean made the defender **significantly worse** on a full run:

```
  all           n=120  delay=-1.48±1.24   trickiness=-0.03±0.01*  combined=-3.24±1.57*
  win expected  n= 60  delay=+0.38±0.60   trickiness=-0.05±0.01*  combined=-0.17±0.75
  draw expected n= 60  delay=-3.34±2.38   trickiness=-0.02±0.01   combined=-6.32±3.00*
```

Length-controlled trickiness moves with the raw figure (-0.04 on wins), so the loss is genuine
rather than the length confound. The likeliest reading is that the bias was doing useful work
by proxy: the line the search went deepest down is usually the line the engine liked best,
which in a drawn position is the one that actually holds. Removing a bias removed a signal.
