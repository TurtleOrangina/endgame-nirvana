import wP from '@/assets/pieces-maestro/wP.svg'
import wN from '@/assets/pieces-maestro/wN.svg'
import wB from '@/assets/pieces-maestro/wB.svg'
import wR from '@/assets/pieces-maestro/wR.svg'
import wQ from '@/assets/pieces-maestro/wQ.svg'
import wK from '@/assets/pieces-maestro/wK.svg'
import bP from '@/assets/pieces-maestro/bP.svg'
import bN from '@/assets/pieces-maestro/bN.svg'
import bB from '@/assets/pieces-maestro/bB.svg'
import bR from '@/assets/pieces-maestro/bR.svg'
import bQ from '@/assets/pieces-maestro/bQ.svg'
import bK from '@/assets/pieces-maestro/bK.svg'
import chessBoard from '@/assets/chess-board.svg'

// Piece images are only fetched by the browser once a piece actually appears on the
// board via its CSS class (see pieces-maestro.css), so a puzzle whose starting position
// happens to lack e.g. a black queen would leave bQ.svg undownloaded — invisible if the
// user goes offline before ever encountering one. Preloading every piece up front (they're
// tiny) means the full set is always cached well before it's needed.
const ESSENTIAL_IMAGE_URLS = [wP, wN, wB, wR, wQ, wK, bP, bN, bB, bR, bQ, bK, chessBoard]

export function preloadEssentialImages(): void {
  for (const url of ESSENTIAL_IMAGE_URLS) {
    const image = new Image()
    image.src = url
  }
}
