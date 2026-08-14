// The Worker entry point (`main` in wrangler.jsonc). It exists for one reason: link
// previews. Only the routes below reach it — see `assets.run_worker_first` — and
// everything it does not recognize is handed straight back to the static assets.

import { BOARD_IMAGE_PATH } from './preview'
import { renderBoardImage, renderPreviewDocument, type PreviewEnv } from './handlers'

// Both views carry a puzzle fen in their URL (see useAppRouter.ts's buildRouteUrl).
const PREVIEWABLE_PATHS = new Set(['/train', '/analysis'])

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url)

    if (request.method !== 'GET' && request.method !== 'HEAD')
      return await env.ASSETS.fetch(request)
    if (url.pathname === BOARD_IMAGE_PATH) {
      return await renderBoardImage(request, url, env, context)
    }
    if (PREVIEWABLE_PATHS.has(url.pathname)) {
      return await renderPreviewDocument(request, url, env)
    }

    return await env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<PreviewEnv>
