import { currentLanguage } from '../i18n'

// Currency names come from the browser in the user's language, falling back to
// the English name the API sends.
export function currencyLabel(code: string, fallback?: string): string {
  try {
    const name = new Intl.DisplayNames([currentLanguage() === 'vi' ? 'vi-VN' : 'en'], { type: 'currency' }).of(code)
    return `${code} · ${name ?? fallback ?? code}`
  } catch {
    return `${code} · ${fallback ?? code}`
  }
}

export const deviceTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

// Today as YYYY-MM-DD in a book's time zone (dates are the book's days).
export const todayIn = (timezone: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())
export const timeIn = (timezone: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date())
