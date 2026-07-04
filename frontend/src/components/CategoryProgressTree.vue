<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CategoryProgressNode } from '@/stores/exercises'
import CategoryProgressBar from '@/components/CategoryProgressBar.vue'

const props = defineProps<{
  nodes: CategoryProgressNode[]
}>()

// Only depth-0 nodes are open by default; toggling a node flips it relative to that default,
// so this set holds "nodes whose open state differs from the default" rather than "open nodes".
const toggledValues = ref(new Set<string>())

function isOpen(node: CategoryProgressNode): boolean {
  return node.depth === 0
    ? !toggledValues.value.has(node.value)
    : toggledValues.value.has(node.value)
}

function toggle(node: CategoryProgressNode): void {
  const next = new Set(toggledValues.value)
  if (next.has(node.value)) next.delete(node.value)
  else next.add(node.value)
  toggledValues.value = next
}

// Flattens the tree into the currently visible rows (depth-first, respecting collapsed nodes)
// so every row — regardless of depth — is a direct sibling in the same CSS grid.
const visibleRows = computed((): CategoryProgressNode[] => {
  const rows: CategoryProgressNode[] = []
  function walk(nodes: CategoryProgressNode[]): void {
    for (const node of nodes) {
      rows.push(node)
      if (node.children.length > 0 && isOpen(node)) {
        walk(node.children)
      }
    }
  }
  walk(props.nodes)
  return rows
})
</script>

<template>
  <div class="category-tree">
    <div
      v-for="node in visibleRows"
      :key="node.value"
      :class="['category-tree-row', { clickable: node.children.length > 0 }]"
      @click="node.children.length > 0 && toggle(node)"
    >
      <span class="node-label" :style="{ paddingLeft: `${node.depth * 1.2}rem` }">{{
        node.label
      }}</span>
      <CategoryProgressBar
        :solved="node.solved"
        :failed="node.failed"
        :unattempted="node.unattempted"
        :total="node.total"
      />
    </div>
  </div>
</template>

<style scoped>
.category-tree {
  display: grid;
  grid-template-columns: minmax(0, auto) minmax(80px, 1fr) auto auto;
  column-gap: 0.6rem;
  row-gap: 0.15rem;
}

.category-tree-row {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: subgrid;
  align-items: center;
  padding: 0.35rem 0.5rem;
  border-radius: 5px;
  font-size: 0.875rem;
}

.category-tree-row.clickable {
  cursor: pointer;
}

.category-tree-row.clickable:hover {
  background: var(--hover-bg);
}

.category-tree-row:not(.clickable) {
  color: var(--muted);
}

.node-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
