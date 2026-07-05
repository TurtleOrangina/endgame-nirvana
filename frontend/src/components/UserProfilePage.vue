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
import { applyTransformCode } from '@/utils/fenTransform'
import MiniBoard from '@/components/MiniBoard.vue'
import CategoryProgressTree from '@/components/CategoryProgressTree.vue'
import DeleteAccountModal from '@/components/DeleteAccountModal.vue'
import type { DifficultyPreference, EloHistoryEntry, Language, ThemeMode } from '@/types'

// Forgot-password stays hidden until backend/.env has SMTP_* configured — see
// backend_plan.md and backend/CLAUDE.md. Flip this once that's true.
const SMTP_CONFIGURED = true

const emit = defineEmits<{
  back: []
  'load-puzzle': [payload: { exerciseId: string; transformCode: string }]
}>()

const userProfileStore = useUserProfileStore()
const { profile } = storeToRefs(userProfileStore)
const exercisesStore = useExercisesStore()
const { categoryProgressTree, difficultyPuzzleCounts } = storeToRefs(exercisesStore)
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

  if (result.emailError) {
    accountEmailError.value = result.emailError
  } else if (result.error) {
    accountError.value = result.error
  } else {
    accountPassword.value = ''
  }
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

const inactivePuzzlesDetail = computed((): string | null => {
  const { tooHard, tooEasy } = difficultyPuzzleCounts.value
  const parts: string[] = []
  if (tooHard > 0) parts.push(t((s) => s.profile.tooHardCount, { count: tooHard }))
  if (tooEasy > 0) parts.push(t((s) => s.profile.tooEasyCount, { count: tooEasy }))
  return parts.length > 0 ? parts.join(', ') : null
})

interface HistoryCard {
  entry: EloHistoryEntry
  displayFen: string | null
}

// Pre-migration entries have no exerciseId (fen was stored directly back then) —
// they simply show the placeholder, same as any other entry with no reconstructable
// position. eloHistory/attempts are already capped to an 8-week rolling window, so
// this only ever applies to a short transition period.
const recentHistory = computed((): HistoryCard[] => {
  const history = profile.value?.eloHistory ?? []
  return [...history]
    .reverse()
    .slice(0, 16)
    .map((entry) => ({
      entry,
      displayFen: entry.exerciseId
        ? applyTransformCode(entry.exerciseId, entry.transformCode ?? '')
        : null,
    }))
})

function eloChangeLabel(change: number): string {
  return change >= 0 ? `+${change}` : `${change}`
}

function onCardClick(entry: EloHistoryEntry): void {
  if (entry.exerciseId) {
    emit('load-puzzle', { exerciseId: entry.exerciseId, transformCode: entry.transformCode ?? '' })
  }
}
</script>

