#!/usr/bin/env node
// Plays a fixed set of puzzles out against the app's move selection
// (src/composables/useMoveSelector.ts) with a strong engine standing in for the user, and
// scores how long the defense lasted and how tricky it made the user's positions. See
// src/measurements/engine-playout/README.md.
//
// The measurement code is TypeScript and imports the app's own modules through the `@`
// alias, so it is loaded through jiti rather than run by Node directly.
import { parseArgs } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// `useStockfishEngine` reads two build-time defines at import for the browser worker. The
// defender here is the same WASM build driven as a child process, which needs neither —
// they only have to exist before the module is evaluated.
globalThis.__STOCKFISH_ENGINE_BASE_PATH__ = '/engines/'
globalThis.__APP_BUILD_ID__ = 'engine-playout-measurement'

const { values } = parseArgs({
  options: {
    puzzles: { type: 'string' },
    playouts: { type: 'string' },
    seed: { type: 'string' },
    threads: { type: 'string' },
    'strong-threads': { type: 'string' },
    'request-interval': { type: 'string' },
    binary: { type: 'string' },
    'puzzle-set': { type: 'string' },
    resample: { type: 'boolean', default: false },
    defender: { type: 'string', default: 'move-selector' },
    help: { type: 'boolean', default: false },
  },
})

if (values.help) {
  console.log(`Usage: node scripts/measure-engine-playout.mjs [options]

  --puzzles <n>            puzzles to sample when creating the set (default 120,
                           split evenly over win/draw × >7-men/≤7-men)
  --playouts <n>           playouts per puzzle (default 2)
  --seed <n>               seed for puzzle sampling and the selector's move sampling
  --threads <n>            defender (WASM lite) threads — defaults to the app's own
                           formula, min(8, cores/2)
  --strong-threads <n>     threads for the native "user" engine
  --request-interval <ms>  minimum spacing between Lichess tablebase requests
                           (default 1100; answers are cached in .tablebase-cache/)
  --binary <path>          native Stockfish binary to drive as the user
  --resample               re-pick the puzzle set instead of reading the committed
                           engine-playout-puzzles.yaml — invalidates old baselines
  --puzzle-set <file>      run a different puzzle set (path relative to frontend/) instead
                           of engine-playout-puzzles.yaml. For measuring an effect confined
                           to a slice of positions, where a full run is mostly noise.
                           Scores are only comparable within the same puzzle set.
  --defender <kind>        which opponent to measure (default move-selector):
                             move-selector       the app's real selection logic
                             multipv1            a bare 400ms multipv-1 search, no
                                                 tablebase — the comparison floor
                             multipv1-tablebase  the same, but a won position of ≤7 men
                                                 is played straight off the tablebase
                             no-trickster        the real selector with the Trickster off
                             multipv-rank-delayer  the real selector, delayer weighting by
                                                 multipv order instead of centipawn gaps
                             with-variance       the real selector at the *app's* temperature,
                                                 so its move sampling is in the measurement
                           …and the rejected arms kept for reference (trickster-led,
                           trickster-geomean, trickster-focused, trickster-unfocused,
                           zeroing-distance, dtm-only-distance) — see the measurement README.
                           Every kind but with-variance runs at minimum temperature.
                           Each writes its own engine-playout-baseline*.yaml.
`)
  process.exit(0)
}

const jiti = createJiti(import.meta.url, { alias: { '@': join(frontendRoot, 'src') } })
const { runEnginePlayout } = await jiti.import(
  '../src/measurements/engine-playout/runEnginePlayout.ts',
)
const { DEFENDER_KINDS } = await jiti.import('../src/measurements/engine-playout/playoutHarness.ts')

if (!DEFENDER_KINDS.includes(values.defender)) {
  console.error(
    `Unknown --defender ${values.defender}; expected one of ${DEFENDER_KINDS.join(', ')}`,
  )
  process.exit(1)
}

const optionalNumber = (value) => (value === undefined ? undefined : Number(value))

await runEnginePlayout({
  frontendRoot,
  binaryPath: values.binary,
  defenderThreads: optionalNumber(values.threads),
  strongEngineThreads: optionalNumber(values['strong-threads']),
  puzzleCount: optionalNumber(values.puzzles),
  playoutsPerPuzzle: optionalNumber(values.playouts),
  seed: optionalNumber(values.seed),
  minTablebaseRequestIntervalMs: optionalNumber(values['request-interval']),
  resample: values.resample,
  defenderKind: values.defender,
  puzzleSetFile: values['puzzle-set'],
})
