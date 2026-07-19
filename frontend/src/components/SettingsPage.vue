<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useUserProfileStore } from '@/stores/userProfile'
import { useExercisesStore } from '@/stores/exercises'
import { useAuthStore } from '@/stores/auth'
import { useSyncStore } from '@/stores/sync'
import { useLichessAuth } from '@/composables/useLichessAuth'
import { useLocale } from '@/composables/useLocale'
import { isValidEmail } from '@/utils/email'
import DeleteAccountModal from '@/components/DeleteAccountModal.vue'
import type { DifficultyPreference, Language, ThemeMode } from '@/types'

const userProfileStore = useUserProfileStore()
const { profile } = storeToRefs(userProfileStore)
const exercisesStore = useExercisesStore()
const { difficultyPuzzleCounts } = storeToRefs(exercisesStore)
const authStore = useAuthStore()
const syncStore = useSyncStore()
const lichessAuth = useLichessAuth()
const { t } = useLocale()

const accountEmail = ref('')
const accountPassword = ref('')
const accountSubmitting = ref(false)
const accountError = ref<string | null>(null)
const accountEmailError = ref<string | null>(null)
const confirmationRetrySubmitting = ref(false)
const confirmationRetryError = ref<string | null>(null)
const resetEmailSentTo = ref<string | null>(null)
const isSendingResetEmail = ref(false)

const accountSubmitLabel = computed(() => {
  if (authStore.pendingRegistration) {
    return accountSubmitting.value ? t((s) => s.profile.retrying) : t((s) => s.profile.retry)
  }
  return accountSubmitting.value
    ? t((s) => s.profile.creatingAccount)
    : t((s) => s.profile.createAccount)
})

async function onAccountSubmit(): Promise<void> {
  accountError.value = null
  accountEmailError.value = null

  if (!authStore.pendingRegistration && !isValidEmail(accountEmail.value.trim())) {
    accountEmailError.value = t((s) => s.common.enterValidEmail)
    return
  }

  accountSubmitting.value = true
  const result = await (authStore.pendingRegistration
    ? authStore.retryPendingRegistration(accountPassword.value)
    : authStore.signUp(
        accountEmail.value,
        accountPassword.value,
        profile.value?.username ?? '',
        profile.value?.endgameElo ?? 1400,
      ))
  accountSubmitting.value = false

  if (result.emailAlreadyRegistered) {
    accountEmailError.value = t((s) => s.profile.emailAlreadyRegistered)
  } else if (result.error) {
    accountError.value = result.error
  } else {
    accountPassword.value = ''
  }
}

async function onForgotPassword(): Promise<void> {
  accountError.value = null
  accountEmailError.value = null
  const targetEmail = (authStore.pendingRegistration?.email ?? accountEmail.value).trim()
  if (!isValidEmail(targetEmail)) {
    accountEmailError.value = t((s) => s.common.enterValidEmail)
    return
  }
  isSendingResetEmail.value = true
  const result = await authStore.requestPasswordReset(targetEmail)
  isSendingResetEmail.value = false
  if (result.error) {
    accountError.value = result.error
    return
  }
  resetEmailSentTo.value = targetEmail
}

function onSignOut(): void {
  void authStore.signOut()
}

const showDeleteAccountModal = ref(false)

function onDeleteAccountClick(): void {
  if (authStore.isSignedIn) {
    showDeleteAccountModal.value = true
  } else {
    void authStore.deleteAccount()
  }
}

function onConfirmDeleteAccount(): void {
  showDeleteAccountModal.value = false
  void authStore.deleteAccount()
}

async function onRetryLoginAfterConfirmation(): Promise<void> {
  confirmationRetryError.value = null
  confirmationRetrySubmitting.value = true
  const result = await authStore.retryLoginAfterConfirmation()
  confirmationRetrySubmitting.value = false
  if (result.error) confirmationRetryError.value = result.error
}

const unsyncedLabel = computed((): string | null => {
  if (syncStore.isSyncing) return t((s) => s.profile.syncing)
  if (syncStore.pendingCount === 1) return t((s) => s.profile.unsyncedOne)
  if (syncStore.pendingCount > 1) {
    return t((s) => s.profile.unsyncedMany, { count: syncStore.pendingCount })
  }
  return null
})

const difficultyPreferenceOptions = computed(
  (): { value: DifficultyPreference; label: string }[] => [
    { value: 'around', label: t((s) => s.profile.difficultyAround) },
    { value: 'aroundAndAbove', label: t((s) => s.profile.difficultyAroundAndAbove) },
    { value: 'aroundAndBelow', label: t((s) => s.profile.difficultyAroundAndBelow) },
    { value: 'all', label: t((s) => s.profile.difficultyAll) },
  ],
)

function onDifficultyPreferenceChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value as DifficultyPreference
  userProfileStore.setDifficultyPreference(value)
  exercisesStore.onDifficultyPreferenceChanged()
}

const themeModeOptions = computed((): { value: ThemeMode; label: string }[] => [
  { value: 'dark', label: t((s) => s.profile.mode.dark) },
  { value: 'light', label: t((s) => s.profile.mode.light) },
  { value: 'system', label: t((s) => s.profile.mode.system) },
])

function onThemeModeChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value as ThemeMode
  userProfileStore.setThemeMode(value)
}

// Each language is labelled with its own name, untranslated — the standard
// convention for language pickers.
const languageOptions: { value: Language; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'de', label: 'Deutsch' },
]

function onLanguageChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value as Language
  userProfileStore.setLanguage(value)
}

// One core stays reserved for the UI, so the board never stutters while the engine thinks
const maxEngineThreads = Math.max(1, navigator.hardwareConcurrency - 1)

function onEngineThreadsChange(event: Event): void {
  userProfileStore.setEngineThreads(Number((event.target as HTMLInputElement).value))
}

const inactivePuzzlesDetail = computed((): string | null => {
  const { tooHard, tooEasy } = difficultyPuzzleCounts.value
  const parts: string[] = []
  if (tooHard > 0) parts.push(t((s) => s.profile.tooHardCount, { count: tooHard }))
  if (tooEasy > 0) parts.push(t((s) => s.profile.tooEasyCount, { count: tooEasy }))
  return parts.length > 0 ? parts.join(', ') : null
})

const deleteAccountLabel = computed(() =>
  authStore.isSignedIn ? t((s) => s.profile.deleteAccount) : t((s) => s.profile.deleteProgress),
)
</script>

