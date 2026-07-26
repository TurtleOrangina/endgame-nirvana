import { createApp } from 'vue'
import { createPinia } from 'pinia'
import '@lichess-org/chessground/assets/chessground.base.css'
import '@lichess-org/chessground/assets/chessground.brown.css'
import '@/assets/board-appearance.css'
import App from './App.vue'
import { useBoardAudio } from '@/composables/useBoardAudio'
import { registerServiceWorker } from '@/registerServiceWorker'

// Kicked off before the engine's own (deferred, idle-scheduled) download so these
// small, always-needed assets are requested first and finish caching well ahead of it,
// keeping the app fully usable offline afterwards. The board and piece images are the
// other half of this and are preloaded from App.vue instead, since which ones to fetch
// first depends on the profile's appearance settings.
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
