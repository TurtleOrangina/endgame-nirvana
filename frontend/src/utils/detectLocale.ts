import { locales, type Locale } from '@/locales'

function toSupportedLocale(languageTag: string): Locale | null {
  const primarySubtag = languageTag.split('-')[0]?.toLowerCase()
  return primarySubtag && primarySubtag in locales ? (primarySubtag as Locale) : null
}

export function detectBrowserLocale(): Locale {
  const languageTags = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const tag of languageTags) {
    const supported = toSupportedLocale(tag)
    if (supported) return supported
  }
  return 'en'
}
