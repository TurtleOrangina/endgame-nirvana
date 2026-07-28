<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useExercisesStore } from '@/stores/exercises'
import { useUserProfileStore } from '@/stores/userProfile'
import { useAuthStore } from '@/stores/auth'
import { useSyncStore } from '@/stores/sync'
import { useStockfishEngine } from '@/composables/useStockfishEngine'
import { useLichessAuth } from '@/composables/useLichessAuth'
import {
  parseCurrentRoute,
  buildRouteUrl,
  matchLegalRoute,
  isStandalonePageView,
  type AppView,
} from '@/composables/useAppRouter'
import { useLocale } from '@/composables/useLocale'
import {
  applyBoardTheme,
  applyPieceSet,
  boardThemeOrDefault,
  pieceSetOrDefault,
} from '@/utils/boardAppearance'
import { prefetchAllAppearanceAssets, preloadActiveAppearanceAssets } from '@/utils/preloadAssets'
import AppHeader from '@/components/AppHeader.vue'
import SetupModal from '@/components/SetupModal.vue'
import PasswordRecoveryModal from '@/components/PasswordRecoveryModal.vue'
import EmailConfirmationModal from '@/components/EmailConfirmationModal.vue'
import TrainingPage from '@/pages/TrainingPage.vue'
import SolveProgressPage from '@/pages/SolveProgressPage.vue'
import BrowseExercisesPage from '@/pages/BrowseExercisesPage.vue'
import SettingsPage from '@/pages/SettingsPage.vue'
import AboutPage from '@/pages/AboutPage.vue'
import LegalPage from '@/pages/LegalPage.vue'
import type { ThemeMode } from '@/types'

const store = useExercisesStore()
const userProfileStore = useUserProfileStore()
const authStore = useAuthStore()
const syncStore = useSyncStore()
const lichessAuth = useLichessAuth()
const engine = useStockfishEngine()
const { t, setLocale } = useLocale()
const { passwordRecoveryRequested, emailConfirmationOutcome } = storeToRefs(authStore)
const { selectedCategory } = storeToRefs(store)
const { profile } = storeToRefs(userProfileStore)

type MainView = Exclude<AppView, 'analysis'>
const currentView = ref<MainView | 'impressum' | 'datenschutz'>('training')
const browseInitialCategory = ref<string | null>(null)
const trainingPage = ref<InstanceType<typeof TrainingPage> | null>(null)

// Decoupled from `profile` itself: signing up with email confirmation disabled (e.g. dev
// backends) authenticates and pulls a cloud profile immediately, part-way through the
// SetupModal wizard — closing on that alone would cut the wizard short mid-step.
// Only SetupModal's own `close` event (once its wizard is actually done) should dismiss it;
// a null profile (fresh app, or after sign-out) is the only thing that reopens it.
// Starts closed rather than `!profile.value`: at setup time `userProfileStore.load()` hasn't
// run yet (it awaits `authStore.init()` in `onMounted` below), so `profile` is always still
// null here even for returning users — opening eagerly would flash the modal on every refresh.
const setupWizardOpen = ref(false)
watch(profile, (p) => {
  if (!p) setupWizardOpen.value = true
})

onMounted(async () => {
  const legalPage = matchLegalRoute(window.location.pathname)
  if (legalPage) {
    currentView.value = legalPage
    return
  }

  // Deliberately not awaited: with a signed-in session whose access token has
  // expired, init() refreshes it over the network inside getSession(), which can
  // hang for many seconds on a bad connection — and everything below reads only
  // localStorage / static assets, so it must never wait behind that. The cloud
  // pull init() kicks off merges into the stores whenever it lands. Its only
  // ordering requirement — reading the recovery token before routing rewrites
  // the URL — is satisfied synchronously inside init() before its first await.
  void authStore.init()
  syncStore.setUpAutoFlushListeners()
  userProfileStore.load()
  if (!profile.value) setupWizardOpen.value = true

  // The OAuth redirect_uri deliberately omits the original query string (see
  // useLichessAuth's startLinkFlow), so any puzzle fen is already gone by the time we come
  // back — only the pathname (which view to return to) survives the round trip to Lichess.
  // The training state itself comes back via the pagehide session snapshot instead.
  // Google login comes back to this same origin with a `?code=` of its own, which
  // supabase-js consumes inside authStore.init() — only take the parameter when the
  // Lichess flow is the one that put it there (see hasPendingLinkFlow).
  if (lichessAuth.hasPendingLinkFlow()) {
    await lichessAuth.handleRedirectCallback()
  }

  const route = parseCurrentRoute()

  if (isStandalonePageView(route.view)) {
    await trainingPage.value?.loadCatalog(null)
    if (route.view === 'browseExercises') browseInitialCategory.value = route.category
    currentView.value = route.view
    history.replaceState(null, '', buildRouteUrl(route.view, undefined, route.category))
    await trainingPage.value?.restoreSession(
      { fen: null, wantsAnalysis: false },
      { updateUrl: false },
    )
  } else {
    await trainingPage.value?.loadCatalog(route.fen)
    await trainingPage.value?.restoreSession(
      { fen: route.fen, wantsAnalysis: route.view === 'analysis' },
      { updateUrl: true },
    )
  }

  window.addEventListener('popstate', handlePopState)

  // Last, and only once the app is idle: the board themes and piece sets the user
  // isn't currently using, so all of them stay selectable offline.
  prefetchAllAppearanceAssets(profile.value?.pieceSet, profile.value?.boardTheme)
})

