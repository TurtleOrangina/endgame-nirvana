<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useUserProfileStore } from '@/stores/userProfile'
import { useExercisesStore } from '@/stores/exercises'
import { useAuthStore } from '@/stores/auth'
import { useLichessAuth } from '@/composables/useLichessAuth'
import { useLocale } from '@/composables/useLocale'
import { isValidEmail } from '@/utils/email'

const DRAFT_STORAGE_KEY = 'setup_modal_draft'

type SetupMode = 'new' | 'signin'
type NewUserStep = 'basics' | 'lichess' | 'account' | 'confirmation'

interface SetupDraft {
  step: NewUserStep
  username: string
  startElo: number
  email: string
  password: string
}

const emit = defineEmits<{ close: [] }>()

const userProfileStore = useUserProfileStore()
const exercisesStore = useExercisesStore()
const authStore = useAuthStore()
const lichessAuth = useLichessAuth()
const { t } = useLocale()

const mode = ref<SetupMode>('new')
const step = ref<NewUserStep>('basics')
const username = ref('')
const startElo = ref(1400)
const email = ref('')
const password = ref('')
const isSubmitting = ref(false)
const errorMessage = ref<string | null>(null)
const emailError = ref<string | null>(null)
const confirmationSentTo = ref<string | null>(null)
const isLoggingIn = ref(false)
const loginError = ref<string | null>(null)

// Only restored when returning from the Lichess OAuth redirect (see linkLichess) — the
// step is saved too so the user lands back where they left off, not at the first page.
function restoreDraft(): void {
  const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY)
  if (!raw) return
  sessionStorage.removeItem(DRAFT_STORAGE_KEY)
  try {
    const draft = JSON.parse(raw) as SetupDraft
    step.value = draft.step
    username.value = draft.username
    startElo.value = draft.startElo
    email.value = draft.email
    password.value = draft.password
  } catch {
    // Ignore malformed draft data.
  }
}

restoreDraft()

function linkLichess(): void {
  const draft: SetupDraft = {
    step: step.value,
    username: username.value,
    startElo: startElo.value,
    email: email.value,
    password: password.value,
  }
  sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft))
  lichessAuth.startLinkFlow()
}

function selectMode(next: SetupMode): void {
  mode.value = next
  step.value = 'basics'
  errorMessage.value = null
  emailError.value = null
}

// Resamples the puzzle shown behind the modal so the user sees an appropriately-difficulty
// puzzle already prepared as soon as they pick a starting level, without waiting for submit.
watch(
  startElo,
  (elo) => {
    if (mode.value === 'new') exercisesStore.previewExerciseForElo(elo)
  },
  { immediate: true },
)

const hasAccountDetails = computed(() => email.value.trim().length > 0 && password.value.length > 0)

// The "Welcome to..." branding only makes sense as a first impression — once the user is
// mid-wizard, the step's own heading is more useful up top than repeating it every time.
const headerTitle = computed((): string => {
  if (mode.value === 'signin') return t((s) => s.setup.welcomeBack)
  if (step.value === 'basics') return t((s) => s.setup.welcomeTitle)
  if (step.value === 'lichess') {
    return lichessAuth.isLinked.value
      ? t((s) => s.setup.lichessLinkedTitle)
      : t((s) => s.setup.lichessStepTitle)
  }
  if (step.value === 'account') return t((s) => s.setup.accountStepTitle)
  return t((s) => s.setup.confirmEmailTitle)
})

const showHeaderSubtitle = computed(() => mode.value === 'signin' || step.value === 'basics')

function goToLichessStep(): void {
  if (!username.value.trim()) return
  step.value = 'lichess'
}

function goToAccountStep(): void {
  step.value = 'account'
}

function backToAccount(): void {
  confirmationSentTo.value = null
  loginError.value = null
  step.value = 'account'
}

function validateEmailPassword(): boolean {
  emailError.value = null
  const hasEmail = email.value.trim().length > 0
  const hasPassword = password.value.length > 0
  if (!hasEmail && !hasPassword) return true
  if (hasEmail && !isValidEmail(email.value.trim())) {
    emailError.value = t((s) => s.common.enterValidEmail)
    return false
  }
  if (!hasEmail || !hasPassword) {
    emailError.value = t((s) => s.setup.errorBothOrNeither)
    return false
  }
  return true
}

