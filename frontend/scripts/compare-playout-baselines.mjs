#!/usr/bin/env node
// Compares two engine-playout baselines. The per-puzzle rows are keyed by FEN, so the
// comparison is *paired*: it cancels the (large) real differences between positions and
// leaves only what changed about the defender — which is what makes a difference readable
// at all, given both engines search by time and no single playout repeats.
//
//   node scripts/compare-playout-baselines.mjs <before.yaml> <after.yaml>
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const [beforePath, afterPath] = process.argv.slice(2)
if (!beforePath || !afterPath) {
  console.error('Usage: node scripts/compare-playout-baselines.mjs <before.yaml> <after.yaml>')
  process.exit(1)
}

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const jiti = createJiti(import.meta.url, { alias: { '@': join(frontendRoot, 'src') } })
const { parseMappingList } = await jiti.import('../src/measurements/engine-playout/yaml.ts')

const rowsByFen = (path) =>
  new Map(parseMappingList(readFileSync(path, 'utf8'), 'puzzles').map((row) => [row.fen, row]))

const before = rowsByFen(beforePath)
const after = rowsByFen(afterPath)
const paired = [...after.entries()].flatMap(([fen, row]) => {
  const previous = before.get(fen)
  return previous ? [{ fen, goal: row.goal, men: row.men, previous, row }] : []
})

const mean = (values) =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length

function summarize(deltas) {
  const average = mean(deltas)
  const variance = mean(deltas.map((delta) => (delta - average) ** 2))
  const sem = deltas.length === 0 ? 0 : Math.sqrt(variance / deltas.length)
  return {
    average,
    sem,
    improved: deltas.filter((delta) => delta > 0).length,
    count: deltas.length,
  }
}

function pairedStats(entries, metric) {
  return summarize(entries.map((entry) => entry.row[metric] - entry.previous[metric]))
}

// DelayMoves and Combined are strongly right-skewed (a handful of 100-move draws sit next
// to 4-move wins), so a mean of raw differences is dominated by the longest playouts and
// carries their variance. The same difference expressed per puzzle as a *ratio* is far
// better behaved: on the pairs whose answer is already known, the log-ratio raises
// no-trickster's delay signal from t=1.2 to t=3.5 and trickster-geomean's draw delay from
// t=1.3 to t=3.4, while the same-tuning null pair stays at t=-0.8. Reported as a percentage
// change, it is also the more natural question: "how much longer did the defense last?"
function pairedRatioStats(entries, metric) {
  return summarize(
    entries.map((entry) => Math.log((entry.row[metric] + 1) / (entry.previous[metric] + 1))),
  )
}

// Distribution-free companion to the ratio: the Wilcoxon signed-rank statistic as a z score,
// which only uses the *order* of the per-puzzle differences and so cannot be moved by a
// single runaway playout. A change worth adopting should show up in both.
function signedRankZ(entries, metric) {
  const deltas = entries
    .map((entry) => entry.row[metric] - entry.previous[metric])
    .filter((delta) => delta !== 0)
    .map((delta) => ({ delta, magnitude: Math.abs(delta) }))
    .sort((a, b) => a.magnitude - b.magnitude)
  if (deltas.length === 0) return 0

  const ranks = Array.from({ length: deltas.length })
  for (let start = 0; start < deltas.length;) {
    let end = start
    while (end + 1 < deltas.length && deltas[end + 1].magnitude === deltas[start].magnitude) end++
    const averageRank = (start + end + 2) / 2
    for (let i = start; i <= end; i++) ranks[i] = averageRank
    start = end + 1
  }

  const positiveRankSum = deltas.reduce(
    (sum, entry, index) => (entry.delta > 0 ? sum + ranks[index] : sum),
    0,
  )
  const count = deltas.length
  const expected = (count * (count + 1)) / 4
  const deviation = Math.sqrt((count * (count + 1) * (2 * count + 1)) / 24)
  return (positiveRankSum - expected) / deviation
}

const groups = [
  ['all puzzles', () => true],
  ['>7 men', (entry) => entry.men > 7],
  ['win expected', (entry) => entry.goal === 'win'],
  ['draw expected', (entry) => entry.goal === 'draw'],
]

console.log(`${beforePath}\n  ->  ${afterPath}\n`)
console.log(`${paired.length} puzzles matched by FEN (paired comparison)\n`)
for (const [label, includes] of groups) {
  const entries = paired.filter(includes)
  const parts = ['delayMoves', 'trickiness', 'combined'].map((metric) => {
    const { average, sem } = pairedStats(entries, metric)
    const significance = Math.abs(average) > 2 * sem ? '*' : ' '
    return `${metric}=${average >= 0 ? '+' : ''}${average.toFixed(2)}±${sem.toFixed(2)}${significance}`
  })
  const { improved, count } = pairedStats(entries, 'combined')
  console.log(
    `  ${label.padEnd(15)} n=${String(count).padStart(3)}  ${parts.join('  ')}  ` +
      `(combined up on ${improved}/${count})`,
  )
  const ratios = ['delayMoves', 'combined'].map((metric) => {
    const { average, sem } = pairedRatioStats(entries, metric)
    const significance = Math.abs(average) > 2 * sem ? '*' : ' '
    const percent = (value) => `${(value * 100).toFixed(1)}%`
    return (
      `${metric}=${average >= 0 ? '+' : ''}${percent(average)}±${percent(sem)}${significance}` +
      ` rank z=${signedRankZ(entries, metric).toFixed(2)}`
    )
  })
  console.log(`  ${'(relative)'.padEnd(15)}${' '.repeat(8)}${ratios.join('   ')}`)
}
console.log('\n  * = the change is more than two standard errors from zero')
console.log(
  '  The "relative" line is the same paired comparison as a per-puzzle ratio, which is\n' +
    '  much less at the mercy of a few very long playouts — trust it over the raw means,\n' +
    '  and expect a real change to move the rank z (|z| > 2) with it.',
)