onUnmounted(() => {
  window.removeEventListener('popstate', handlePopState)
  systemThemeQuery.removeEventListener('change', applySystemTheme)
})

function handlePopState(): void {
  const route = parseCurrentRoute()

  if (isStandalonePageView(route.view)) {
    if (route.view === 'browseExercises') browseInitialCategory.value = route.category
    currentView.value = route.view
    return
  }

  currentView.value = 'training'
  trainingPage.value?.applyRoute(route)
}

const systemThemeQuery = window.matchMedia('(prefers-color-scheme: light)')

function applyTheme(mode: ThemeMode): void {
  const resolved = mode === 'system' ? (systemThemeQuery.matches ? 'light' : 'dark') : mode
  document.documentElement.dataset.theme = resolved
}

function applySystemTheme(): void {
  if (profile.value?.themeMode === 'system') applyTheme('system')
}

systemThemeQuery.addEventListener('change', applySystemTheme)

watch(
  () => profile.value?.themeMode,
  (mode) => applyTheme(mode ?? 'dark'),
  { immediate: true },
)

// Until a profile exists (first run, setup wizard) the stylesheet's own fallbacks —
// the same wood4 board and maestro pieces — are what's on screen, so there is no
// visible switch when these first apply.
watch(
  () => profile.value?.boardTheme,
  (boardTheme) => {
    applyBoardTheme(boardThemeOrDefault(boardTheme))
    preloadActiveAppearanceAssets(profile.value?.pieceSet, boardTheme)
  },
  { immediate: true },
)

watch(
  () => profile.value?.pieceSet,
  (pieceSet) => {
    applyPieceSet(pieceSetOrDefault(pieceSet))
    preloadActiveAppearanceAssets(pieceSet, profile.value?.boardTheme)
  },
  { immediate: true },
)

// While no profile exists yet (first run, setup wizard) the browser-detected
// default from useLocale stays in effect.
watch(
  () => profile.value?.language,
  (language) => {
    if (language) setLocale(language)
  },
  { immediate: true },
)

// While no profile exists yet the engine's own default (physical-core estimate) applies.
watch(
  () => profile.value?.engineThreads,
  (threads) => {
    if (threads !== undefined) engine.setThreadCount(threads)
  },
  { immediate: true },
)

// AppHeader is only ever rendered outside the impressum/datenschutz branch (see template),
// but Vue's template compiler can't narrow currentView's type across that sibling v-if/v-else,
// so this computed does it explicitly for the :active-view prop.
const headerActiveView = computed(
  (): MainView =>
    currentView.value === 'impressum' || currentView.value === 'datenschutz'
      ? 'training'
      : currentView.value,
)

const pageTitle = computed(() => {
  switch (currentView.value) {
    case 'training':
      return trainingPage.value?.headerTitle ?? 'Endgame Nirvana'
    case 'solveProgress':
      return t((s) => s.profile.solveProgress)
    case 'browseExercises':
      return t((s) => s.profile.browseExercises)
    case 'settings':
      return t((s) => s.profile.settingsTitle)
    case 'about':
      return t((s) => s.about.navTitle)
    default:
      return 'Endgame Nirvana'
  }
})

const titleVersusPieces = computed(() =>
  currentView.value === 'training' ? (trainingPage.value?.headerVersusPieces ?? null) : null,
)

// The training view stays mounted (hidden via v-show) while other pages are shown, so
// the puzzle — including a retry in progress or an open analysis — continues exactly
// where it was when navigating back.
function navigateToView(view: MainView, category: string | null = null): void {
  if (view === 'training') {
    trainingPage.value?.navigateHere()
    currentView.value = 'training'
    return
  }
  // Opening Browse Exercises without an explicit target category falls back to the one
  // currently selected for training, so it comes up expanded and scrolled into view.
  if (view === 'browseExercises') browseInitialCategory.value = category ?? selectedCategory.value
  history.pushState(
    null,
    '',
    buildRouteUrl(view, undefined, view === 'browseExercises' ? browseInitialCategory.value : null),
  )
  currentView.value = view
}

function handleBrowseCategory(category: string | null): void {
  navigateToView('browseExercises', category)
}

function handleLoadPuzzle(payload: { exerciseId: string; transformCode: string }): void {
  trainingPage.value?.loadPuzzle(payload)
  currentView.value = 'training'
}
</script>

