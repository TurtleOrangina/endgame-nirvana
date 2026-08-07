import {
  computed,
  nextTick,
  onUnmounted,
  ref,
  watch,
  type ComponentPublicInstance,
  type ComputedRef,
  type Ref,
} from 'vue'

// How far below the viewport the sentinel already counts as reached, so the next chunk is
// mounted before the user scrolls into empty space.
const PREFETCH_MARGIN_PX = 600

/**
 * Reveals a long list one chunk at a time, growing whenever the caller's sentinel element
 * scrolls into view. Rendering hundreds of expensive items (each mini board builds its own
 * Chessground instance) in a single pass blocks the main thread for a noticeable moment;
 * mounting a chunk at a time keeps every step short.
 *
 * The caller renders `visibleItems` and puts `setSentinel` as the `:ref` of an element right
 * after them, shown while `hasMoreItems` is true.
 */
export function useProgressivelyRevealedItems<T>(
  allItems: Ref<T[]> | ComputedRef<T[]>,
  chunkSize: number,
): {
  visibleItems: ComputedRef<T[]>
  hasMoreItems: ComputedRef<boolean>
  setSentinel: (element: Element | ComponentPublicInstance | null) => void
} {
  const supportsObserver = typeof IntersectionObserver !== 'undefined'
  const visibleCount = ref(supportsObserver ? chunkSize : Number.POSITIVE_INFINITY)
  const sentinel = ref<Element | null>(null)

  const visibleItems = computed(() => allItems.value.slice(0, visibleCount.value))
  const hasMoreItems = computed(() => visibleCount.value < allItems.value.length)

  const observer = supportsObserver
    ? new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) revealNextChunk()
        },
        { rootMargin: `${PREFETCH_MARGIN_PX}px` },
      )
    : null

  function revealNextChunk(): void {
    if (!hasMoreItems.value) return
    visibleCount.value += chunkSize
    // Growing the list moves the sentinel down but fires no new intersection event, so a
    // sentinel still on screen (a chunk shorter than the viewport, or a fast scroll) would
    // stall. Re-observing re-delivers its current state.
    void nextTick(() => {
      if (!sentinel.value) return
      observer?.unobserve(sentinel.value)
      observer?.observe(sentinel.value)
    })
  }

  // A template ref inside a `v-for` is an array ref, so the sentinel is bound as a function
  // ref instead. Its unmount call (`null`) is ignored: when the list is swapped out, Vue may
  // mount the new sentinel before releasing the old one, and clearing then would drop the
  // live element. A detached element simply never intersects, and observing the next one
  // replaces it.
  function setSentinel(element: Element | ComponentPublicInstance | null): void {
    if (!(element instanceof Element) || element === sentinel.value) return
    if (sentinel.value) observer?.unobserve(sentinel.value)
    sentinel.value = element
    observer?.observe(element)
  }

  // A different list (another category, changed filters) starts over from the first chunk.
  watch(allItems, () => {
    if (supportsObserver) visibleCount.value = chunkSize
  })

  onUnmounted(() => observer?.disconnect())

  return { visibleItems, hasMoreItems, setSentinel }
}
