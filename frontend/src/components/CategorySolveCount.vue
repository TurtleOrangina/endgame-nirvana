<script setup lang="ts">
defineProps<{
  attempted: number
  total: number
}>()
</script>

<template>
  <span class="option-count">
    <template v-if="attempted > 0">
      <span class="count-number">{{ attempted }}</span>
      <span class="count-slash">/</span>
    </template>
    <span class="count-number">{{ total }}</span>
  </span>
</template>

<style scoped>
.option-count {
  flex-shrink: 0;
  padding-left: 0.75rem;
  color: var(--muted);
  font-size: 0.8rem;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.count-number {
  display: inline-block;
  /* Set on the dropdown panel and sized to the widest count, so numbers align across options. */
  min-width: var(--count-column-width);
  text-align: right;
}

.count-slash {
  margin: 0 0.25em;
}
</style>
