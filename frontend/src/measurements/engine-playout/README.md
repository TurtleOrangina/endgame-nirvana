# Engine playout measurement

Scores how good an opponent `src/composables/useMoveSelector.ts` is, across the whole
puzzle catalog, by playing puzzles out against a strong engine standing in for the user.

There is no ground truth to compare against, so its numbers are only meaningful _relative
to another run_ — but it works on every puzzle, including draw-goal ones and positions far
too big for any tablebase, and it scores the Trickster half of the selector.

The set is **64 puzzles drawn uniformly from the catalog**, six playouts each. Uniformly, not
stratified: the mix of goals and sizes is meant to be the one users meet (about two thirds win
goals), so a defender that shines on rare positions cannot look better than it will feel. The
price is uneven subgroups — the smallest, drawn positions of more than six men, is around nine
puzzles.

## Running it

```sh
node scripts/measure-engine-playout.mjs             # the full committed set (2-3 hours)
node scripts/measure-engine-playout.mjs --continue  # pick an interrupted run back up
node scripts/measure-engine-playout.mjs --defender engine-best-move   # the comparison floor
node scripts/measure-engine-playout.mjs --defender offline   # the same selector, offline
node scripts/measure-engine-playout.mjs --help
```

Three opponents can be measured. `move-selector` is what ships and what
`engine-playout-baseline.yaml` holds; `engine-best-move` is the floor it is judged against —
one 800 ms multipv-1 search on the same multithreaded WASM build, top line played, no
tablebase and no selection logic whatsoever. Both are searched with the game replayed from the
puzzle's starting position rather than from a bare FEN, so neither can shuffle into a
threefold it never saw coming.

`offline` is the third: the shipped selector, shipped tuning, with every tablebase
request failing the way it does with no connection. The app works offline, so this is an
opponent real users meet — the question it answers is how much of the defense rests on the
Lichess tablebase. Its tablebase coverage is 0% by construction, so that check carries no
information for this arm; compare it against a `move-selector` run measured in the same
session (see _The drift_), not against the committed baseline.

A run can be interrupted with Ctrl+C and continued later with `--continue`: every finished
puzzle is appended to `.playout-runs/` as it completes, and only the puzzle that was in
progress is replayed. Continuing refuses outright if the defender, seed or puzzle set has
changed in the meantime — resuming into a different configuration would mix two incomparable
runs into one baseline with nothing looking wrong afterwards.

**A finished run can be extended to more playouts per puzzle** by continuing it with a higher
`--playouts`, which is the one configuration change `--continue` allows (lowering it is still
refused — it would report a subset of what was measured):

```sh
node scripts/measure-engine-playout.mjs --defender offline --playouts 6 --continue
```

Each puzzle is then played out only for the playouts it is missing, and those are appended to
the ones already on disk; the baseline is rewritten over all of them. The added playouts are
seeded from the run numbers they actually get (4th, 5th, 6th), so they are new playouts rather
than a repeat of the sampling of the first ones. The playouts of one puzzle are then spread
over two sessions, which is exactly the between-session drift described under _The drift_ —
so a topped-up baseline is a better estimate of the defender (more playouts per puzzle, less
noise) but still not a control for a run measured on some later day.

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
`.playout-runs/run.jsonl` (the run's configuration, then one finished puzzle with all its
plies per line — gitignored, and what `--continue` and the divergence study read).

## The three numbers

- **DelayMoves** — defender moves the user had to answer before the position was done.
- **Trickiness** — mean over the user's positions of `1 - engineMaintainFraction(…)`, the
  weighted fraction of the user's legal moves that would _not_ have held the result. It
  uses the very function the selector's Trickster steers by (`src/utils/maintainFraction.ts`),
  so the metric and the objective can't drift apart. Capped at 0.65 by that function's floor.
- **Combined** — `DelayMoves × (1 + Trickiness)`. A long defense the user can sleepwalk
  through and a short one full of traps are both worth less than a long tricky one.

Plus **tablebase coverage**: the share of the defender's moves it consulted the tablebase for
at all, and how many distinct positions that cost per playout. Not a score — a check. A run
whose tablebase access quietly broke measures a different opponent from the one users face,
and would otherwise only show up as mysteriously weaker defense.

### How they are split

Goal first, size second: `all`, then `winGoal` and `drawGoal`, each with `moreThanSixMen` and
`sixOrLessMen` under it. What a defender should be doing differs far more between holding a
draw and dragging out a loss than between a big position and a small one.

**Draw goals report trickiness only.** Making the user sit through a longer hold is not better
training — what makes a drawn position worth playing is being made to keep finding the moves
that hold it, which is what trickiness measures. Reporting draw delay would invite optimizing
it, so it is left out, and `combined` (delay scaled by trickiness) with it. Consequently the
`all` group's delay and combined figures are computed over its **win-goal rows alone**, while
its trickiness spans every puzzle; each figure carries its own `n`.

The size split is at six men, which is not the same question as `MAX_TABLEBASE_MEN`: a 7-man
position is settled by the tablebase but is still a big position for the engine to defend.

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

Whether the variance itself costs anything has been asked and answered — see _What has
already been measured_ — by a defender kind that ran at the app's own temperature. A kind like
that measures a different opponent, so its numbers are never comparable to a
minimum-temperature run; the baseline records which of the two it was in its `config:` line.

