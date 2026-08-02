#!/usr/bin/env node
// Measures how much resistance the app's move selection actually gives a user who plays
// perfectly, by playing puzzles out with tablebase-optimal moves for the user and the
// real selection logic (src/composables/useMoveSelector.ts) for the defender. See
// src/measurements/defensive-resistance/README.md.
//
// The measurement code is TypeScript and imports the app's own modules through the `@`
// alias, so it is loaded through jiti rather than run by Node directly.
import { parseArgs } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// `useMoveSelector` imports the browser engine module for its thinking-time budgets, and
// that module reads two build-time defines at import. Nothing in the measurement ever
// starts the WASM engine (a native binary stands in for it), so any value will do — they
// only have to exist before the module is evaluated.
globalThis.__STOCKFISH_ENGINE_BASE_PATH__ = '/engines/'
globalThis.__APP_BUILD_ID__ = 'defensive-resistance-measurement'

const { values } = parseArgs({
  options: {
    'puzzles-per-group': { type: 'string', default: '5' },
    playouts: { type: 'string', default: '3' },
    seed: { type: 'string', default: '20260802' },
    threads: { type: 'string' },
    'request-interval': { type: 'string' },
    binary: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
})

if (values.help) {
  console.log(`Usage: node scripts/measure-defensive-resistance.mjs [options]

  --puzzles-per-group <n>  random puzzles per group, on top of the fixed
                           queen-vs-rook position (default 5)
  --playouts <n>           playouts per puzzle (default 3)
  --seed <n>               seed for puzzle selection and defensive sampling
  --threads <n>            native Stockfish threads (default 4, matching the app)
  --request-interval <ms>  minimum spacing between Lichess tablebase requests
                           (default 1100; answers are cached in .tablebase-cache/)
  --binary <path>          native Stockfish binary to drive
`)
  process.exit(0)
}

const jiti = createJiti(import.meta.url, { alias: { '@': join(frontendRoot, 'src') } })
const { runMeasurement } = await jiti.import(
  '../src/measurements/defensive-resistance/runMeasurement.ts',
)

const optionalNumber = (value) => (value === undefined ? undefined : Number(value))

await runMeasurement({
  frontendRoot,
  binaryPath: values.binary,
  engineThreads: optionalNumber(values.threads),
  puzzlesPerGroup: Number(values['puzzles-per-group']),
  playoutsPerPuzzle: Number(values.playouts),
  seed: Number(values.seed),
  minTablebaseRequestIntervalMs: optionalNumber(values['request-interval']),
})
