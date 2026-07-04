import { onUnmounted, watch, type Ref } from 'vue'

// The Wake Lock API releases the lock automatically whenever the tab is
// hidden, so it must be re-acquired on visibilitychange or it silently
// stays off after the user switches apps and comes back.
export function useWakeLock(active: Ref<boolean>): void {
  let sentinel: WakeLockSentinel | null = null

  async function acquire(): Promise<void> {
    if (!active.value || document.hidden || sentinel) return
    if (!('wakeLock' in navigator)) return
    try {
      sentinel = await navigator.wakeLock.request('screen')
      sentinel.addEventListener('release', () => {
        sentinel = null
      })
    } catch {
      sentinel = null
    }
  }

  async function release(): Promise<void> {
    const current = sentinel
    sentinel = null
    await current?.release()
  }

  function handleVisibilityChange(): void {
    if (document.hidden) return
    void acquire()
  }

  watch(
    active,
    (isActive) => {
      if (isActive) void acquire()
      else void release()
    },
    { immediate: true },
  )

  document.addEventListener('visibilitychange', handleVisibilityChange)

  onUnmounted(() => {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    void release()
  })
}
