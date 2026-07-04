import { ref } from 'vue'
import { locales, type Locale } from '@/locales'
import type { en } from '@/locales/en'
import { detectBrowserLocale } from '@/utils/detectLocale'

// Shared across every caller (same singleton pattern as useStockfishEngine). Starts
// from browser detection so even the pre-profile setup wizard renders in the right
// language; the profile's persisted choice overrides it as soon as it loads (App.vue).
const currentLocale = ref<Locale>(detectBrowserLocale())

export function useLocale() {
  function t(
    selectText: (strings: typeof en) => string,
    vars?: Record<string, string | number>,
  ): string {
    let text = selectText(locales[currentLocale.value])
    if (vars) {
      for (const [name, value] of Object.entries(vars)) {
        text = text.replaceAll(`{${name}}`, String(value))
      }
    }
    return text
  }

  function setLocale(locale: Locale): void {
    currentLocale.value = locale
  }

  return { currentLocale, t, setLocale }
}
