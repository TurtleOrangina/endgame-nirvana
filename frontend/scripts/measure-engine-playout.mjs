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
    continue: { type: 'boolean', default: false },
    defender: { type: 'string', default: 'move-selector' },
    help: { type: 'boolean', default: false },
  },
})

if (values.help) {
  console.log(`Usage: node scripts/measure-engine-playout.mjs [options]

  --puzzles <n>            puzzles to sample when creating the set (default 64, drawn
                           uniformly from the catalog, so the mix of goals and sizes is
                           the catalog's own)
  --playouts <n>           playouts per puzzle (default 6)
  --seed <n>               seed for puzzle sampling and the selector's move sampling
  --threads <n>            defender (WASM lite) threads — defaults to the app's own
                           formula, min(8, cores/2)
  --strong-threads <n>     threads for the native "user" engine
  --request-interval <ms>  minimum spacing between Lichess tablebase requests
                           (default 1100; answers are cached in .tablebase-cache/)
  --binary <path>          native Stockfish binary to drive as the user
  --resample               re-pick the puzzle set instead of reading the committed
                           engine-playout-puzzles.yaml — invalidates old baselines
  --continue               pick up an interrupted run of the same configuration where it
                           stopped, from .playout-runs/. The puzzle in progress when it
                           was interrupted is replayed; every finished one is kept.
                           Raising --playouts and continuing tops the finished puzzles up
                           to the new count instead of replaying them, so an existing run
                           can be extended (e.g. --playouts 6 --continue over a run of 3).
  --puzzle-set <file>      run a different puzzle set (path relative to frontend/) instead
                           of engine-playout-puzzles.yaml. For measuring an effect confined
                           to a slice of positions, where a full run is mostly noise.
                           Scores are only comparable within the same puzzle set.
  --defender <kind>        which opponent to measure (default move-selector):
                             move-selector     the app's real selection logic
                             engine-best-move  a bare 800ms multipv-1 search on the same
                                               WASM build, no tablebase — the floor
                             offline           the shipped selector with every tablebase
                                               request failing, as when the user is offline
                           Each writes its own engine-playout-baseline*.yaml; see the
                           measurement's CLAUDE.md for how to add another.
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

// A refused --continue and a missing engine are both things the operator has to fix, not
// bugs to read a stack trace for
try {
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
    resumePreviousRun: values.continue,
    defenderKind: values.defender,
    puzzleSetFile: values['puzzle-set'],
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
