#!/usr/bin/env node
// Builds a puzzle set of the positions where two defenders would play different moves, so a
// selector change can be measured on the positions it actually reaches instead of on a full
// catalog that is mostly positions it cannot touch. See
// src/measurements/engine-playout/moveDivergence.ts.
import { parseArgs } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
globalThis.__STOCKFISH_ENGINE_BASE_PATH__ = '/engines/'
globalThis.__APP_BUILD_ID__ = 'move-divergence'

const { values } = parseArgs({
  options: {
    detail: { type: 'string', default: 'engine-playout-detail.json' },
    baseline: { type: 'string', default: 'move-selector' },
    variant: { type: 'string', default: 'trickster-focused' },
    out: { type: 'string', default: 'engine-playout-puzzles-divergent.yaml' },
    'per-playout': { type: 'string', default: '3' },
    goal: { type: 'string', default: 'win' },
    'all-men': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
})

if (values.help) {
  console.log(`Usage: node scripts/find-move-divergence.mjs [options]

  --detail <file>       per-ply detail to lift positions from (default engine-playout-detail.json)
  --baseline <kind>     defender to compare against (default move-selector)
  --variant <kind>      defender under test (default trickster-focused)
  --out <file>          puzzle set to write (default engine-playout-puzzles-divergent.yaml)
  --per-playout <n>     positions sampled per recorded playout (default 3)
  --goal <win|draw|any> only lift positions from puzzles with this goal (default win)
  --all-men             include positions a tablebase settles (default: >7 men only)
`)
  process.exit(0)
}

const jiti = createJiti(import.meta.url, { alias: { '@': join(frontendRoot, 'src') } })
const { findDivergentPositions } = await jiti.import(
  '../src/measurements/engine-playout/moveDivergence.ts',
)

const result = await findDivergentPositions({
  frontendRoot,
  detailFile: values.detail,
  baselineKind: values.baseline,
  variantKind: values.variant,
  outputFile: values.out,
  positionsPerPlayout: Number(values['per-playout']),
  manyMenOnly: !values['all-men'],
  goal: values.goal === 'any' ? null : values.goal,
})

console.log(
  `\n${result.divergent} of ${result.candidates} probed positions diverge ` +
    `(${((result.divergent / result.candidates) * 100).toFixed(0)}%)\nWritten to ${result.outputPath}`,
)
