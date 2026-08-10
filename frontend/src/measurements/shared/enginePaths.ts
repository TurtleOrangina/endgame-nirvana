import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * Where the native Stockfish build and its Syzygy tables live. This differs between the
 * dev container and a host checkout, and the measurements are run from both, so the
 * directory is resolved rather than hardcoded: `STOCKFISH_ENGINES_DIR` wins, otherwise the
 * first known layout that exists on disk.
 */
const CANDIDATE_ENGINE_DIRS = [
  '/home/node/native_stockfish/engines',
  path.join(homedir(), '.stockfish', 'engines'),
]

export function resolveEnginesDir(): string {
  const configured = process.env.STOCKFISH_ENGINES_DIR
  if (configured) return configured
  return CANDIDATE_ENGINE_DIRS.find((dir) => existsSync(dir)) ?? CANDIDATE_ENGINE_DIRS[0]!
}

export const NATIVE_STOCKFISH_PATH = path.join(resolveEnginesDir(), 'stockfish_latest')
export const SYZYGY_PATH = path.join(resolveEnginesDir(), 'syzygy')

/**
 * Fails with the paths spelled out rather than letting a missing binary surface as a bare
 * spawn ENOENT an hour into a run — the measurement is long enough that a clear message at
 * startup is worth the check.
 */
export function assertEngineBinaryExists(binaryPath: string): void {
  if (existsSync(binaryPath)) return
  throw new Error(
    `No Stockfish binary at ${binaryPath}.\n` +
      `Point STOCKFISH_ENGINES_DIR at the directory holding stockfish_latest and syzygy/ ` +
      `(looked in: ${CANDIDATE_ENGINE_DIRS.join(', ')}), or pass --binary <path>.`,
  )
}

/**
 * Stockfish treats a `SyzygyPath` pointing nowhere as a non-event: it reports finding zero
 * tables and searches on without them. That silence is expensive here — the "user" engine
 * would wander in won positions, inflating the measured delay, and the run's hour of CPU
 * would end in a baseline that looks valid but is not comparable to the committed ones. So
 * the tables are checked before the engine is even spawned.
 */
export function assertSyzygyTablebasesExist(syzygyPath: string): void {
  const hasTableFiles =
    existsSync(syzygyPath) && readdirSync(syzygyPath).some((file) => file.endsWith('.rtbw'))
  if (hasTableFiles) return
  throw new Error(
    `No Syzygy tablebases at ${syzygyPath} (expected .rtbw files there).\n` +
      `Point STOCKFISH_ENGINES_DIR at the directory holding stockfish_latest and syzygy/ ` +
      `(looked in: ${CANDIDATE_ENGINE_DIRS.join(', ')}).`,
  )
}
