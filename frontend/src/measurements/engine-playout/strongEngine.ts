import { availableParallelism } from 'node:os'
import { NATIVE_STOCKFISH_PATH } from '@/measurements/shared/enginePaths'
import {
  createUciProcessEngine,
  type UciProcessEngine,
} from '@/measurements/shared/uciProcessEngine'
import {
  assertEngineBinaryExists,
  assertSyzygyTablebasesExist,
  SYZYGY_PATH,
} from '@/measurements/shared/enginePaths'

// Syzygy tablebases shipped alongside the native binary (resolved per machine in
// shared/enginePaths.ts). Unlike the defender (which mirrors the app and gets none), the
// "user" engine is meant to be as strong as possible: it stands in for a competent human,
// and perfect endgame knowledge is exactly what stops it from wandering in won positions
// and inflating the measured delay.
export { SYZYGY_PATH }

// Leaves cores for the WASM defender running in parallel. Startup cost is paid once —
// the process is kept alive for the whole run.
const DEFAULT_STRONG_THREADS = Math.max(1, Math.min(24, availableParallelism() - 8))
const STRONG_HASH_MB = 1024

// Long enough to see through most of these endgames — the deep single-variation search
// usually finds the underlying mate in the easier puzzles outright
export const USER_MOVE_THINKING_TIME_MS = 400
// The wide sweep that measures how many of the user's moves hold the result. Shallower per
// line, since what matters is the classification of each move, not its exact evaluation.
export const TRICKINESS_THINKING_TIME_MS = 200
export const TRICKINESS_MULTIPV = 64

export function createStrongEngine(
  binaryPath: string = NATIVE_STOCKFISH_PATH,
  threads: number = DEFAULT_STRONG_THREADS,
  syzygyPath: string = SYZYGY_PATH,
): UciProcessEngine {
  assertEngineBinaryExists(binaryPath)
  assertSyzygyTablebasesExist(syzygyPath)
  return createUciProcessEngine({
    command: binaryPath,
    threads,
    hashMb: STRONG_HASH_MB,
    syzygyPath,
  })
}

/**
 * The tables exist on disk — this confirms the engine actually took them, so a run can
 * never quietly measure against a tablebase-less "user". An engine that reports no count
 * at all only warns: that means a build whose load message we don't recognize, not a
 * misconfiguration, and the on-disk check has already ruled out the failure that matters.
 */
export async function assertStrongEngineLoadedSyzygy(
  engine: UciProcessEngine,
  syzygyPath: string = SYZYGY_PATH,
): Promise<void> {
  await engine.waitForReady()
  const fileCount = engine.loadedSyzygyFileCount()
  if (fileCount === null) {
    console.warn(
      `Warning: the engine never reported loading Syzygy tables, so tablebase access ` +
        `could not be confirmed. Tables are present at ${syzygyPath}.`,
    )
    return
  }
  if (fileCount === 0) {
    throw new Error(
      `The engine loaded 0 Syzygy tablebase files from ${syzygyPath}.\n` +
        `The tables are on disk but the engine rejected the path — check it is readable ` +
        `and contains uncorrupted .rtbw/.rtbz files.`,
    )
  }
  console.log(`Syzygy: ${fileCount} WDL files loaded from ${syzygyPath}`)
}

export const DEFAULT_STRONG_ENGINE_THREADS = DEFAULT_STRONG_THREADS
