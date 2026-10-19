import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './en.json'
import vi from './vi.json'

// Vietnamese first (default), English second. Before sign-in the choice is
// remembered in this browser; once signed in, the user's saved language
// (users.language) takes over.
export const languages = ['vi', 'en'] as const
export type Language = (typeof languages)[number]

const KEY = 'msaving.language'

function remembered(): Language {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'en' ? 'en' : 'vi'
  } catch {
    return 'vi'
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
  resources: { vi: { translation: vi }, en: { translation: en } },
  lng: remembered(),
  fallbackLng: 'vi',
  interpolation: { escapeValue: false }, // React already escapes
})

export const currentLanguage = (): Language => (i18n.language === 'en' ? 'en' : 'vi')

export default i18n