async function submitAccountStep(): Promise<void> {
  errorMessage.value = null
  if (!validateEmailPassword()) return

  if (!hasAccountDetails.value) {
    finishSetup()
    return
  }

  isSubmitting.value = true
  const result = await authStore.signUp(
    email.value,
    password.value,
    username.value.trim(),
    startElo.value,
  )
  isSubmitting.value = false

  if (result.emailError) {
    emailError.value = result.emailError
    return
  }
  if (result.emailConfirmationRequired) {
    // Held back on its own step until the user acknowledges it below — the local
    // profile isn't created yet, so the modal stays open regardless of how the
    // cloud signup went.
    confirmationSentTo.value = email.value.trim()
    step.value = 'confirmation'
    return
  }
  // Offline-first: local training still works when the cloud signup fails for a
  // non-fixable reason (e.g. the backend is down) — surface the failure and let the
  // user retry or continue without an account (the profile page offers a later retry).
  if (result.error) {
    errorMessage.value = t((s) => s.setup.errorSignupFailed)
    return
  }
  finishSetup()
}

async function attemptLoginAfterConfirmation(): Promise<void> {
  loginError.value = null
  isLoggingIn.value = true
  const result = await authStore.retryLoginAfterConfirmation()
  isLoggingIn.value = false
  if (result.error) {
    loginError.value = t((s) => s.setup.notActivatedYet)
    return
  }
  // The SIGNED_IN listener's pullRemoteState is hydrating the profile from the cloud;
  // it also takes care of applying a Lichess account linked earlier in the wizard
  // (see sync.ts), so there's nothing left to persist here.
  emit('close')
}

function finishSetup(): void {
  // A cloud signup with email confirmation disabled (e.g. dev backends) already pulled a
  // full profile down via the SIGNED_IN listener — creating a fresh local one here would
  // stomp it.
  const cloudProfileAlreadyPulled = userProfileStore.profile !== null
  if (!cloudProfileAlreadyPulled) {
    userProfileStore.createProfile(
      username.value.trim(),
      startElo.value,
      lichessAuth.lichessUsername.value,
    )
  }
  // When signed in with the SIGNED_IN pull still in flight, it will overwrite the
  // local profile just created — the pending Lichess link is deliberately left in
  // place for pullRemoteState to re-apply after the "cloud wins" merge (see sync.ts).
  if (!authStore.isSignedIn || cloudProfileAlreadyPulled) {
    lichessAuth.applyPendingUsernameToProfile()
  }
  emit('close')
}

async function submitSignIn(): Promise<void> {
  errorMessage.value = null
  emailError.value = null
  if (!isValidEmail(email.value.trim())) {
    emailError.value = t((s) => s.common.enterValidEmail)
    return
  }
  isSubmitting.value = true
  const result = await authStore.signIn(email.value, password.value)
  isSubmitting.value = false
  if (result.error) {
    errorMessage.value = result.error
    return
  }
  emit('close')
}
</script>