## Reading a comparison

Both engines search by _time_, so a single playout is not reproducible: node counts vary
with machine load, the moves diverge, and per-puzzle numbers swing widely. Only the
averages are stable, which is what the seeded 64-puzzle set and 6 playouts per puzzle are
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
floor of the measurement. Like the report, it shows no delay for draw goals.

The puzzle set lives in `engine-playout-puzzles.yaml` and is **committed rather than
re-derived from the seed**. `public/exercises.json` is refreshed periodically from prod,
and any change to it would silently re-sample the set — making a new run incomparable to
the baseline with nothing looking wrong. `--resample` regenerates it deliberately, which
invalidates every older baseline. (`--continue` guards the same thing within a run: the
resumed file records a digest of the set it was measured on.)

## Getting a change out from under the noise

A full run averages a selector change together with every position the change cannot reach.
The selector's own sampling is already out of the way (see _Evaluation runs at minimum
temperature_), which leaves the positions:

- **Measure only where the change bites.** `scripts/find-move-divergence.mjs` replays a
  previous run's recorded playouts (`.playout-runs/run.jsonl`), asks two defenders — so it
  needs the candidate to exist as a second `DefenderKind` — for a move at each position at
  minimum temperature, and writes the positions where they disagree as a puzzle set. Those rows carry
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

### On the current 64-puzzle set

**How much the selector beats a bare search by: `engine-best-move`, both arms measured the
same day.** The floor gets 800 ms multipv-1 on the same WASM build, which costs the same
thinking time as the selector (768 vs 772 ms mean per move), so this is a like-for-like
comparison of what the selection logic adds on top of a search:

```
  win expected    n= 43  delayMoves=-0.57±0.43   trickiness=-0.03±0.01*  combined=-1.12±0.55*
  (relative)             delayMoves=-2.9%±4.2%  rank z=-0.91
    >6 men        n= 21  delayMoves=+0.03±0.44   trickiness=-0.02±0.02   combined=-0.24±0.52
    ≤6 men        n= 22  delayMoves=-1.13±0.70   trickiness=-0.03±0.02   combined=-1.95±0.91*
  draw expected   n= 21  trickiness=+0.00±0.03
    >6 men        n=  9  trickiness=+0.07±0.04
    ≤6 men        n= 12  trickiness=-0.05±0.04
```

Read carefully, because the headline is smaller than it looks:

- **On win goals the selector is ahead, and it is trickiness that carries it** (-0.03±0.01
  against the floor, significant). Delay is not: -0.57±0.43 raw, and the relative estimator
  puts it at -2.9%±4.2% with rank z=-0.91, i.e. nothing. This is the old "win-goal delay has
  no headroom" finding reproduced on the new set against a floor with twice the old budget.
- **The win-goal gap is entirely in the small positions** (≤6 men, `combined -1.95±0.91`),
  where the selector has tablebase distances to steer by and the bare search has none. Above
  six men, where neither has perfect information, the two are indistinguishable
  (`delay +0.03±0.44`).
- **On draws the selector does not beat a plain 800 ms search at all** (`trickiness +0.00±0.03`
  overall; the >6-men row even leans the floor's way at +0.07±0.04, ~1.7 SEM). Whatever the
  Trickster is worth in a drawn position, this comparison cannot see it. That is the most
  interesting open question the measurement currently poses — and note the floor's tablebase
  coverage is 0% against the selector's 89%, so on the ≤7-men draws the two are not even
  playing with the same information.

### On the old set

**Every number below was measured on the old set** — 120 puzzles stratified into equal win/draw × many/few-men buckets, two
playouts each — and against baselines that are no longer in the tree. The conclusions still
hold; the figures are not comparable to a run on the current 64-puzzle sample, and none of
these arms exists as a `--defender` kind any more (the code is in git history, and CLAUDE.md's
_Adding a defender_ says how to bring one back).

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

**What the noise budget actually is.** Decomposing the paired variance of the old 120-puzzle,
2-playout comparison into playout noise (`W`, reducible by more playouts) and genuine
per-position differences between the two arms (`T`, reducible only by more puzzles):

| group | mean delay | W (within-puzzle var) | T   | share that is playout noise |
| ----- | ---------- | --------------------- | --- | --------------------------- |
| win   | 10.6       | 22                    | 15  | 60%                         |
| draw  | 24.6       | 397                   | 58  | 87%                         |

So the smallest raw effect that run could resolve (2 SEM) was **±1.6 delay moves on wins and
±5.5 on draws**, and quadrupling the playouts per puzzle only took draws to ±4.1 — the noise
is in the trajectories, not in the sample size. That decomposition is why the current set
trades puzzles for playouts (64 × 6 rather than 120 × 2): most of the paired variance was
within-puzzle, which is the half more playouts actually buy down. Chasing a sub-move effect on
raw delay is still hopeless by construction; use the relative estimator (which resolved ~8% on
wins, ~15% on draws), a divergence set, or both.

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
the candidate and a control — a second `DefenderKind` that is the shipped tuning under another
name — in the same session, and compare those two to each other. Committed baselines are still useful for
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