<template>
  <div class="profile-page">
    <button class="btn-back" @click="emit('back')">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M19 12H5" />
        <path d="m12 5-7 7 7 7" />
      </svg>
      {{ t((s) => s.profile.backToTraining) }}
    </button>

    <h1 v-if="profile" class="profile-title">{{ profile.username }}</h1>

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

        <p v-if="SMTP_CONFIGURED" class="section-desc">
          <button type="button" class="btn-forgot-password">
            {{ t((s) => s.profile.forgotPassword) }}
          </button>
        </p>
      </template>
    </section>

    <section class="section">
      <h2 class="section-title">{{ t((s) => s.profile.solveProgress) }}</h2>
      <p v-if="categoryProgressTree.length === 0" class="empty">
        {{ t((s) => s.profile.noExercisesSolved) }}
      </p>
      <CategoryProgressTree v-else :nodes="categoryProgressTree" />
    </section>

    <section class="section">
      <h2 class="section-title">{{ t((s) => s.profile.puzzleHistory) }}</h2>
      <p v-if="recentHistory.length === 0" class="empty">
        {{ t((s) => s.profile.noPuzzlesAttempted) }}
      </p>
      <div v-else class="history-grid">
        <div
          v-for="card in recentHistory"
          :key="card.entry.timestamp"
          :class="['history-card', card.entry.exerciseId ? 'clickable' : '']"
          :title="card.entry.exerciseId ? t((s) => s.profile.replayPuzzleTitle) : undefined"
          @click="onCardClick(card.entry)"
        >
          <div class="board-wrap">
            <MiniBoard v-if="card.displayFen" :fen="card.displayFen" />
            <div v-else class="board-placeholder">?</div>
          </div>
          <div :class="['elo-badge', card.entry.change >= 0 ? 'positive' : 'negative']">
            {{ eloChangeLabel(card.entry.change) }}
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <h2 class="section-title">{{ t((s) => s.profile.puzzleDifficulty) }}</h2>
      <p class="section-desc">{{ t((s) => s.profile.difficultyQuestion) }}</p>
      <select
        v-if="profile"
        class="difficulty-select"
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
      <p class="active-count">
        {{ t((s) => s.profile.activePuzzleCount, { count: difficultyPuzzleCounts.active }) }}
      </p>
      <p v-if="inactivePuzzlesDetail" class="section-desc">
        <i>{{ t((s) => s.profile.inactiveDetail, { detail: inactivePuzzlesDetail }) }}</i>
      </p>
    </section>

    <section class="section">
      <h2 class="section-title">{{ t((s) => s.profile.lichessTitle) }}</h2>
      <template v-if="lichessAuth.isLinked.value">
        <div class="inline-row">
          <span class="linked-label">
            {{ t((s) => s.profile.linkedAs) }}
            <strong>{{ lichessAuth.lichessUsername.value }}</strong>
          </span>
          <button class="btn-danger-outline" @click="lichessAuth.unlinkAccount()">
            {{ t((s) => s.common.unlink) }}
          </button>
        </div>
      </template>
      <template v-else>
        <p class="section-desc">
          {{ t((s) => s.profile.lichessDescription) }}
        </p>
        <button class="btn-link-lichess" @click="lichessAuth.startLinkFlow()">
          {{ t((s) => s.profile.linkLichessAccount) }}
        </button>
      </template>
    </section>

    <section class="section">
      <h2 class="section-title">{{ t((s) => s.profile.mode.title) }}</h2>
      <p class="section-desc">{{ t((s) => s.profile.mode.description) }}</p>
      <select
        v-if="profile"
        class="difficulty-select"
        :value="profile.themeMode"
        @change="onThemeModeChange"
      >
        <option v-for="option in themeModeOptions" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>
    </section>

    <section class="section">
      <h2 class="section-title">{{ t((s) => s.profile.language.title) }}</h2>
      <p class="section-desc">{{ t((s) => s.profile.language.description) }}</p>
      <select
        v-if="profile"
        class="difficulty-select"
        :value="profile.language"
        @change="onLanguageChange"
      >
        <option v-for="option in languageOptions" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>
    </section>

    <section class="section">
      <h2 class="section-title">{{ t((s) => s.profile.accountTitle) }}</h2>
      <div class="inline-row">
        <span v-if="authStore.isSignedIn" class="linked-label">
          {{ t((s) => s.profile.signedInAs) }} <strong>{{ authStore.userEmail }}</strong>
        </span>
        <span v-else class="linked-label">{{ t((s) => s.profile.trainingLocallyOnly) }}</span>
        <button v-if="authStore.isSignedIn" class="btn-danger-outline" @click="onSignOut">
          {{ t((s) => s.profile.logOut) }}
        </button>
        <button class="btn-danger-solid" @click="onDeleteAccountClick">
          {{ t((s) => s.profile.deleteAccount) }}
        </button>
      </div>
      <p v-if="syncStore.lastSyncError" class="section-desc error-message">
        {{ t((s) => s.profile.syncError, { error: syncStore.lastSyncError }) }}
      </p>
      <p v-else-if="unsyncedLabel" class="section-desc">{{ unsyncedLabel }}</p>
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
.profile-page {
  width: 100%;
  max-width: 720px;
  display: flex;
  flex-direction: column;
  gap: 2rem;
}

.btn-back {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font-size: 0.875rem;
  cursor: pointer;
  align-self: flex-start;
  transition: background 0.1s;
}

.btn-back:hover {
  background: var(--hover-bg);
}

.btn-back svg {
  width: 14px;
  height: 14px;
}

.profile-title {
  margin: 0;
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--fg);
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

/* Lichess section */
.inline-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.linked-label {
  font-size: 0.9rem;
  color: var(--fg);
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

.btn-forgot-password:hover {
  color: var(--fg);
}

.btn-link-lichess:disabled {
  opacity: 0.4;
  cursor: default;
}

/* Difficulty preference */
.active-count {
  margin: 0;
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--fg);
}

.difficulty-select {
  align-self: flex-start;
  padding: 0.45rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font-size: 0.875rem;
  cursor: pointer;
}

/* Puzzle history */
.empty {
  font-size: 0.875rem;
  color: var(--muted);
}

.history-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.6rem;
}

@media (max-width: 560px) {
  .history-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

.history-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.35rem;
  padding: 0.4rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
}

.history-card.clickable {
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s;
}

.history-card.clickable:hover {
  border-color: var(--accent);
  background: var(--hover-bg);
}

.board-wrap {
  width: 100%;
  border-radius: 2px;
  overflow: hidden;
}

.board-placeholder {
  aspect-ratio: 1;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--badge-bg);
  color: var(--muted);
  font-size: 1.5rem;
  border-radius: 2px;
}

.elo-badge {
  font-size: 0.8rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.elo-badge.positive {
  color: var(--color-solved);
}

.elo-badge.negative {
  color: var(--color-failed);
}
</style>
