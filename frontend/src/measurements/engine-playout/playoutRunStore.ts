import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { PlayoutPuzzle } from './playoutPuzzleSelection'
import type { PuzzleMeasurement } from './report'

/**
 * The per-run detail file: one JSON line per finished puzzle, headed by the run's own
 * configuration. It serves two purposes at once, which is why it is written as it goes
 * rather than dumped at the end:
 *
 * - it is the per-ply record behind every number in the baseline (what the divergence study
 *   lifts positions out of), far too large and churn-prone to commit;
 * - it is what `--continue` resumes from. A puzzle's playouts are appended only once they
 *   have finished, so a run killed mid-puzzle simply replays that one puzzle.
 *
 * A puzzle may appear on more than one line: raising `--playouts` and continuing appends the
 * additional playouts as their own row rather than rewriting the earlier one, so the file
 * stays append-only and a top-up is as interruptible as a first run. Rows are concatenated
 * per puzzle on read.
 *
 * Gitignored, and kept out of the repo root — a run leaves nothing behind that the user has
 * to notice and clean up.
 */
export const RUN_DETAIL_DIR = '.playout-runs'

// Bumped when the row shape changes in a way that makes older files unresumable
const FORMAT_VERSION = 1

export interface RunHeader {
  version: number
  defender: string
  puzzleSet: string
  seed: number
  // What the file was started with, not what it currently holds: a top-up appends playouts
  // without rewriting the header, and resuming only needs this as a floor (see describeMismatch)
  playoutsPerPuzzle: number
  // Identifies the puzzle set by content: resuming into a re-sampled set would silently mix
  // scores from two different sets, which no comparison could detect afterwards
  puzzleSetDigest: string
}

export function puzzleSetDigest(puzzles: PlayoutPuzzle[]): string {
  const fens = puzzles.map((puzzle) => puzzle.fen).join('\n')
  return createHash('sha1').update(fens).digest('hex').slice(0, 16)
}

export function runDetailPath(frontendRoot: string, baselineFile: string): string {
  const runName = baselineFile.replace(/^engine-playout-baseline/, 'run').replace(/\.yaml$/, '')
  return path.join(frontendRoot, RUN_DETAIL_DIR, `${runName}.jsonl`)
}

export interface PlayoutRunStore {
  // What earlier runs of this configuration already measured, one entry per puzzle with
  // every playout they recorded for it — empty unless resuming
  completed: PuzzleMeasurement[]
  /** Appends the playouts measured now; a puzzle topped up later gets a second row */
  append(measurement: PuzzleMeasurement): void
}

function describeMismatch(previous: RunHeader, current: RunHeader): string | null {
  if (previous.version !== current.version) return `format version ${previous.version}`
  const fields: (keyof RunHeader)[] = ['defender', 'puzzleSet', 'seed', 'puzzleSetDigest']
  const changed = fields.filter((field) => previous[field] !== current[field])
  // Asking for more playouts than the file holds is a top-up, not a mismatch: the extra
  // playouts are measured under the very configuration the earlier ones were. Asking for
  // fewer is refused — it would silently report a subset of what was measured.
  if (previous.playoutsPerPuzzle > current.playoutsPerPuzzle) changed.push('playoutsPerPuzzle')
  if (changed.length === 0) return null
  return changed.map((field) => `${field} ${previous[field]} → ${current[field]}`).join(', ')
}

/** Concatenates the playouts of every row a puzzle has, keeping the puzzle set's own order */
function mergeRows(rows: PuzzleMeasurement[]): PuzzleMeasurement[] {
  const byFen = new Map<string, PuzzleMeasurement>()
  for (const row of rows) {
    const merged = byFen.get(row.puzzle.fen)
    if (merged) merged.playouts = [...merged.playouts, ...row.playouts]
    else byFen.set(row.puzzle.fen, row)
  }
  return [...byFen.values()]
}

function readCompleted(filePath: string, header: RunHeader): PuzzleMeasurement[] {
  const [headerLine, ...rows] = readFileSync(filePath, 'utf8').split('\n')
  if (headerLine === undefined || headerLine.trim() === '') return []
  const mismatch = describeMismatch(JSON.parse(headerLine) as RunHeader, header)
  if (mismatch !== null) {
    throw new Error(
      `Cannot continue ${filePath}: it was recorded with a different configuration ` +
        `(${mismatch}). Re-run without --continue to start it over.`,
    )
  }
  const parsed = rows.flatMap((row, index) => {
    if (row.trim() === '') return []
    try {
      return [JSON.parse(row) as PuzzleMeasurement]
    } catch {
      // Only ever the last line, half-written when the run was killed — that puzzle is
      // simply replayed, which is what an interrupted puzzle gets anyway
      console.warn(`Ignoring an incomplete row ${index + 1} at the end of ${filePath}`)
      return []
    }
  })
  return mergeRows(parsed)
}

/**
 * Opens the run's detail file, either continuing it or starting it over. Truncating on a
 * fresh run is deliberate: a run that is not resuming must not inherit rows measured under
 * conditions it knows nothing about.
 */
export function openRunStore(
  filePath: string,
  header: RunHeader,
  resume: boolean,
): PlayoutRunStore {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const completed = resume && existsSync(filePath) ? readCompleted(filePath, header) : []
  if (completed.length === 0) writeFileSync(filePath, `${JSON.stringify(header)}\n`)
  return {
    completed,
    append: (measurement) => appendFileSync(filePath, `${JSON.stringify(measurement)}\n`),
  }
}

export function runHeaderFor(options: {
  defender: string
  puzzleSet: string
  seed: number
  playoutsPerPuzzle: number
  puzzles: PlayoutPuzzle[]
}): RunHeader {
  return {
    version: FORMAT_VERSION,
    defender: options.defender,
    puzzleSet: options.puzzleSet,
    seed: options.seed,
    playoutsPerPuzzle: options.playoutsPerPuzzle,
    puzzleSetDigest: puzzleSetDigest(options.puzzles),
  }
}
