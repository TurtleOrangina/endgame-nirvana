import { en } from '@/locales/en'
import { de } from '@/locales/de'

export const locales = { en, de }

export type Locale = keyof typeof locales
