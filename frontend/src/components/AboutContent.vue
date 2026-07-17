<script setup lang="ts">
import { useLocale } from '@/composables/useLocale'

const { t } = useLocale()
</script>

<template>
  <div class="about-content">
    <h3>{{ t((s) => s.about.title) }}</h3>
    <p>{{ t((s) => s.about.intro) }}</p>

    <h3>{{ t((s) => s.about.moveSelectionTitle) }}</h3>
    <p>{{ t((s) => s.about.moveSelectionIntro) }}</p>
    <ul>
      <li>{{ t((s) => s.about.moveSelectionDefense) }}</li>
      <li>{{ t((s) => s.about.moveSelectionVariety) }}</li>
    </ul>

    <h3>{{ t((s) => s.about.openTitle) }}</h3>
    <p>{{ t((s) => s.about.openText) }}</p>

    <h3>{{ t((s) => s.about.offlineTitle) }}</h3>
    <p>{{ t((s) => s.about.offlineIntro) }}</p>
    <ul>
      <li>{{ t((s) => s.about.offlineTablebase) }}</li>
      <li>{{ t((s) => s.about.offlineSync) }}</li>
    </ul>
  </div>
</template>

<style scoped>
.about-content {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

h3 {
  margin: 0.65rem 0 0;
  font-size: 0.95rem;
  color: var(--fg);
}

h3:first-child {
  margin-top: 0;
}

p,
li {
  margin: 0;
  color: var(--muted);
  font-size: 0.85rem;
  line-height: 1.45;
}

ul {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin: 0;
  padding-left: 1.1rem;
}
</style>
