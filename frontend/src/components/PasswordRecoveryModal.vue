<script setup lang="ts">
import { ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useLocale } from '@/composables/useLocale'

const authStore = useAuthStore()
const { t } = useLocale()

const newPassword = ref('')
const isSubmitting = ref(false)
const errorMessage = ref<string | null>(null)

async function submit(): Promise<void> {
  errorMessage.value = null
  isSubmitting.value = true
  const result = await authStore.confirmPasswordRecovery(newPassword.value)
  isSubmitting.value = false
  if (result.error) errorMessage.value = result.error
  // On success, confirmPasswordRecovery clears passwordRecoveryRequested, closing this modal.
}
</script>

<template>
  <div class="modal-overlay">
    <div class="modal">
      <h2>{{ t((s) => s.passwordRecovery.title) }}</h2>

      <template v-if="authStore.passwordRecoveryLinkInvalid">
        <p class="error-message">{{ t((s) => s.passwordRecovery.linkInvalid) }}</p>
        <button type="button" class="btn-cancel" @click="authStore.dismissPasswordRecovery()">
          {{ t((s) => s.common.cancel) }}
        </button>
      </template>

      <template v-else>
        <p class="subtitle">{{ t((s) => s.passwordRecovery.subtitle) }}</p>

        <form class="form" @submit.prevent="submit">
          <label class="field">
            <span class="label-text">{{ t((s) => s.passwordRecovery.newPasswordLabel) }}</span>
            <input
              v-model="newPassword"
              type="password"
              class="input"
              :placeholder="t((s) => s.common.passwordPlaceholder)"
              minlength="6"
              required
              autofocus
            />
          </label>

          <p v-if="errorMessage" class="error-message">{{ errorMessage }}</p>

          <button type="submit" class="btn-submit" :disabled="isSubmitting">
            {{
              isSubmitting
                ? t((s) => s.passwordRecovery.saving)
                : t((s) => s.passwordRecovery.savePassword)
            }}
          </button>

          <button type="button" class="btn-cancel" @click="authStore.dismissPasswordRecovery()">
            {{ t((s) => s.common.cancel) }}
          </button>
        </form>
      </template>
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
  color: var(--accent);
}

.subtitle {
  margin: 0 0 1.5rem;
  color: var(--muted);
  font-size: 0.9rem;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.label-text {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--fg);
}

.input {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font-size: 0.95rem;
  outline: none;
  transition: border-color 0.15s;
}

.input:focus {
  border-color: var(--accent);
}

.error-message {
  margin: 0;
  color: var(--btn-danger-fg);
  font-size: 0.85rem;
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

.btn-submit:hover:not(:disabled) {
  background: var(--accent-darker);
}

.btn-submit:disabled {
  opacity: 0.4;
  cursor: default;
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
