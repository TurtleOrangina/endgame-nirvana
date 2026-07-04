import { Chess } from 'chess.js'

const FIGURINES: Record<string, string> = {
  K: '♔',
  Q: '♕',
  R: '♖',
  B: '♗',
  N: '♘',
}

export function toFigurineSan(san: string): string {
  return san.replace(/^[KQRBN]/, (c) => FIGURINES[c] ?? c)
}

export function uciLineToPretty(fen: string, uciMoves: string[]): string[] {
  // Normalize fullmove number to 1 so every puzzle line starts at move 1
  const parts = fen.split(' ')
  parts[5] = '1'
  const chess = new Chess(parts.join(' '))
  const result: string[] = []
  let needsBlackEllipsis = chess.turn() === 'b'

  for (const uci of uciMoves) {
    try {
      const turn = chess.turn()
      const moveNum = chess.moveNumber()
      const move = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4] as 'q' | 'r' | 'n' | 'b' | undefined,
      })
      if (turn === 'w') {
        result.push(`${moveNum}.`)
      } else if (needsBlackEllipsis) {
        result.push(`${moveNum}...`)
        needsBlackEllipsis = false
      }
      result.push(toFigurineSan(move.san))
    } catch {
      break
    }
  }
  return result
}
