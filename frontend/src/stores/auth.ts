import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { isAuthRetryableFetchError, type AuthError, type Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabaseClient'
import { useSyncStore } from '@/stores/sync'

export interface AuthActionResult {
  error: string | null
  emailAlreadyRegistered?: boolean
  emailConfirmationRequired?: boolean
  invalidCredentials?: boolean
}

// Kept only in memory (never persisted, unlike PendingRegistration) since it holds the
// password — set once signUp succeeds but the account still needs email confirmation, so
// the profile page can offer a one-click retry-login once the user has clicked the link.
export interface AwaitingEmailConfirmation {
  email: string
  password: string
}

// AuthRetryableFetchError (network failures, 5xx responses) and JSON-parse
// failures both stringify to a useless "{}" message (auth-js builds it via
// JSON.stringify on a bare Response/Error, which has no own enumerable
// properties) — show something a user can actually act on instead.
function friendlyAuthErrorMessage(error: AuthError): string {
  if (isAuthRetryableFetchError(error) || !error.message || error.message === '{}') {
    return 'Could not reach the server. Please check your connection and try again.'
  }
  return error.message
}

const PENDING_REGISTRATION_STORAGE_KEY = 'pendingRegistration'

// Only email/username/startElo are ever persisted here — never the password
// (see backend_plan.md's "pending registration" decision). Retrying re-prompts
// for the password.
export interface PendingRegistration {
  email: string
  username: string
  startElo: number
}

function loadPendingRegistration(): PendingRegistration | null {
  try {
    const raw = localStorage.getItem(PENDING_REGISTRATION_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as PendingRegistration) : null
  } catch {
    return null
  }
}

export const useAuthStore = defineStore('auth', () => {
  const session = ref<Session | null>(null)
  const pendingRegistration = ref<PendingRegistration | null>(loadPendingRegistration())
  const awaitingEmailConfirmation = ref<AwaitingEmailConfirmation | null>(null)
  const passwordRecoveryRequested = ref(false)
  const passwordRecoveryLinkInvalid = ref(false)
  let initialized = false

  const isBackendConfigured = computed(() => supabase !== null)
  const isSignedIn = computed(() => session.value !== null)
  const userEmail = computed(() => session.value?.user.email ?? null)

  function setPendingRegistration(registration: PendingRegistration | null): void {
    pendingRegistration.value = registration
    if (registration) {
      localStorage.setItem(PENDING_REGISTRATION_STORAGE_KEY, JSON.stringify(registration))
    } else {
      localStorage.removeItem(PENDING_REGISTRATION_STORAGE_KEY)
    }
  }

  // Wires up the auth session and its change listener. Idempotent, and a no-op
  // when the backend isn't configured (see supabaseClient.ts) so the app stays
  // fully offline-capable. Call once, before the other stores initialize. Awaits
  // the initial pull (if already signed in) so the profile is ready before the
  // caller proceeds; later SIGNED_IN events (from signIn/signUp) are handled by
  // the listener.
  async function init(): Promise<void> {
    if (!supabase || initialized) return
    initialized = true

    const { data } = await supabase.auth.getSession()
    session.value = data.session

    supabase.auth.onAuthStateChange((event, newSession) => {
      session.value = newSession

      if (event === 'PASSWORD_RECOVERY') {
        passwordRecoveryRequested.value = true
      }
      if (event === 'SIGNED_IN') {
        awaitingEmailConfirmation.value = null
        void useSyncStore().pullRemoteState()
      }
    })

    await consumeRecoveryTokenFromUrl()

    // Fire-and-forget: the cloud pull is best-effort background sync (see the
    // frontend CLAUDE.md's Backend section), not a precondition for the rest of the
    // app to render. Awaiting it here would block init() — and therefore App.vue's
    // onMounted, which loads the (fully offline-capable) exercise catalog only
    // after init() resolves — on a network round trip that can hang for many
    // seconds with no connectivity (e.g. flight mode) before failing.
    if (session.value) void useSyncStore().pullRemoteState()
  }

  // The password-reset email links straight back to the app with a token_hash
  // (via a customized Supabase email template), instead of bouncing through the
  // supabase.co verify endpoint — that hop showed a raw redirect page when the
  // browser paused navigation to offer opening the installed PWA. The token is
  // therefore verified here, on app load.
  async function consumeRecoveryTokenFromUrl(): Promise<void> {
    if (!supabase) return
    const params = new URLSearchParams(window.location.search)
    const tokenHash = params.get('token_hash')
    if (!tokenHash || params.get('type') !== 'recovery') return

    // Strip the one-time token from the URL before verifying, so a reload
    // doesn't retry an already-consumed token (and it stays out of history).
    params.delete('token_hash')
    params.delete('type')
    const query = params.toString()
    history.replaceState(history.state, '', window.location.pathname + (query ? `?${query}` : ''))

    const { error } = await supabase.auth.verifyOtp({ type: 'recovery', token_hash: tokenHash })
    passwordRecoveryLinkInvalid.value = error !== null
    passwordRecoveryRequested.value = true
  }

  async function signUp(
    email: string,
    password: string,
    username: string,
    startElo: number,
  ): Promise<AuthActionResult> {
    if (!supabase) {
      setPendingRegistration({ email, username, startElo })
      return { error: 'Backend not configured' }
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { username, start_elo: startElo } },
    })

    if (error) {
      // Not a retryable failure — the account exists, so the user should sign in
      // or reset their password instead of retrying the signup.
      if (error.code === 'user_already_exists') {
        return { error: null, emailAlreadyRegistered: true }
      }
      setPendingRegistration({ email, username, startElo })
      return { error: friendlyAuthErrorMessage(error) }
    }

    // With email confirmations enabled, Supabase hides whether an email is taken
    // (enumeration protection): signing up with a registered email "succeeds" with
    // a fake user whose identities array is empty, and no email is sent. Detect
    // that instead of falsely telling the user a confirmation email is on its way.
    if (!data.session && data.user && data.user.identities?.length === 0) {
      return { error: null, emailAlreadyRegistered: true }
    }

    setPendingRegistration(null)

    // A session comes back immediately when email confirmation is disabled
    // (e.g. local/dev backends) — only the no-session case needs the user to
    // click a confirmation link before they can sign in.
    if (!data.session) {
      awaitingEmailConfirmation.value = { email, password }
      return { error: null, emailConfirmationRequired: true }
    }

    return { error: null }
  }

  async function retryPendingRegistration(password: string): Promise<AuthActionResult> {
    const pending = pendingRegistration.value
    if (!pending) return { error: 'No pending registration to retry' }
    return signUp(pending.email, password, pending.username, pending.startElo)
  }

  async function signIn(email: string, password: string): Promise<AuthActionResult> {
    if (!supabase) return { error: 'Backend not configured' }
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (!error) return { error: null }
    return {
      error: friendlyAuthErrorMessage(error),
      invalidCredentials: error.code === 'invalid_credentials',
    }
  }

  // Retries signing in with the credentials captured at signup, once the user
  // says they've clicked the confirmation link — avoids asking them to retype
  // the password just to find out whether it's confirmed yet.
  async function retryLoginAfterConfirmation(): Promise<AuthActionResult> {
    const pending = awaitingEmailConfirmation.value
    if (!pending) return { error: 'No pending email confirmation to retry' }
    const result = await signIn(pending.email, pending.password)
    if (!result.error) awaitingEmailConfirmation.value = null
    return result
  }

  // Full reset: local data belongs to the account being left, not the next
  // (anonymous or different) user of this browser — wipe it and reload into
  // SetupModal rather than leaving stale profile/exercise state in memory.
  // Redirects to the start page rather than preserving the current path, so
  // e.g. logging out from /profile lands back on the board, not an empty
  // profile page, behind the modal. Works even without a cloud account (or
  // without a backend at all) — it's the general "reset my local progress" action.
  function resetLocalStateAndRedirect(): void {
    awaitingEmailConfirmation.value = null
    localStorage.clear()
    window.location.href = window.location.origin + '/'
  }

  async function signOut(): Promise<void> {
    if (supabase) await supabase.auth.signOut()
    resetLocalStateAndRedirect()
  }

  // Deletes the account server-side (see the delete_own_account RPC — cascades
  // to profiles/attempts) when signed in, then does the same local reset as
  // signOut(). Also the "clear local progress and start over" action for a
  // local-only (never-signed-in) user, in which case there's nothing to delete
  // server-side.
  async function deleteAccount(): Promise<void> {
    if (supabase && isSignedIn.value) {
      await supabase.rpc('delete_own_account')
      await supabase.auth.signOut()
    }
    resetLocalStateAndRedirect()
  }

  async function requestPasswordReset(email: string): Promise<AuthActionResult> {
    if (!supabase) return { error: 'Backend not configured' }
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    })
    return { error: error ? friendlyAuthErrorMessage(error) : null }
  }

  async function confirmPasswordRecovery(newPassword: string): Promise<AuthActionResult> {
    if (!supabase) return { error: 'Backend not configured' }
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    if (!error) passwordRecoveryRequested.value = false
    return { error: error ? friendlyAuthErrorMessage(error) : null }
  }

  function dismissPasswordRecovery(): void {
    passwordRecoveryRequested.value = false
    passwordRecoveryLinkInvalid.value = false
  }

  return {
    session,
    pendingRegistration,
    awaitingEmailConfirmation,
    passwordRecoveryRequested,
    passwordRecoveryLinkInvalid,
    isBackendConfigured,
    isSignedIn,
    userEmail,
    init,
    signUp,
    retryPendingRegistration,
    signIn,
    retryLoginAfterConfirmation,
    signOut,
    deleteAccount,
    requestPasswordReset,
    confirmPasswordRecovery,
    dismissPasswordRecovery,
  }
})
