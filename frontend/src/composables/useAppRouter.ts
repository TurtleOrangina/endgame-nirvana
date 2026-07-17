export type AppView =
  | 'training'
  | 'analysis'
  | 'solveProgress'
  | 'browseExercises'
  | 'settings'
  | 'about'

export type StandalonePageView = Exclude<AppView, 'training' | 'analysis'>

// Standalone pages (unlike training/analysis) carry no puzzle fen in their URL and
// leave the training view mounted-but-hidden underneath.
export function isStandalonePageView(view: AppView): view is StandalonePageView {
  return view !== 'training' && view !== 'analysis'
}

export type LegalPage = 'impressum' | 'datenschutz'

// Legal pages are plain static content reached via full page navigation (see LegalPage.vue),
// never via pushState, so they only need to be recognized on initial load.
export function matchLegalRoute(pathname: string): LegalPage | null {
  if (pathname === '/impressum') return 'impressum'
  if (pathname === '/datenschutz') return 'datenschutz'
  return null
}

export function parseCurrentRoute(): {
  view: AppView
  fen: string | null
  category: string | null
} {
  const path = window.location.pathname
  const params = new URLSearchParams(window.location.search)
  const fen = params.get('puzzle')

  if (path === '/progress') return { view: 'solveProgress', fen: null, category: null }
  if (path === '/browse') {
    return { view: 'browseExercises', fen: null, category: params.get('category') }
  }
  if (path === '/settings') return { view: 'settings', fen: null, category: null }
  if (path === '/about') return { view: 'about', fen: null, category: null }
  if (path === '/analysis') return { view: 'analysis', fen, category: null }
  return { view: 'training', fen, category: null }
}

// rawFen uses underscores for spaces and unencoded slashes, e.g. 8/5K2/8_w_-_-_0_1
export function buildRouteUrl(
  view: AppView,
  rawFen?: string | null,
  category?: string | null,
): string {
  if (view === 'solveProgress') return '/progress'
  if (view === 'settings') return '/settings'
  if (view === 'about') return '/about'
  if (view === 'browseExercises') {
    return category ? `/browse?category=${encodeURIComponent(category)}` : '/browse'
  }
  const base = view === 'analysis' ? '/analysis' : '/train'
  if (rawFen) return `${base}?puzzle=${rawFen}`
  return base
}
