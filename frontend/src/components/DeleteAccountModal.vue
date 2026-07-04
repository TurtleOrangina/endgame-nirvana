<script setup lang="ts">
import { useLocale } from '@/composables/useLocale'

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

const { t } = useLocale()
</script>

<template>
  <div class="modal-overlay">
    <div class="modal">
      <h2>{{ t((s) => s.deleteAccountModal.title) }}</h2>
      <p class="subtitle">
        {{ t((s) => s.deleteAccountModal.body) }}
      </p>

      <div class="actions">
        <button type="button" class="btn-confirm-delete" @click="emit('confirm')">
          {{ t((s) => s.deleteAccountModal.confirm) }}
        </button>
        <button type="button" class="btn-cancel" @click="emit('cancel')">
          {{ t((s) => s.common.cancel) }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}

.modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 2rem;
  width: 100%;
  max-width: 380px;
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.3);
}

h2 {
  margin: 0 0 0.25rem;
  font-size: 1.4rem;
  color: var(--btn-danger-fg);
}

.subtitle {
  margin: 0 0 1.5rem;
  color: var(--muted);
  font-size: 0.9rem;
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.btn-confirm-delete {
  padding: 0.6rem 1.25rem;
  background: var(--btn-danger-fg);
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.btn-confirm-delete:hover {
  opacity: 0.85;
}

.btn-cancel {
  padding: 0.45rem 1rem;
  background: transparent;
  color: var(--muted);
  border: none;
  font-size: 0.85rem;
  cursor: pointer;
}

.btn-cancel:hover {
  color: var(--fg);
}
</style>
