import { createSamplePlayer } from './useSamplePlayer'
import captureUrl from '@/assets/sounds/capture.mp3'
import castleUrl from '@/assets/sounds/castle.mp3'
import checkUrl from '@/assets/sounds/check.mp3'
import checkmateUrl from '@/assets/sounds/checkmate.mp3'
import moveUrl from '@/assets/sounds/move.mp3'
import promoteUrl from '@/assets/sounds/promote.mp3'

export type BoardSound = 'move' | 'capture' | 'castle' | 'check' | 'promote' | 'checkmate'

const player = createSamplePlayer<BoardSound>(
  {
    move: moveUrl,
    capture: captureUrl,
    castle: castleUrl,
    check: checkUrl,
    promote: promoteUrl,
    checkmate: checkmateUrl,
  },
  { move: 0.35, capture: 0.35, castle: 0.35, check: 0.35, promote: 0.35, checkmate: 0.35 },
)

export function useBoardAudio() {
  return { play: player.play }
}
