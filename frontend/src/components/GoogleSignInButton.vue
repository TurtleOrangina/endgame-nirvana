<script setup lang="ts">
import { useLocale } from '@/composables/useLocale'

defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ click: [] }>()

const { t } = useLocale()
</script>

<template>
  <button type="button" class="btn-google" :disabled="disabled" @click="emit('click')">
    <!-- Inlined rather than fetched: the app is offline-capable and its CSP-free
         static hosting should never depend on a Google-hosted asset (which would
         also ping Google on every render of this button). -->
    <svg class="google-mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18c-.44-1.32-.69-2.73-.69-4.18s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </svg>
    <span>{{ t((s) => s.common.continueWithGoogle) }}</span>
  </button>
</template>

<style scoped>
.btn-google {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  width: 100%;
  padding: 0.7rem 1rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--fg);
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s;
}

.btn-google:hover:not(:disabled) {
  background: var(--hover-bg);
}

.btn-google:disabled {
  opacity: 0.6;
  cursor: default;
}

.google-mark {
  width: 1.15rem;
  height: 1.15rem;
  flex-shrink: 0;
}
</style>
