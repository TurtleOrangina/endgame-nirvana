import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { useMoveSelector } from '@/composables/useMoveSelector'
import { MIN_TEMPERATURE } from '@/utils/weightedSample'
import { countPieces } from '@/measurements/shared/puzzleCatalog'
import { createWasmStockfishEngine } from '@/measurements/shared/wasmStockfishEngine'
import { createTablebaseClient } from '@/measurements/shared/tablebaseClient'
import { formatYaml, type YamlValue } from './yaml'
import { SELECTOR_TUNINGS, type DefenderKind } from './enginePlayout'
import { MAX_TABLEBASE_MEN, type PlayoutPuzzle } from './playoutPuzzleSelection'

/**
 * Builds a puzzle set of exactly the positions where two defenders would play differently.
 *
 * A full run spends most of its hour on positions where a selector change picks the same
 * move it always did; those playouts differ only by engine noise, and averaging them in is
 * what makes a real effect hard to see. Restricting the measurement to the positions where
 * the change actually bites keeps the signal and drops the noise, at the cost of scores that
 * mean nothing outside this set — the positions are picked *because* they are contentious.
 *
 * The two defenders are asked at MIN_TEMPERATURE, so "would play differently" is about the
 * weighting rather than about the dice. Positions are lifted out of a previous run's
 * recorded playouts, and written with `defenderToMoveFirst` so playing one out resumes
 * exactly where the disagreement is.
 */

// Positions come from a run that already happened, so a defender ply is only a candidate if
// there was still a game left to play after it — scoring the disagreement needs room for the
// defense to last longer or shorter
const LATEST_USABLE_PLY_FRACTION = 0.6

export interface DivergenceOptions {
  frontendRoot: string
  // Per-ply detail of the run to lift positions from (engine-playout-detail*.json)
  detailFile: string
  baselineKind: DefenderKind
  variantKind: DefenderKind
  outputFile: string
  positionsPerPlayout: number
  // Only puzzles whose defender the change can reach. The rollout delayer, for instance,
  // never fires where a tablebase settles the position.
  manyMenOnly: boolean
  goal: string | null
}

interface CandidatePosition {
  puzzle: PlayoutPuzzle
  fen: string
}

interface DetailPly {
  side: 'user' | 'defender'
  fenBefore: string
}

interface DetailMeasurement {
  puzzle: PlayoutPuzzle
  playouts: { plies: DetailPly[] }[]
}

// Evenly spaced defender-to-move positions from the first part of each recorded playout, so
// one long playout can't dominate the set
function collectCandidatePositions(
  measurements: DetailMeasurement[],
  options: DivergenceOptions,
): CandidatePosition[] {
  const seenFens = new Set<string>()
  const candidates: CandidatePosition[] = []
  for (const measurement of measurements) {
    const { puzzle } = measurement
    if (options.goal !== null && puzzle.goal !== options.goal) continue
    if (options.manyMenOnly && puzzle.men <= MAX_TABLEBASE_MEN) continue
    for (const playout of measurement.playouts) {
      const defenderPlies = playout.plies.filter((ply) => ply.side === 'defender')
      const usable = defenderPlies.slice(
        0,
        Math.max(1, Math.floor(defenderPlies.length * LATEST_USABLE_PLY_FRACTION)),
      )
      const step = Math.max(1, Math.floor(usable.length / options.positionsPerPlayout))
      for (let i = 0; i < usable.length; i += step) {
        const fen = usable[i]!.fenBefore
        if (seenFens.has(fen)) continue
        seenFens.add(fen)
        candidates.push({ puzzle, fen })
      }
    }
  }
  return candidates
}

export interface DivergenceResult {
  candidates: number
  divergent: number
  outputPath: string
}

export async function findDivergentPositions(
  options: DivergenceOptions,
): Promise<DivergenceResult> {
  const measurements = JSON.parse(
    readFileSync(path.join(options.frontendRoot, options.detailFile), 'utf8'),
  ) as DetailMeasurement[]
  const candidates = collectCandidatePositions(measurements, options)

  const tablebase = createTablebaseClient(path.join(options.frontendRoot, '.tablebase-cache'))
  tablebase.installFetchInterception()
  const engine = createWasmStockfishEngine(options.frontendRoot)
  await engine.waitForReady()

  const selectors = [options.baselineKind, options.variantKind].map((kind) =>
    useMoveSelector(engine, SELECTOR_TUNINGS[kind]),
  )

  const divergent: PlayoutPuzzle[] = []
  const originalLog = console.log
  try {
    for (const [index, candidate] of candidates.entries()) {
      const userColor = candidate.fen.split(' ')[1] === 'w' ? 'black' : 'white'
      const selectOptions = {
        temperature: MIN_TEMPERATURE,
        isPremove: false,
        playerColor: userColor as 'white' | 'black',
        queryTablebase: countPieces(candidate.fen) <= MAX_TABLEBASE_MEN + 1,
      }
      if (selectOptions.queryTablebase) await tablebase.lookup(candidate.fen)

      console.log = () => {}
      const moves: (string | null)[] = []
      for (const selector of selectors) {
        moves.push(
          (await selector.getBestMove(candidate.fen, [], candidate.fen, selectOptions)).bestmove,
        )
      }
      console.log = originalLog

      const [baselineMove, variantMove] = moves
      if (baselineMove !== null && variantMove !== null && baselineMove !== variantMove) {
        divergent.push({
          fen: candidate.fen,
          categoryPath: candidate.puzzle.categoryPath,
          goal: candidate.puzzle.goal,
          difficulty: candidate.puzzle.difficulty,
          men: countPieces(candidate.fen),
          defenderToMoveFirst: true,
        })
      }
      if ((index + 1) % 25 === 0) {
        originalLog(
          `  ${index + 1}/${candidates.length} positions probed, ${divergent.length} divergent`,
        )
      }
    }
  } finally {
    console.log = originalLog
    engine.quit()
  }

  const outputPath = path.join(options.frontendRoot, options.outputFile)
  const rows: YamlValue = divergent.map((puzzle) => ({ ...puzzle }))
  writeFileSync(
    outputPath,
    `# Positions where ${options.variantKind} plays a different move from ` +
      `${options.baselineKind}, at minimum temperature.\n` +
      '# Generated by scripts/find-move-divergence.mjs — scores on this set are only\n' +
      '# comparable to other runs on the same set, never to a full-catalog baseline.\n' +
      formatYaml({ count: divergent.length, puzzles: rows }),
  )
  return { candidates: candidates.length, divergent: divergent.length, outputPath }
}
