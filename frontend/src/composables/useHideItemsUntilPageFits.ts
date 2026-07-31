import { onMounted, onUnmounted, ref, watch, type Ref } from 'vue'

// How much room beyond the item's own height must be free before it is shown again, so a
// restored item cannot immediately overflow the page and be hidden right back.
const RESTORE_MARGIN_PX = 12

// How far the page's actual content reaches, in document coordinates. Deliberately not
// `documentElement.scrollHeight`: `body` has a `min-height: 100vh`, which pins the scroll
// height to the viewport and hides exactly the information needed here — how much room is
// left over once the content fits.
function measureContentBottom(): number {
  let bottom = 0
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement)) continue
    bottom = Math.max(bottom, child.getBoundingClientRect().bottom + window.scrollY)
  }
  return bottom
}

/**
 * Progressively hides a page's least important items while the page would otherwise scroll
 * vertically — the caller keeps its items in a priority order and drops the first
 * `hiddenItemCount` of them.
 *
 * The height an item actually frees is measured (as the drop in the page's content height)
 * rather than read off the element, so margins, gaps and collapsed spacing are accounted
 * for exactly; restoring an item only happens once that much room, plus a margin, is free
 * again.
 */
export function useHideItemsUntilPageFits(
  itemCount: number,
  enabled: Ref<boolean>,
): { hiddenItemCount: Ref<number> } {
  const hiddenItemCount = ref(0)
  const heightFreedByHiding: number[] = Array.from({ length: itemCount }, () => 0)

  // Set while an item was just hidden but the browser has not laid the page out again, so
  // the space it freed can be measured on the next check.
  let pendingHiddenIndex: number | null = null
  let contentBottomBeforeHiding = 0
  let recheckHandle: number | undefined

  function scheduleRecheck(): void {
    if (recheckHandle !== undefined) return
    recheckHandle = requestAnimationFrame(() => {
      recheckHandle = undefined
      update()
    })
  }

  function update(): void {
    if (!enabled.value) return
    const contentBottom = measureContentBottom()

    if (pendingHiddenIndex !== null) {
      heightFreedByHiding[pendingHiddenIndex] = Math.max(
        0,
        contentBottomBeforeHiding - contentBottom,
      )
      pendingHiddenIndex = null
    }

    const overflow = contentBottom - document.documentElement.clientHeight
    if (overflow > 1) {
      if (hiddenItemCount.value >= itemCount) return
      pendingHiddenIndex = hiddenItemCount.value
      contentBottomBeforeHiding = contentBottom
      hiddenItemCount.value++
      scheduleRecheck()
    } else if (hiddenItemCount.value > 0) {
      const roomNeeded = heightFreedByHiding[hiddenItemCount.value - 1] ?? 0
      if (-overflow >= roomNeeded + RESTORE_MARGIN_PX) {
        hiddenItemCount.value--
        scheduleRecheck()
      }
    }
  }

  const observer =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => scheduleRecheck())

  watch(enabled, (isEnabled) => {
    if (isEnabled) scheduleRecheck()
    // The page went away before the pending measurement could be taken; a delta measured
    // against whatever is on screen now would be meaningless.
    else pendingHiddenIndex = null
  })

  onMounted(() => {
    observer?.observe(document.body)
    window.addEventListener('resize', scheduleRecheck)
    window.visualViewport?.addEventListener('resize', scheduleRecheck)
    scheduleRecheck()
  })

  onUnmounted(() => {
    observer?.disconnect()
    window.removeEventListener('resize', scheduleRecheck)
    window.visualViewport?.removeEventListener('resize', scheduleRecheck)
    if (recheckHandle !== undefined) cancelAnimationFrame(recheckHandle)
  })

  return { hiddenItemCount }
}