<template>
  <div class="settings-page">
    <section v-if="authStore.isBackendConfigured && !authStore.isSignedIn" class="section">
      <template v-if="authStore.awaitingEmailConfirmation">
        <p class="local-only-notice">
          {{ t((s) => s.profile.confirmationIntro) }}
          <strong>{{ authStore.awaitingEmailConfirmation.email }}</strong
          >{{ t((s) => s.profile.confirmationOutro) }}
        </p>

        <p v-if="confirmationRetryError" class="error-message">{{ confirmationRetryError }}</p>

        <button
          type="button"
          class="btn-link-lichess"
          :disabled="confirmationRetrySubmitting"
          @click="onRetryLoginAfterConfirmation"
        >
          {{
            confirmationRetrySubmitting
              ? t((s) => s.profile.signingIn)
              : t((s) => s.profile.retrySignIn)
          }}
        </button>
      </template>

      <template v-else>
        <p class="local-only-notice">
          {{
            authStore.pendingRegistration
              ? t((s) => s.profile.accountNotCreatedNotice)
              : t((s) => s.profile.localOnlyNotice)
          }}
        </p>

        <h2 class="section-title">{{ t((s) => s.profile.createAccountTitle) }}</h2>

        <p v-if="authStore.pendingRegistration" class="section-desc">
          {{ t((s) => s.profile.pendingIntro) }}
          <strong>{{ authStore.pendingRegistration.email }}</strong>
          {{ t((s) => s.profile.pendingOutro) }}
        </p>

        <form class="account-form" @submit.prevent="onAccountSubmit">
          <label v-if="!authStore.pendingRegistration" class="field">
            <span class="label-text">{{ t((s) => s.common.email) }}</span>
            <input
              v-model="accountEmail"
              type="email"
              class="input"
              :class="{ 'input-invalid': accountEmailError }"
              required
            />
          </label>
          <p v-if="accountEmailError" class="error-message">{{ accountEmailError }}</p>

          <label class="field">
            <span class="label-text">{{ t((s) => s.common.password) }}</span>
            <input v-model="accountPassword" type="password" class="input" minlength="6" required />
          </label>

          <p v-if="accountError" class="error-message">{{ accountError }}</p>

          <button type="submit" class="btn-link-lichess" :disabled="accountSubmitting">
            {{ accountSubmitLabel }}
          </button>
        </form>

        <p class="section-desc">
          <button
            type="button"
            class="btn-forgot-password"
            :disabled="isSendingResetEmail"
            @click="onForgotPassword"
          >
            {{ t((s) => s.common.forgotPassword) }}
          </button>
        </p>
        <p v-if="resetEmailSentTo" class="info-message">
          {{ t((s) => s.common.resetEmailSent, { email: resetEmailSentTo }) }}
        </p>
      </template>
    </section>

    <section class="section">
      <h2 class="section-title">{{ t((s) => s.profile.puzzleDifficulty) }}</h2>
      <div class="ident-row ident-row-top">
        <span class="ident-label">{{ t((s) => s.profile.puzzleDifficultyLabel) }}</span>
        <div class="ident-select-group">
          <select
            v-if="profile"
            class="ident-select"
            :value="profile.difficultyPreference"
            @change="onDifficultyPreferenceChange"
          >
            <option
              v-for="option in difficultyPreferenceOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
          <p class="ident-hint">
            {{ t((s) => s.profile.activePuzzleCount, { count: difficultyPuzzleCounts.active }) }}
            <template v-if="inactivePuzzlesDetail">
              — {{ t((s) => s.profile.inactiveDetail, { detail: inactivePuzzlesDetail }) }}
            </template>
          </p>
        </div>
      </div>
    </section>

    <section class="section">
      <h2 class="section-title">{{ t((s) => s.profile.mode.title) }}</h2>

      <div class="ident-row">
        <span class="ident-label">{{ t((s) => s.profile.colorSchemeTitle) }}</span>
        <select
          v-if="profile"
          class="ident-select"
          :value="profile.themeMode"
          @change="onThemeModeChange"
        >
          <option v-for="option in themeModeOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </div>

      <div class="ident-row">
        <span class="ident-label">{{ t((s) => s.profile.language.title) }}</span>
        <select
          v-if="profile"
          class="ident-select"
          :value="profile.language"
          @change="onLanguageChange"
        >
          <option v-for="option in languageOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </div>
    </section>

    <section class="section">
      <h2 class="section-title">{{ t((s) => s.profile.engine.title) }}</h2>

      <div class="ident-row ident-row-top">
        <span class="ident-label">{{ t((s) => s.profile.engine.threadsLabel) }}</span>
        <div class="ident-select-group">
          <div v-if="profile" class="threads-slider-row">
            <input
              type="range"
              class="threads-slider"
              min="1"
              :max="maxEngineThreads"
              step="1"
              :value="Math.min(profile.engineThreads, maxEngineThreads)"
              @input="onEngineThreadsChange"
            />
            <span class="threads-value">{{
              Math.min(profile.engineThreads, maxEngineThreads)
            }}</span>
          </div>
          <p class="ident-hint">{{ t((s) => s.profile.engine.threadsHint) }}</p>
        </div>
      </div>
    </section>

    <section class="section">
      <h2 class="section-title">{{ t((s) => s.profile.accountTitle) }}</h2>

      <div class="ident-row ident-row-stacked">
        <span class="ident-label">{{ t((s) => s.profile.lichessTitle) }}</span>
        <div class="ident-stack">
          <span :class="lichessAuth.isLinked.value ? 'status-positive' : 'status-warning'">
            <template v-if="lichessAuth.isLinked.value">
              {{ t((s) => s.profile.linkedAs) }} {{ lichessAuth.lichessUsername.value }}
            </template>
            <template v-else>{{ t((s) => s.profile.lichessNotLinked) }}</template>
          </span>
          <div class="ident-actions">
            <button
              v-if="lichessAuth.isLinked.value"
              class="btn-danger-outline"
              @click="lichessAuth.unlinkAccount()"
            >
              {{ t((s) => s.profile.unlinkLichessAccount) }}
            </button>
            <button v-else class="btn-success-outline" @click="lichessAuth.startLinkFlow()">
              {{ t((s) => s.profile.linkLichessAccount) }}
            </button>
          </div>
        </div>
      </div>

      <div class="ident-row ident-row-stacked">
        <span class="ident-label">{{ t((s) => s.profile.endgameNirvanaAccountLabel) }}</span>
        <div class="ident-stack">
          <span :class="authStore.isSignedIn ? 'status-positive' : 'status-warning'">
            {{ authStore.isSignedIn ? authStore.userEmail : t((s) => s.profile.noAccount) }}
          </span>
          <div class="ident-actions">
            <button v-if="authStore.isSignedIn" class="btn-danger-outline" @click="onSignOut">
              {{ t((s) => s.profile.logOut) }}
            </button>
            <button class="btn-danger-solid" @click="onDeleteAccountClick">
              {{ deleteAccountLabel }}
            </button>
          </div>
        </div>
      </div>
      <p v-if="syncStore.lastSyncError" class="ident-hint error-message">
        {{ t((s) => s.profile.syncError, { error: syncStore.lastSyncError }) }}
      </p>
      <p v-else-if="unsyncedLabel" class="ident-hint">{{ unsyncedLabel }}</p>
    </section>

    <footer class="legal-footer">
      <a href="/impressum">Impressum</a>
      <span aria-hidden="true">·</span>
      <a href="/datenschutz">Datenschutz</a>
    </footer>

    <DeleteAccountModal
      v-if="showDeleteAccountModal"
      @confirm="onConfirmDeleteAccount"
      @cancel="showDeleteAccountModal = false"
    />
  </div>
