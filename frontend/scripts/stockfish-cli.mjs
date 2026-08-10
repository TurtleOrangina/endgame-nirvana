#!/usr/bin/env node
// Runs the bundled Stockfish WASM build (the one the app ships) as an interactive UCI CLI,
// exactly like a compiled stockfish binary: `node scripts/stockfish-cli.mjs`, then type
// commands (or pipe them in). The staging that makes the CommonJS engine runnable under
// this ESM package lives in src/measurements/shared/wasmStockfishEngine.ts, shared with
// the engine-playout measurement so both run the identical binary.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const jiti = createJiti(import.meta.url, { alias: { '@': join(frontendRoot, 'src') } })
const { stageWasmStockfish, defaultWasmEngineThreads } = await jiti.import(
  '../src/measurements/shared/wasmStockfishEngine.ts',
)

const stagedEngine = stageWasmStockfish(frontendRoot)

// Extra argv entries are forwarded — the engine treats them as initial UCI commands,
// e.g. `node scripts/stockfish-cli.mjs uci "go depth 10"`
const child = spawn(
  process.execPath,
  [
    stagedEngine,
    `setoption name Threads value ${defaultWasmEngineThreads()}`,
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
)
child.on('exit', (code) => process.exit(code ?? 0))
