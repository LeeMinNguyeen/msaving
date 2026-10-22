import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './en.json'
import vi from './vi.json'

// Every screen opens in the language this browser remembers: the signed-in user's (users.language), kept after
// signing out, or the one picked before sign-in. English when it remembers none.
export const languages = ['en', 'vi'] as const
export type Language = (typeof languages)[number]

const KEY = 'msaving.language'
const known = (v: string | null | undefined): Language => languages.find((l) => l === v) ?? 'en'

function remembered(): Language {
  try {
    return known(localStorage.getItem(KEY))
  } catch {
    return 'en'
  }
}

export function setLanguage(lang: Language) {
  try {
    localStorage.setItem(KEY, lang)
  } catch {
    // private mode: the choice lasts until the tab closes
  }
  if (i18n.language !== lang) void i18n.changeLanguage(lang)
  document.documentElement.lang = lang
}

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, vi: { translation: vi } },
  lng: remembered(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false }, // React already escapes
})
document.documentElement.lang = i18n.language

export const currentLanguage = (): Language => known(i18n.language)

export default i18n
