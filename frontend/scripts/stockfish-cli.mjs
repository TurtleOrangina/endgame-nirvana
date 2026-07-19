#!/usr/bin/env node
// Runs the bundled Stockfish WASM build (public/engines/) as an interactive UCI CLI,
// exactly like a compiled stockfish binary: `node scripts/stockfish-cli.mjs`, then type
// commands (or pipe them in). The engine file already contains a Node CLI mode with
// readline + tab completion, but it is CommonJS and this package declares
// "type": "module", so Node refuses to run it in place. We stage it under a .cjs name
// (with the .wasm beside it, where the engine expects it) and run that as the main module.
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The multi-threaded build — the same one the app ships (in the browser it needs a
// cross-origin isolated context, but under Node worker_threads are always available).
// Threads default to the app's defaultEngineThreads() formula so CLI analysis runs on
// comparable compute to a training session; override with a `setoption` of your own.
const frontendDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const engineDir = join(frontendDir, 'node_modules', 'stockfish', 'bin')
const stageDir = join(frontendDir, 'node_modules', '.cache', 'stockfish-cli')

function stage(sourceName, stagedName) {
  const source = join(engineDir, sourceName)
  const staged = join(stageDir, stagedName)
  const isStale = !existsSync(staged) || statSync(staged).mtimeMs < statSync(source).mtimeMs
  if (isStale) copyFileSync(source, staged)
  return staged
}

mkdirSync(stageDir, { recursive: true })
// Staged names are build-specific (the engine finds its .wasm via its own basename) so
// the mtime-based staleness check can't keep a copy of a previously staged other build
const stagedEngine = stage('stockfish-18-lite.js', 'stockfish-mt.cjs')
stage('stockfish-18-lite.wasm', 'stockfish-mt.wasm')

// Mirrors defaultEngineThreads() in useStockfishEngine.ts (availableParallelism is the
// Node equivalent of navigator.hardwareConcurrency)
const defaultThreads = Math.min(8, Math.max(1, Math.floor(availableParallelism() / 2)))

// Extra argv entries are forwarded — the engine treats them as initial UCI commands,
// e.g. `node scripts/stockfish-cli.mjs uci "go depth 10"`
const child = spawn(
  process.execPath,
  [stagedEngine, `setoption name Threads value ${defaultThreads}`, ...process.argv.slice(2)],
  { stdio: 'inherit' },
)
child.on('exit', (code) => process.exit(code ?? 0))
