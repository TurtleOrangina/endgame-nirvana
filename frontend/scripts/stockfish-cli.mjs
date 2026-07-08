#!/usr/bin/env node
// Runs the bundled Stockfish WASM build (public/engines/) as an interactive UCI CLI,
// exactly like a compiled stockfish binary: `node scripts/stockfish-cli.mjs`, then type
// commands (or pipe them in). The engine file already contains a Node CLI mode with
// readline + tab completion, but it is CommonJS and this package declares
// "type": "module", so Node refuses to run it in place. We stage it under a .cjs name
// (with the .wasm beside it, where the engine expects it) and run that as the main module.
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const engineDir = join(frontendDir, 'public', 'engines')
const stageDir = join(frontendDir, 'node_modules', '.cache', 'stockfish-cli')

function stage(sourceName, stagedName) {
  const source = join(engineDir, sourceName)
  const staged = join(stageDir, stagedName)
  const isStale = !existsSync(staged) || statSync(staged).mtimeMs < statSync(source).mtimeMs
  if (isStale) copyFileSync(source, staged)
  return staged
}

mkdirSync(stageDir, { recursive: true })
const stagedEngine = stage('stockfish-18-lite-single.js', 'stockfish.cjs')
stage('stockfish-18-lite-single.wasm', 'stockfish.wasm')

// Extra argv entries are forwarded — the engine treats them as initial UCI commands,
// e.g. `node scripts/stockfish-cli.mjs uci "go depth 10"`
const child = spawn(process.execPath, [stagedEngine, ...process.argv.slice(2)], {
  stdio: 'inherit',
})
child.on('exit', (code) => process.exit(code ?? 0))
