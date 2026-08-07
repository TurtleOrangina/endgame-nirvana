<script setup lang="ts">
import { useLocale } from '@/composables/useLocale'

// The chevron that folds a category's subcategories away, shown only on categories that
// have any. Click is stopped from reaching the row behind it, whose own click means
// something else entirely (select the category / show its puzzles).
defineProps<{ expanded: boolean }>()
const emit = defineEmits<{ toggle: [] }>()

const { t } = useLocale()
</script>

<template>
  <button
    class="expand-toggle"
    :class="{ expanded }"
    :title="expanded ? t((s) => s.common.collapse) : t((s) => s.common.expand)"
    @click.stop="emit('toggle')"
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  </button>
</template>

<style scoped>
.expand-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  margin-right: 0.2rem;
  margin-left: -0.2rem;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  padding: 0;
  border-radius: 3px;
  transition: color 0.1s;
}

.expand-toggle:hover {
  color: var(--fg);
}

.expand-toggle svg {
  width: 12px;
  height: 12px;
  transition: transform 0.1s;
}

.expand-toggle.expanded svg {
  transform: rotate(90deg);
}
</style>
