let ctx: AudioContext | null = null

export function getAudioContext(): AudioContext {
  ctx ??= new AudioContext()
  return ctx
}

// Only call this from a user-gesture-triggered code path (e.g. a move or a
// puzzle result), never during preloading — resuming outside a gesture is
// blocked by browsers and logs a console warning.
export function resumeAudioContext(): void {
  if (ctx && ctx.state === 'suspended') void ctx.resume()
}