</template>

<style scoped>
.settings-page {
  width: 100%;
  max-width: 720px;
  display: flex;
  flex-direction: column;
  gap: 2rem;
}

.section {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1.25rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.section-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
  color: var(--fg);
}

.section-desc {
  margin: 0;
  font-size: 0.875rem;
  color: var(--muted);
}

/* Ident-value settings rows */
.ident-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.ident-label {
  width: 190px;
  flex-shrink: 0;
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--fg);
}

.ident-row-stacked {
  align-items: flex-start;
}

.ident-row-top {
  align-items: flex-start;
}

.ident-row-top .ident-label {
  padding-top: 0.45rem;
}

.ident-stack {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.ident-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.status-positive {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--color-solved);
}

.status-warning {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--color-warning-fg);
}

.ident-select {
  padding: 0.45rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font-size: 0.875rem;
  cursor: pointer;
}

.ident-select-group {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.threads-slider-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.threads-slider {
  width: 180px;
  accent-color: var(--accent);
  cursor: pointer;
}

.threads-value {
  min-width: 1.5rem;
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--fg);
  text-align: right;
}

.ident-hint {
  margin: 0;
  font-size: 0.8rem;
  font-style: italic;
  color: var(--muted);
}

.btn-success-outline {
  padding: 0.3rem 0.7rem;
  border: 1px solid var(--btn-success-border);
  border-radius: 6px;
  background: transparent;
  color: var(--btn-success-border);
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.1s;
}

.btn-success-outline:hover {
  background: var(--btn-success-hover-bg);
}

.btn-link-lichess {
  padding: 0.45rem 1rem;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: transparent;
  color: var(--accent);
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.1s;
  align-self: flex-start;
}

.btn-link-lichess:hover {
  background: rgba(220, 162, 0, 0.08);
}

.btn-danger-outline {
  padding: 0.3rem 0.7rem;
  border: 1px solid var(--btn-danger-border);
  border-radius: 6px;
  background: transparent;
  color: var(--btn-danger-fg);
  font-size: 0.8rem;
  cursor: pointer;
  transition: background 0.1s;
}

.btn-danger-outline:hover {
  background: var(--btn-danger-hover-bg);
}

.btn-danger-solid {
  padding: 0.3rem 0.7rem;
  border: 1px solid var(--btn-danger-fg);
  border-radius: 6px;
  background: var(--btn-danger-fg);
  color: #fff;
  font-size: 0.8rem;
  cursor: pointer;
  transition: opacity 0.1s;
}

.btn-danger-solid:hover {
  opacity: 0.85;
}

/* Account section */
.local-only-notice {
  margin: 0;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--color-warning-border);
  border-radius: 6px;
  background: var(--color-warning-bg);
  color: var(--color-warning-fg);
  font-size: 0.875rem;
}

.account-form {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  max-width: 320px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.label-text {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--fg);
}

.input {
  padding: 0.45rem 0.65rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font-size: 0.9rem;
  outline: none;
  transition: border-color 0.15s;
}

.input:focus {
  border-color: var(--accent);
}

.input-invalid {
  border-color: var(--btn-danger-border);
}

.error-message {
  color: var(--btn-danger-fg);
}

.legal-footer {
  display: flex;
  justify-content: center;
  gap: 0.5rem;
  padding-top: 1rem;
  font-size: 0.8rem;
  color: var(--muted);
}

.legal-footer a {
  color: var(--muted);
  text-decoration: none;
}

.legal-footer a:hover {
  color: var(--accent);
}

.btn-forgot-password {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 0.8rem;
  text-decoration: underline;
  cursor: pointer;
}

.btn-forgot-password:hover:not(:disabled) {
  color: var(--fg);
}

.btn-forgot-password:disabled {
  opacity: 0.4;
  cursor: default;
}

.info-message {
  margin: 0;
  color: var(--fg);
  font-size: 0.85rem;
  line-height: 1.4;
}

.btn-link-lichess:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
