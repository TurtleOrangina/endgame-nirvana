import { Chess } from 'chess.js'
import type { PlayerColor } from '@/types'
import type { StockfishEngine } from '@/composables/useStockfishEngine'
import { TEMPERATURE, useMoveSelector } from '@/composables/useMoveSelector'
import { uciToMoveArgs } from '@/utils/chess'
import type { RawTablebaseMove, RawTablebasePosition, TablebaseClient } from './tablebaseClient'

// A playout that never mates is a bug in the harness, not a resistance result, so it is
// cut off rather than left to spin. Even the longest 6-man mates stay far below this.
const MAX_PLIES = 400

export type PlayoutOutcome =
  | 'checkmate'
  | 'stalemate'
  | 'insufficient-material'
  | 'engine-gave-no-move'
  | 'position-not-won'
  | 'ply-limit-reached'

/**
 * One defensive move, with the distance to mate the user was looking at before and after
 * it.
 *
 * `dtmBeforeUserMove` is the mate distance in the position where the user is to move.
 * The user then plays a shortest-mate move and the defender replies, so with a perfect
 * defense the user's next position shows exactly `dtmBeforeUserMove - 2`
 * (`bestPossibleDtm`). Anything less is resistance the defender gave up.
 */
export interface DefensiveMoveRecord {
  ply: number
  defenderSan: string
  dtmBeforeUserMove: number
  bestPossibleDtm: number
  dtmAfterDefense: number
  // Share of the still-available mate distance the defense threw away, in [0, 1]
  fractionLost: number
}

export interface PlayoutResult {
  outcome: PlayoutOutcome
  // Mate distance in the starting position — the ply count a perfect defense would force
  optimalPlyCount: number
  actualPlyCount: number
  defensiveMoves: DefensiveMoveRecord[]
  // True when shortest-mate play ran past the 50-move rule, which distance-to-mate
  // ignores: the win is real but the app (and FIDE) would call the game drawn
  exceededFiftyMoveRule: boolean
}

function isLosingForSideToMove(category: string | undefined): boolean {
  return category === 'loss' || category === 'syzygy-loss' || category === 'maybe-loss'
}

// The move that mates fastest. Move categories describe the *resulting* position, so the
// moves worth considering are the ones leaving the opponent lost; among those, `dtm` is
// negative and the one closest to zero is the shortest mate.
function shortestMateMove(position: RawTablebasePosition): RawTablebaseMove | null {
  const mating = (position.moves ?? []).find((move) => move.checkmate)
  if (mating) return mating
  const losing = (position.moves ?? []).filter(
    (move) => isLosingForSideToMove(move.category) && typeof move.dtm === 'number',
  )
  if (losing.length === 0) return null
  return losing.reduce((best, move) => (move.dtm! > best.dtm! ? move : best))
}

export interface PlayoutOptions {
  fen: string
  tablebase: TablebaseClient
  engine: StockfishEngine
  // Matches the board's rated-attempt setting by default; the runner can vary it to see
  // how much of the measured resistance comes from the sampling temperature alone.
  temperature?: number
}

/**
 * Plays one puzzle out with the app's own move selection as the defender and perfect
 * shortest-mate tablebase play as the user, recording how much mate distance the defense
 * conceded on every move.
 */
export async function playOutPuzzle({
  fen,
  tablebase,
  engine,
  temperature = TEMPERATURE,
}: PlayoutOptions): Promise<PlayoutResult> {
  const moveSelector = useMoveSelector(engine)
  const chess = new Chess(fen)
  const playerColor: PlayerColor = chess.turn() === 'w' ? 'white' : 'black'
  const playedMoves: string[] = []
  const defensiveMoves: DefensiveMoveRecord[] = []

  const startPosition = await tablebase.lookup(fen)
  const optimalPlyCount = startPosition.dtm ?? 0
  if (optimalPlyCount <= 0) {
    return {
      outcome: 'position-not-won',
      optimalPlyCount,
      actualPlyCount: 0,
      defensiveMoves,
      exceededFiftyMoveRule: false,
    }
  }

  let userPosition = startPosition
  let exceededFiftyMoveRule = false
  // Filled in by the next iteration, once the user's new mate distance is known
  let pendingDefense: Omit<DefensiveMoveRecord, 'dtmAfterDefense' | 'fractionLost'> | null = null

  const finish = (outcome: PlayoutOutcome): PlayoutResult => ({
    outcome,
    optimalPlyCount,
    actualPlyCount: playedMoves.length,
    defensiveMoves,
    exceededFiftyMoveRule,
  })

  while (playedMoves.length < MAX_PLIES) {
    const dtmBeforeUserMove = userPosition.dtm ?? 0

    if (pendingDefense) {
      const { bestPossibleDtm } = pendingDefense
      defensiveMoves.push({
        ...pendingDefense,
        dtmAfterDefense: dtmBeforeUserMove,
        // Clamped at 0: a defense can never do better than the theoretical best, but
        // rounding at the tablebase's edge cases must not produce a negative "loss"
        fractionLost:
          bestPossibleDtm > 0
            ? Math.max(0, (bestPossibleDtm - dtmBeforeUserMove) / bestPossibleDtm)
            : 0,
      })
      pendingDefense = null
    }

    // --- The user: perfect, shortest-mate tablebase play ---
    const userMove = shortestMateMove(userPosition)
    if (!userMove) return finish('position-not-won')
    chess.move(uciToMoveArgs(userMove.uci))
    playedMoves.push(userMove.uci)
    if (chess.isCheckmate()) return finish('checkmate')
    if (chess.isStalemate()) return finish('stalemate')
    if (chess.isInsufficientMaterial()) return finish('insufficient-material')

    // --- The defender: the app's own move selection, driven exactly as the board does ---
    const defenderFen = chess.fen()
    // Move selection kicks its tablebase query off without awaiting it and uses the answer
    // only if it beats the engine search. In the browser that request takes well under the
    // engine's budget and normally wins; here it would queue behind this harness's
    // deliberate ~1s request spacing and almost always lose, quietly measuring an
    // engine-only defender. Warming the cache first restores the app's actual behaviour.
    await tablebase.lookup(defenderFen)
    const selection = await moveSelector.getBestMove(fen, playedMoves, defenderFen, {
      temperature,
      isPremove: false,
      playerColor,
      queryTablebase: true,
    })
    if (!selection.bestmove) return finish('engine-gave-no-move')

    const defenderMove = chess.move(uciToMoveArgs(selection.bestmove))
    playedMoves.push(selection.bestmove)
    pendingDefense = {
      ply: playedMoves.length,
      defenderSan: defenderMove.san,
      dtmBeforeUserMove,
      bestPossibleDtm: dtmBeforeUserMove - 2,
    }
    if (chess.isCheckmate()) return finish('checkmate')
    if (chess.isStalemate()) return finish('stalemate')
    if (chess.isInsufficientMaterial()) return finish('insufficient-material')
    if (Number(chess.fen().split(' ')[4] ?? 0) >= 100) exceededFiftyMoveRule = true

    userPosition = await tablebase.lookup(chess.fen())
  }

  return finish('ply-limit-reached')
}
