import { getAudioContext, resumeAudioContext } from './audioContext'

// Fetching is safe to do eagerly on mount, but decoding must wait for the first
// play(): decodeAudioData needs an AudioContext, and constructing one outside a
// user gesture makes the browser log an autoplay warning.
export function createSamplePlayer<TSound extends string>(urls: Record<TSound, string>) {
  const decodedBuffers = new Map<TSound, AudioBuffer>()
  const pendingLoads = new Map<TSound, Promise<void>>()
  const prefetchedData = new Map<TSound, Promise<ArrayBuffer>>()
  const pendingPlaysWhenLoaded = new Set<TSound>()

  function fetchSoundData(sound: TSound): Promise<ArrayBuffer> {
    return fetch(urls[sound]).then((response) => response.arrayBuffer())
  }

  function prefetchSound(sound: TSound): void {
    if (prefetchedData.has(sound)) return
    const fetched = fetchSoundData(sound)
    fetched.catch(() => {
      // Forget the failed fetch; a later play() attempt retries it
      prefetchedData.delete(sound)
    })
    prefetchedData.set(sound, fetched)
  }

  function loadSound(sound: TSound): Promise<void> {
    const pending = pendingLoads.get(sound)
    if (pending) return pending
    const load = (prefetchedData.get(sound) ?? fetchSoundData(sound))
      .then((data) => getAudioContext().decodeAudioData(data))
      .then((buffer) => {
        decodedBuffers.set(sound, buffer)
      })
      .catch(() => {
        // Leave the sound absent; a later play() attempt retries the load
        pendingLoads.delete(sound)
        prefetchedData.delete(sound)
      })
    pendingLoads.set(sound, load)
    return load
  }

  function playBuffer(buffer: AudioBuffer): void {
    resumeAudioContext()
    const ctx = getAudioContext()
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.start()
  }

  for (const sound of Object.keys(urls) as TSound[]) prefetchSound(sound)

  function play(sound: TSound): void {
    const buffer = decodedBuffers.get(sound)
    if (buffer) {
      playBuffer(buffer)
      return
    }
    // Multiple triggers can happen before a sound finishes its first load (e.g. while
    // network bandwidth is contended by the engine download) — coalesce them into a
    // single catch-up play instead of stacking one play per call, which would fire
    // all at once the moment the sound finally decodes.
    if (pendingPlaysWhenLoaded.has(sound)) return
    pendingPlaysWhenLoaded.add(sound)
    void loadSound(sound).then(() => {
      pendingPlaysWhenLoaded.delete(sound)
      const loaded = decodedBuffers.get(sound)
      if (loaded) playBuffer(loaded)
    })
  }

  return { play }
}
