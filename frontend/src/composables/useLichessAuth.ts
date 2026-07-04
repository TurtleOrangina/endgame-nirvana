import { computed, ref } from 'vue'
import { useUserProfileStore } from '@/stores/userProfile'

const PLACEHOLDER_CLIENT_ID = 'endgame-nirvana'
const LICHESS_OAUTH_URL = 'https://lichess.org/oauth'
const LICHESS_TOKEN_URL = 'https://lichess.org/api/token'
const LICHESS_ACCOUNT_URL = 'https://lichess.org/api/account'

const PENDING_USERNAME_STORAGE_KEY = 'lichess_pending_username'

// The OAuth access token only ever proves ownership at link time (to fetch the
// username below) — nothing downstream calls the Lichess API with it — so it's
// kept device-local rather than synced. The linked state itself lives on the
// user profile (lichessUsername) so it follows the account across devices.
const token = ref<string | null>(localStorage.getItem('lichess_token'))

// Holds the linked username when the redirect callback fires before a profile
// exists yet (mid signup-wizard link, see SetupModal's 'lichess' step) — there's
// nowhere to persist it to the backend until SetupModal calls createProfile with it.
const pendingUsername = ref<string | null>(localStorage.getItem(PENDING_USERNAME_STORAGE_KEY))

function clearPendingUsername(): void {
  localStorage.removeItem(PENDING_USERNAME_STORAGE_KEY)
  pendingUsername.value = null
}

// Moves a pending mid-wizard link onto the profile once one exists. Called from the
// OAuth redirect callback (profile may already exist), from SetupModal when the wizard
// finishes, and from sync's pullRemoteState — the pulled cloud profile knows nothing
// about a link made during signup, so applying the pending username after the pull is
// what keeps it from being stomped by the "cloud wins" merge.
function applyPendingUsernameToProfile(): void {
  const userProfileStore = useUserProfileStore()
  if (!pendingUsername.value || !userProfileStore.profile) return
  userProfileStore.setLichessUsername(pendingUsername.value)
  clearPendingUsername()
}

function base64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function startLinkFlow(): Promise<void> {
  const verifierBytes = new Uint8Array(96)
  crypto.getRandomValues(verifierBytes)
  const codeVerifier = base64url(verifierBytes.buffer)

  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  const codeChallenge = base64url(hashBuffer)

  sessionStorage.setItem('lichess_code_verifier', codeVerifier)

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: PLACEHOLDER_CLIENT_ID,
    redirect_uri: window.location.origin + window.location.pathname,
    scope: 'preference:read',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })

  window.location.href = `${LICHESS_OAUTH_URL}?${params.toString()}`
}

async function handleRedirectCallback(): Promise<void> {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')
  if (!code) return

  history.replaceState({}, '', window.location.pathname)

  const verifier = sessionStorage.getItem('lichess_code_verifier')
  if (!verifier) return
  sessionStorage.removeItem('lichess_code_verifier')

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: window.location.origin + window.location.pathname,
    client_id: PLACEHOLDER_CLIENT_ID,
  })

  const tokenResponse = await fetch(LICHESS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!tokenResponse.ok) return

  const tokenData = (await tokenResponse.json()) as { access_token?: string }
  const accessToken = tokenData.access_token
  if (!accessToken) return

  const accountResponse = await fetch(LICHESS_ACCOUNT_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!accountResponse.ok) return

  const accountData = (await accountResponse.json()) as { username?: string }
  const username = accountData.username
  if (!username) return

  localStorage.setItem('lichess_token', accessToken)
  token.value = accessToken

  localStorage.setItem(PENDING_USERNAME_STORAGE_KEY, username)
  pendingUsername.value = username
  applyPendingUsernameToProfile()
}

function unlinkAccount(): void {
  localStorage.removeItem('lichess_token')
  token.value = null
  clearPendingUsername()
  useUserProfileStore().setLichessUsername(null)
}

export function useLichessAuth() {
  const userProfileStore = useUserProfileStore()
  const lichessUsername = computed(
    () => userProfileStore.profile?.lichessUsername ?? pendingUsername.value,
  )
  const isLinked = computed(() => lichessUsername.value !== null)
  return {
    isLinked,
    token,
    lichessUsername,
    startLinkFlow,
    handleRedirectCallback,
    unlinkAccount,
    clearPendingUsername,
    applyPendingUsernameToProfile,
  }
}
