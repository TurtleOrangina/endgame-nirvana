# Defensive resistance measurement

Answers one question: **how much of the theoretically available resistance does the app's
move selection actually give a user who plays perfectly?**

Over-tuning the defender is a real risk — a bare Queen vs. Rook is the classic example,
where an engine defends so well that the position becomes frustrating rather than
instructive. This harness puts a number on it.

There are two equivalent entry points over the same harness (`measurementHarness.ts`).

**Vitest** — one test case per puzzle, so you get per-puzzle progress and can filter with
`-t`. It is gated behind `RUN_RESISTANCE_MEASUREMENT=1` and skips otherwise, so a normal
`vp test` never picks up an hours-long networked run:

```sh
RUN_RESISTANCE_MEASUREMENT=1 vp test --run defensiveResistance
RUN_RESISTANCE_MEASUREMENT=1 RESISTANCE_PLAYOUTS=10 vp test --run defensiveResistance
RUN_RESISTANCE_MEASUREMENT=1 RESISTANCE_PUZZLES_PER_GROUP=0 RESISTANCE_PLAYOUTS=1 \
  vp test --run defensiveResistance          # quick smoke run: the fixed KQvKR puzzle only
```

Env vars: `RESISTANCE_PUZZLES_PER_GROUP`, `RESISTANCE_PLAYOUTS`, `RESISTANCE_SEED`,
`RESISTANCE_THREADS`, `RESISTANCE_REQUEST_INTERVAL_MS`, `RESISTANCE_STOCKFISH`,
`RESISTANCE_PUZZLE_TIMEOUT_MS`.

Note that `vp test` **intercepts console output by default**, so the engine's per-move
candidate tables and the summary won't appear on screen — pass `--disableConsoleIntercept`
if you want them. The written reports (below) are unaffected.

**CLI script** — same run, with flags instead of env vars and console output always
visible:

```sh
node scripts/measure-defensive-resistance.mjs            # full run
node scripts/measure-defensive-resistance.mjs --help     # options
node scripts/measure-defensive-resistance.mjs --puzzles-per-group 0 --playouts 1
```

Either way the run writes two files, named after the configuration that produced them
(so a smoke run can never clobber a long run's results):
`defensive-resistance-<n>puzzles-<n>playouts-seed<n>.json` (per-move detail) and `.txt`
(the human-readable report).

## How a playout works

Each puzzle is played to checkmate between two players:

- **The user side** plays perfectly: the tablebase move with the shortest distance to
  mate, every time.
- **The defender** is the app's own `useMoveSelector` — the real engine lines, tablebase
  filtering, delayer/trickster weighting and temperature-0.2 sampling that a rated
  attempt faces on the board.

## The metrics

Let `dtm` be the distance to mate (in plies) in a position where the user is to move.

- **Perfection** — `actual plies / optimal plies`, where the optimal ply count is simply
  the starting position's `dtm`. 100% means the defender held out exactly as long as
  perfect defense could have.
- **Fraction lost per defensive move** — after the user's optimal move and the defender's
  reply, a perfect defense leaves the user looking at `dtm - 2`. Anything less was thrown
  away, so the move lost `((dtm - 2) - dtm_after) / (dtm - 2)`. Reported as mean, max and
  standard deviation, pooled over every defensive move played.

Both are also aggregated per puzzle group and over the whole run. Per-move detail lands in the
written `.json` report.

## The puzzle set

The fixed Queen vs. Rook position (`8/8/4r3/4k3/8/3QK3/8/8 w - - 0 1`) plus, by default,
5 random puzzles each from Pawn Endgames, Rook Endgames, and everything else. Selection
is seeded, so a run repeats exactly; pass `--seed` for a different set.

Only positions of **at most 6 men that the side to move wins** are eligible. Distance to
mate is the entire metric here, and a drawn position has none — measuring conceded mate
distance in a position nobody can win is meaningless.

## Engine and tablebase

- **Engine**: the native Stockfish binary at `/home/node/native_stockfish/engines/`,
  driven through the same `StockfishEngine` interface the WASM worker implements (see
  `nativeStockfishEngine.ts`). It runs on 4 threads and **without** `SyzygyPath`, because
  the app's engine has no tablebase access either. It does use the full NNUE net where
  the app ships the "lite" one, so the defender measured here is, if anything, marginally
  stronger than the one users face.
- **Tablebase**: the Lichess online tablebase, through a serialized client that spaces
  requests out (1.1 s by default), backs off for a minute on a 429, and caches every
  answer to `.tablebase-cache/`. The app's `useLichessTablebase` is routed through the
  same client by swapping `globalThis.fetch`, so move selection and the measurement share
  one cache and one rate limiter. A first full run makes a few thousand requests; re-runs
  make none.

  Move selection deliberately does not wait for the tablebase — it fires the query off and
  uses the answer only if it beats the engine search. In the browser it normally does; at
  this harness's request spacing it never would, which would silently measure an
  engine-only defender. The playout therefore warms the cache for the defender's position
  before handing it to the selector.

## Reading the results

Watch for a **low mean but high max**: that is the healthy shape. It means the defender
tracks optimal play move for move and the win is only conceded at a handful of real
decision points, rather than the defense quietly leaking everywhere.

Note that the mop-up phase counts too. Once the defender is reduced to a bare king every
remaining move is trivially optimal, which pulls the mean down on puzzles that end in a
long forced mate — the per-move detail in the JSON report shows where the resistance
actually went.
