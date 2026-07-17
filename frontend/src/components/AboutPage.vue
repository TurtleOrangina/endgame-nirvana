<script setup lang="ts">
import AboutContent from '@/components/AboutContent.vue'
</script>

<template>
  <div class="about-page">
    <section class="section">
      <AboutContent />
    </section>
  </div>
</template>

<style scoped>
.about-page {
  width: 100%;
  max-width: 720px;
}

.section {
  padding: 1.25rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
}
</style>
