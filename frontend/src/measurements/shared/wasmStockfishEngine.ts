import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { createUciProcessEngine, type UciProcessEngine } from './uciProcessEngine'

// The engine file already contains a Node CLI mode with readline + tab completion, but it
// is CommonJS and this package declares "type": "module", so Node refuses to run it in
// place. We stage it under a .cjs name (with the .wasm beside it, where the engine expects
// it) and run that as the main module.
const ENGINE_SOURCE_NAME = 'stockfish-18-lite'
// Staged names are build-specific (the engine finds its .wasm via its own basename) so the
// mtime-based staleness check can't keep a copy of a previously staged other build
const STAGED_NAME = 'stockfish-mt'

/**
 * Stages the bundled multi-threaded Stockfish WASM build — the exact one the app ships —
 * so Node can run it, and returns the path to the staged entry point. In the browser this
 * build needs a cross-origin isolated context; under Node worker_threads are always
 * available.
 */
export function stageWasmStockfish(frontendRoot: string): string {
  const engineDir = join(frontendRoot, 'node_modules', 'stockfish', 'bin')
  const stageDir = join(frontendRoot, 'node_modules', '.cache', 'stockfish-cli')
  mkdirSync(stageDir, { recursive: true })

  const stage = (sourceName: string, stagedName: string): string => {
    const source = join(engineDir, sourceName)
    const staged = join(stageDir, stagedName)
    const isStale = !existsSync(staged) || statSync(staged).mtimeMs < statSync(source).mtimeMs
    if (isStale) copyFileSync(source, staged)
    return staged
  }

  const stagedEngine = stage(`${ENGINE_SOURCE_NAME}.js`, `${STAGED_NAME}.cjs`)
  stage(`${ENGINE_SOURCE_NAME}.wasm`, `${STAGED_NAME}.wasm`)
  return stagedEngine
}

// Mirrors defaultEngineThreads() in useStockfishEngine.ts (availableParallelism is the
// Node equivalent of navigator.hardwareConcurrency), so a measured search runs on
// comparable compute to a training session in the browser
export function defaultWasmEngineThreads(): number {
  return Math.min(8, Math.max(1, Math.floor(availableParallelism() / 2)))
}

/**
 * The defender engine for the engine-playout measurement: the *shipped* WASM lite build,
 * not the native binary, so what the measurement grades is the opponent users actually
 * face — same net, same speed class, and (like the browser) no Syzygy access.
 */
export function createWasmStockfishEngine(
  frontendRoot: string,
  threads: number = defaultWasmEngineThreads(),
): UciProcessEngine {
  return createUciProcessEngine({
    command: process.execPath,
    args: [stageWasmStockfish(frontendRoot)],
    threads,
  })
}
