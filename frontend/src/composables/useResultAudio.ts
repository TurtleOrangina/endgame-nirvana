import { createSamplePlayer } from './useSamplePlayer'
import successUrl from '@/assets/sounds/success.mp3'
import failureUrl from '@/assets/sounds/failure.mp3'

type ResultSound = 'success' | 'failure'

const player = createSamplePlayer<ResultSound>(
  {
    success: successUrl,
    failure: failureUrl,
  },
  { success: 0.08, failure: 0.08 },
)

export function useResultAudio() {
  function playSuccessSound(): void {
    player.play('success')
  }

  function playFailureSound(): void {
    player.play('failure')
  }

  return { playSuccessSound, playFailureSound }
}