<template>
  <SetupModal v-if="setupWizardOpen" @close="setupWizardOpen = false" />
  <PasswordRecoveryModal v-if="passwordRecoveryRequested" />
  <EmailConfirmationModal v-if="emailConfirmationOutcome" />

  <div class="app">
    <LegalPage
      v-if="currentView === 'impressum' || currentView === 'datenschutz'"
      :page="currentView"
    />

    <div v-else class="page">
      <AppHeader
        :title="pageTitle"
        :versus-pieces="titleVersusPieces"
        :active-view="headerActiveView"
        :username="profile?.username ?? null"
        @navigate="navigateToView"
      />

      <SolveProgressPage
        v-if="currentView === 'solveProgress'"
        @browse-category="handleBrowseCategory"
        @load-puzzle="handleLoadPuzzle"
      />

      <BrowseExercisesPage
        v-else-if="currentView === 'browseExercises'"
        :initial-category="browseInitialCategory"
        @load-puzzle="handleLoadPuzzle"
      />

      <SettingsPage v-else-if="currentView === 'settings'" />

      <AboutPage v-else-if="currentView === 'about'" />

      <!-- Kept mounted (hidden via its own v-show) while the pages above are shown, so the
           puzzle in progress — board, move history, analysis — survives navigating away
           and back. -->
      <TrainingPage
        ref="trainingPage"
        :active="currentView === 'training'"
        :suppress-board-intro="setupWizardOpen"
      />
    </div>
  </div>
</template>

<style>
*,
*::before,
*::after {
  box-sizing: border-box;
}

:root {
  --bg: #1e1e2e;
  --fg: #d6d6d6;
  --surface: #242c46;
  --border: #3a3a4d;
  --muted: #aaaaaa;
  --hover-bg: #0f3460;
  --badge-bg: #333344;
  --accent: #c9a84c;
  --accent-darker: #a88a30;
  --track-bg: #333344;
  --tag-win-border: #2d6a4f;
  --tag-win-fg: #74c69d;
  --tag-draw-border: #555555;
  --tag-draw-fg: #aaaaaa;
  --btn-danger-border: #e06070;
  --btn-danger-fg: #e06070;
  --btn-danger-hover-bg: rgba(224, 96, 112, 0.12);
  --btn-success-bg: #2d7a50;
  --btn-success-border: #2d7a50;
  --btn-success-hover-bg: #236040;
  --color-solved: #74c69d;
  --color-failed: #e06070;
  --color-warning-border: #b8860b;
  --color-warning-fg: #e0b04c;
  --color-warning-bg: rgba(184, 134, 11, 0.12);

  /* Fixed (non-theme-switching) variants for text drawn on the always-dark
     difficulty chip background — the themed vars above are muted in light
     mode for use on light surfaces, which is illegible there. */
  --color-solved-on-dark-chip: #74c69d;
  --color-failed-on-dark-chip: #e06070;
  --color-warning-fg-on-dark-chip: #e0b04c;
}

:root[data-theme='light'] {
  --bg: #e3e3e9;
  --fg: #35354a;
  --surface: #eeeef2;
  --border: #c6c6d0;
  --muted: #666666;
  --hover-bg: #e8e8f2;
  --badge-bg: #e0e0ea;
  --accent: #dca200;
  --accent-darker: #b08400;
  --track-bg: #d8d8e2;
  --tag-win-border: #2d7a50;
  --tag-win-fg: #1a6b3a;
  --tag-draw-border: #999999;
  --tag-draw-fg: #555555;
  --btn-danger-border: #c0404f;
  --btn-danger-fg: #c0404f;
  --btn-danger-hover-bg: rgba(192, 64, 79, 0.08);
  --btn-success-bg: #2a7a4e;
  --btn-success-border: #2a7a4e;
  --btn-success-hover-bg: #1f6040;
  --color-solved: #2a7a4e;
  --color-failed: #c0404f;
  --color-warning-border: #b08400;
  --color-warning-fg: #8a6800;
  --color-warning-bg: rgba(176, 132, 0, 0.1);
}

html {
  /* Off-screen elements that are only hidden via opacity (e.g. the move-counter
     tooltips in MoveCounters.vue) still expand the document's scrollable area
     even though nothing is visibly overflowing — clip it at the root instead of
     chasing every individual source. */
  overflow-x: hidden;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: system-ui, sans-serif;
  min-height: 100vh;
  overflow-x: hidden;
}
</style>
<style scoped>
.app {
  padding: 1.5rem 1rem 3rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.25rem;
}

.page {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  /* The width every page (and the header above them) caps itself to, so the header —
     and with it the Menu button — sits in exactly the same place on all of them.
     TrainingPage is the one page whose width isn't a free choice: its board is square,
     so it grows until either the viewport's width or its height runs out. This matches
     the rendered width of that layout — .board-area + its 2rem gap + the 280px sidebar —
     which is why the height enters into it. */
  --page-content-width: min(calc(100vw - 40px - 2rem), calc(100vh - 5rem + 280px));
}

/* Below TrainingPage's two-col breakpoint the board stacks above the sidebar and no longer
   drives the width, so every page falls back to the plain single-column cap. */
@media (max-width: 720px) {
  .page {
    --page-content-width: 720px;
  }
}
</style>