<template>
  <div class="modal-overlay">
    <div class="modal">
      <h2>{{ headerTitle }}</h2>
      <p v-if="showHeaderSubtitle" class="subtitle">
        {{ mode === 'signin' ? t((s) => s.setup.signinSubtitle) : t((s) => s.setup.newSubtitle) }}
      </p>

      <div v-if="authStore.isBackendConfigured && step === 'basics'" class="mode-tabs">
        <button
          type="button"
          class="mode-tab"
          :class="{ active: mode === 'new' }"
          @click="selectMode('new')"
        >
          {{ t((s) => s.setup.newUserTab) }}
        </button>
        <button
          type="button"
          class="mode-tab"
          :class="{ active: mode === 'signin' }"
          @click="selectMode('signin')"
        >
          {{ t((s) => s.setup.signInTab) }}
        </button>
      </div>

      <form v-if="mode === 'signin'" class="form" @submit.prevent="submitSignIn">
        <label class="field">
          <span class="label-text">{{ t((s) => s.common.email) }}</span>
          <input
            v-model="email"
            type="email"
            class="input"
            :class="{ 'input-invalid': emailError }"
            :placeholder="t((s) => s.setup.emailPlaceholder)"
            autocomplete="username"
            required
            autofocus
          />
        </label>
        <p v-if="emailError" class="error-message">{{ emailError }}</p>
        <label class="field">
          <span class="label-text">{{ t((s) => s.common.password) }}</span>
          <input
            v-model="password"
            type="password"
            class="input"
            :placeholder="t((s) => s.common.passwordPlaceholder)"
            minlength="6"
            autocomplete="current-password"
            required
          />
        </label>

        <p v-if="errorMessage" class="error-message">{{ errorMessage }}</p>

        <button type="submit" class="btn-submit" :disabled="isSubmitting">
          {{ isSubmitting ? t((s) => s.setup.signingIn) : t((s) => s.setup.signInButton) }}
        </button>
      </form>

      <form v-else-if="step === 'basics'" class="form" @submit.prevent="goToLichessStep">
        <p class="step-info">
          {{ t((s) => s.setup.basicsInfo) }}
        </p>

        <label class="field">
          <span class="label-text">{{ t((s) => s.setup.nameLabel) }}</span>
          <input
            v-model="username"
            type="text"
            class="input"
            :placeholder="t((s) => s.setup.nicknamePlaceholder)"
            autocomplete="nickname"
            data-1p-ignore
            data-lpignore="true"
            data-bwignore="true"
            data-form-type="other"
            required
            autofocus
          />
        </label>

        <fieldset class="field">
          <legend class="label-text">{{ t((s) => s.setup.startingLevel) }}</legend>
          <div class="radio-group">
            <label class="radio-option">
              <input v-model="startElo" type="radio" :value="800" />
              <span class="radio-label">
                <strong>{{ t((s) => s.setup.beginner) }}</strong>
                <span class="elo-hint">{{ t((s) => s.setup.eloHint, { elo: 800 }) }}</span>
              </span>
            </label>
            <label class="radio-option">
              <input v-model="startElo" type="radio" :value="1400" />
              <span class="radio-label">
                <strong>{{ t((s) => s.setup.intermediate) }}</strong>
                <span class="elo-hint">{{ t((s) => s.setup.eloHint, { elo: 1400 }) }}</span>
              </span>
            </label>
            <label class="radio-option">
              <input v-model="startElo" type="radio" :value="2000" />
              <span class="radio-label">
                <strong>{{ t((s) => s.setup.expert) }}</strong>
                <span class="elo-hint">{{ t((s) => s.setup.eloHint, { elo: 2000 }) }}</span>
              </span>
            </label>
          </div>
        </fieldset>

        <button type="submit" class="btn-submit" :disabled="!username.trim()">
          {{ t((s) => s.setup.continue) }}
        </button>
      </form>

      <div v-else-if="step === 'lichess'" class="form">
        <template v-if="lichessAuth.isLinked.value">
          <p class="step-info">
            {{ t((s) => s.setup.lichessLinkedIntro) }}
            <strong>{{ lichessAuth.lichessUsername.value }}</strong
            >{{ t((s) => s.setup.lichessLinkedOutro) }}
          </p>
          <button type="button" class="btn-submit" @click="goToAccountStep">
            {{ t((s) => s.setup.next) }}
          </button>
        </template>
        <template v-else>
          <p class="step-info">
            {{ t((s) => s.setup.lichessInfo) }}
          </p>
          <button type="button" class="btn-submit" @click="linkLichess()">
            {{ t((s) => s.setup.linkLichess) }}
          </button>
          <button type="button" class="btn-train-locally" @click="goToAccountStep">
            {{ t((s) => s.setup.continueWithoutLichess) }}
          </button>
        </template>
      </div>

      <form v-else-if="step === 'account'" class="form" @submit.prevent="submitAccountStep">
        <p class="step-info">
          {{ t((s) => s.setup.accountInfo) }}
        </p>

        <label class="field">
          <span class="label-text">{{ t((s) => s.common.email) }}</span>
          <input
            v-model="email"
            type="email"
            class="input"
            :class="{ 'input-invalid': emailError }"
            :placeholder="t((s) => s.setup.emailPlaceholder)"
            autocomplete="username"
          />
        </label>
        <label class="field">
          <span class="label-text">{{ t((s) => s.common.password) }}</span>
          <input
            v-model="password"
            type="password"
            class="input"
            :placeholder="t((s) => s.common.passwordPlaceholder)"
            minlength="6"
            autocomplete="new-password"
          />
        </label>
        <p v-if="emailError" class="error-message">{{ emailError }}</p>

        <p v-if="errorMessage" class="error-message">{{ errorMessage }}</p>

        <button
          type="submit"
          :class="hasAccountDetails ? 'btn-submit' : 'btn-train-locally'"
          :disabled="isSubmitting"
        >
          <template v-if="isSubmitting">{{ t((s) => s.setup.creating) }}</template>
          <template v-else-if="hasAccountDetails">{{ t((s) => s.setup.createAccount) }}</template>
          <template v-else>{{ t((s) => s.setup.continueWithoutAccount) }}</template>
        </button>
        <button
          v-if="errorMessage && hasAccountDetails"
          type="button"
          class="btn-train-locally"
          :disabled="isSubmitting"
          @click="finishSetup"
        >
          {{ t((s) => s.setup.continueWithoutAccount) }}
        </button>
      </form>

      <div v-else class="confirmation-notice">
        <button type="button" class="btn-back" @click="backToAccount">
          {{ t((s) => s.setup.back) }}
        </button>

        <p>
          {{ t((s) => s.setup.confirmationIntro) }} <strong>{{ confirmationSentTo }}</strong
          >{{ t((s) => s.setup.confirmationOutro) }}
        </p>
        <p v-if="loginError" class="error-message">{{ loginError }}</p>
        <button
          type="button"
          class="btn-submit"
          :disabled="isLoggingIn"
          @click="attemptLoginAfterConfirmation"
        >
          {{ isLoggingIn ? t((s) => s.setup.checking) : t((s) => s.setup.logInNow) }}
        </button>
        <button
          type="button"
          class="btn-train-locally"
          :disabled="isLoggingIn"
          @click="finishSetup"
        >
          {{ t((s) => s.setup.trainLocally) }}
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
  justify-content: center;
  overflow-y: auto;
  padding: 1rem;
}

.modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 2rem;
  width: 100%;
  min-width: 0;
  max-width: 420px;
  max-height: calc(100dvh - 2rem);
  overflow-y: auto;
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.3);
  /* Centers the modal when it fits; when it's taller than the viewport, the
     auto margins collapse to 0 so it sticks to the top and stays reachable
     via the overlay's scrollbar instead of getting clipped off-screen. */
  margin: auto 0;
}

@media (max-width: 480px), (max-height: 700px) {
  .modal {
    padding: 1.25rem;
  }

  .form {
    gap: 0.85rem;
  }

  h2 {
    font-size: 1.2rem;
  }

  .subtitle {
    margin-bottom: 1rem;
  }
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

.mode-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 0.9rem;
  margin-bottom: 1.25rem;
  border-bottom: 1px solid var(--border);
}

.mode-tab {
  padding: 0.5rem 0.1rem;
  margin-bottom: -1px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--muted);
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  transition:
    color 0.15s,
    border-color 0.15s;
}

.mode-tab:hover {
  color: var(--fg);
}

.mode-tab.active {
  color: var(--accent);
  border-color: var(--accent);
}

.step-info {
  margin: 0;
  color: var(--muted);
  font-size: 0.85rem;
  line-height: 1.45;
}

.btn-back {
  align-self: flex-start;
  padding: 0;
  margin: 0;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 0.8rem;
  cursor: pointer;
}

.btn-back:hover {
  color: var(--fg);
}

.error-message {
  margin: 0;
  color: var(--btn-danger-fg);
  font-size: 0.85rem;
}

.confirmation-notice {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.confirmation-notice p {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.4;
  color: var(--fg);
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
  border: none;
  padding: 0;
  margin: 0;
  /* <fieldset> (used for the "Starting level" field) has a browser-intrinsic
     min-width that ignores normal flex shrinking, which pushed the modal
     wider than the viewport on narrow phones — override it back to 0. */
  min-width: 0;
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

.input-invalid {
  border-color: var(--btn-danger-border);
}

.radio-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.radio-option {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.1s;
}

.radio-option:hover {
  background: var(--hover-bg);
}

.radio-option input[type='radio'] {
  accent-color: var(--accent);
}

.radio-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.elo-hint {
  color: var(--muted);
  font-size: 0.85rem;
}

.btn-submit {
  padding: 0.6rem 1.25rem;
  background: var(--btn-success-bg);
  color: #fff;
  border: 1px solid var(--btn-success-border);
  border-radius: 8px;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.btn-submit:hover:not(:disabled) {
  background: var(--btn-success-hover-bg);
  border-color: var(--btn-success-hover-bg);
}

.btn-submit:disabled {
  opacity: 0.4;
  cursor: default;
}

.btn-train-locally {
  padding: 0.6rem 1.25rem;
  background: var(--color-warning-bg);
  color: var(--color-warning-fg);
  border: 1px solid var(--color-warning-border);
  border-radius: 8px;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.btn-train-locally:hover:not(:disabled) {
  filter: brightness(0.95);
}

.btn-train-locally:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
