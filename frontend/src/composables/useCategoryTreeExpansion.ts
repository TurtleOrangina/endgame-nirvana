import { computed, ref, type Ref } from 'vue'
import type { CategoryOption } from '@/stores/exercises'

export interface ExpandableCategoryOption extends CategoryOption {
  hasChildren: boolean
}

// Every ancestor path prefix of a category value, e.g. "A/B/C" -> ["A", "A/B"].
export function ancestorsOf(value: string | null): string[] {
  if (!value) return []
  const prefixes: string[] = []
  let prefix = ''
  for (const segment of value.split('/').slice(0, -1)) {
    prefix = prefix ? `${prefix}/${segment}` : segment
    prefixes.push(prefix)
  }
  return prefixes
}

/**
 * Collapsible-tree state over a depth-first flattened category list (see the store's
 * `flattenCategoryTree`). Categories start folded, which is what keeps the training view's
 * category dropdown short enough to be a dropdown.
 */
export function useCategoryTreeExpansion(options: Ref<CategoryOption[]>) {
  const expandedCategories = ref<Set<string>>(new Set())

  function isExpanded(value: string): boolean {
    return expandedCategories.value.has(value)
  }

  function toggleCategoryExpanded(value: string): void {
    const next = new Set(expandedCategories.value)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    expandedCategories.value = next
  }

  // Unfolds the tree far enough for `value`'s row to be on screen — e.g. the category that
  // is currently selected, which would otherwise sit invisible inside a folded ancestor.
  function expandDownTo(value: string | null): void {
    expandedCategories.value = new Set([...expandedCategories.value, ...ancestorsOf(value)])
  }

  // Collapsing a node hides every following option whose depth is greater than that node's,
  // until we come back out to its own depth or shallower.
  const visibleOptions = computed((): ExpandableCategoryOption[] => {
    const all = options.value
    const result: ExpandableCategoryOption[] = []
    let collapseFromDepth: number | null = null
    for (const [index, option] of all.entries()) {
      if (collapseFromDepth !== null && option.depth > collapseFromDepth) continue
      collapseFromDepth = null
      const hasChildren = (all[index + 1]?.depth ?? -1) > option.depth
      result.push({ ...option, hasChildren })
      if (hasChildren && !isExpanded(option.value)) collapseFromDepth = option.depth
    }
    return result
  })

  return { isExpanded, toggleCategoryExpanded, expandDownTo, visibleOptions }
}
