export type AppView = 'training' | 'analysis' | 'profile'

export type LegalPage = 'impressum' | 'datenschutz'

// Legal pages are plain static content reached via full page navigation (see LegalPage.vue),
// never via pushState, so they only need to be recognized on initial load.
export function matchLegalRoute(pathname: string): LegalPage | null {
  if (pathname === '/impressum') return 'impressum'
  if (pathname === '/datenschutz') return 'datenschutz'
  return null
}

export function parseCurrentRoute(): { view: AppView; fen: string | null } {
  const path = window.location.pathname
  const params = new URLSearchParams(window.location.search)
  const fen = params.get('puzzle')

  if (path === '/profile') return { view: 'profile', fen: null }
  if (path === '/analysis') return { view: 'analysis', fen }
  return { view: 'training', fen }
}

// rawFen uses underscores for spaces and unencoded slashes, e.g. 8/5K2/8_w_-_-_0_1
export function buildRouteUrl(view: AppView, rawFen?: string | null): string {
  if (view === 'profile') return '/profile'
  const base = view === 'analysis' ? '/analysis' : '/train'
  if (rawFen) return `${base}?puzzle=${rawFen}`
  return base
}
