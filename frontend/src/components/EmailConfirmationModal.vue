<script setup lang="ts">
import { useAuthStore } from '@/stores/auth'
import { useLocale } from '@/composables/useLocale'

const authStore = useAuthStore()
const { t } = useLocale()
</script>

<template>
  <div class="modal-overlay">
    <div class="modal">
      <template v-if="authStore.emailConfirmationOutcome === 'confirmed'">
        <h2>{{ t((s) => s.emailConfirmation.confirmedTitle) }}</h2>
        <p class="message">{{ t((s) => s.emailConfirmation.confirmedMessage) }}</p>
      </template>

      <template v-else>
        <h2>{{ t((s) => s.emailConfirmation.invalidTitle) }}</h2>
        <p class="message error-message">{{ t((s) => s.emailConfirmation.linkInvalid) }}</p>
      </template>

      <button
        type="button"
        class="btn-submit"
        :class="{ 'btn-success': authStore.emailConfirmationOutcome === 'confirmed' }"
        @click="authStore.dismissEmailConfirmation()"
      >
        {{ t((s) => s.emailConfirmation.ok) }}
      </button>
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
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

h2 {
  margin: 0;
  font-size: 1.4rem;
  color: var(--accent);
}

.message {
  margin: 0;
  color: var(--fg);
  font-size: 0.9rem;
}

.error-message {
  color: var(--btn-danger-fg);
}

.btn-submit {
  padding: 0.6rem 1.25rem;
  background: var(--accent);
  color: #000;
  border: none;
  border-radius: 8px;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.btn-submit:hover {
  background: var(--accent-darker);
}

.btn-success {
  background: var(--btn-success-bg);
  color: #fff;
  border: 1px solid var(--btn-success-border);
}

.btn-success:hover {
  background: var(--btn-success-hover-bg);
  border-color: var(--btn-success-hover-bg);
}
</style>
