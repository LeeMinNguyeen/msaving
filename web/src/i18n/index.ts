import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { session } from '../auth/session'
import en from './en.json'
import vi from './vi.json'

// The screens before sign-in are in English. The signed-in user's language (users.language) is remembered in this
// browser, so a reload starts in it.
export const languages = ['en', 'vi'] as const
export type Language = (typeof languages)[number]

const KEY = 'msaving.language'

function remembered(): Language {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'vi' ? 'vi' : 'en'
  } catch {
    return 'en'
  }
}

export function showLanguage(lang: Language) {
  if (i18n.language !== lang) void i18n.changeLanguage(lang)
  document.documentElement.lang = lang
}

export function setLanguage(lang: Language) {
  try {
    localStorage.setItem(KEY, lang)
  } catch {
    // private mode: the choice lasts until the tab closes
  }
  showLanguage(lang)
}

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, vi: { translation: vi } },
  lng: session.token() ? remembered() : 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false }, // React already escapes
})
document.documentElement.lang = i18n.language

export const currentLanguage = (): Language => (i18n.language === 'vi' ? 'vi' : 'en')

export default i18n
