import { createApp } from 'vue'
import { createPinia } from 'pinia'
import '@lichess-org/chessground/assets/chessground.base.css'
import '@lichess-org/chessground/assets/chessground.brown.css'
import '@/assets/pieces-maestro.css'
import '@/assets/chess-wood.css'
import App from './App.vue'
import { preloadEssentialImages } from '@/utils/preloadAssets'
import { useBoardAudio } from '@/composables/useBoardAudio'
import { registerServiceWorker } from '@/registerServiceWorker'

// Kicked off before the engine's own (deferred, idle-scheduled) download so these
// small, always-needed assets — every piece, every board sound — are requested first
// and finish caching well ahead of it, keeping the app fully usable offline afterwards.
preloadEssentialImages()
useBoardAudio()
// Only registered in production builds — under `vp dev` it would cache dev-server
// responses (including ones from before a code change) and keep serving them stale
// regardless of what the dev server now returns, masking the very changes being tested.
if (import.meta.env.PROD) {
  registerServiceWorker()
}

const app = createApp(App)
app.use(createPinia())
app.mount('#app')
