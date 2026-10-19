// Money is an integer in minor units everywhere (VND 0 decimals, USD 2, KWD 3).
// These helpers never go through floats: parsing works on the digits as text.

export type Locale = 'vi' | 'en'
const intlLocale: Record<Locale, string> = { vi: 'vi-VN', en: 'en-US' }

// Separators for the language, read from Intl so typing matches what's shown.
function separators(locale: Locale): { group: string; decimal: string } {
  const parts = new Intl.NumberFormat(intlLocale[locale]).formatToParts(1234567.5)
  return {
    group: parts.find((p) => p.type === 'group')?.value ?? ',',
    decimal: parts.find((p) => p.type === 'decimal')?.value ?? '.',
  }
}

// 125000000 (VND) -> "125.000.000 ₫" in Vietnamese, "₫125,000,000" in English.
export function formatMoney(minor: number, currency: string, minorUnit: number, locale: Locale): string {
  const fmt = new Intl.NumberFormat(intlLocale[locale], {
    style: 'currency',
    currency,
    minimumFractionDigits: minorUnit,
    maximumFractionDigits: minorUnit,
  })
  // Split into whole and fraction as integers, then let Intl format a decimal
  // string, so no float rounding touches the value.
  const negative = minor < 0
  const abs = Math.abs(minor)
  const scale = 10 ** minorUnit
  const whole = Math.trunc(abs / scale)
  const fraction = String(abs - whole * scale).padStart(minorUnit, '0')
  const text = `${negative ? '-' : ''}${whole}${minorUnit ? `.${fraction}` : ''}`
  return fmt.format(text as unknown as number) // Intl accepts decimal strings exactly
}

// What the user typed -> minor units, or null if it isn't a number with at most
// minorUnit decimals. In Vietnamese "." groups thousands, so "1.250" for VND is
// 1250, and "1.250,5" for USD is 125050.
export function parseAmount(input: string, minorUnit: number, locale: Locale): number | null {
  const { group, decimal } = separators(locale)
  let s = input.trim().replaceAll(' ', '').replaceAll(' ', '')
  let negative = false
  if (s.startsWith('-')) {
    negative = true
    s = s.slice(1)
  }
  s = s.replaceAll(group, '')
  const [whole, fraction = '', extra] = s.split(decimal)
  if (extra !== undefined || !/^\d*$/.test(whole) || !/^\d*$/.test(fraction)) return null
  if (whole === '' && fraction === '') return null
  if (fraction.length > minorUnit) return null
  const minor = Number((whole || '0') + fraction.padEnd(minorUnit, '0'))
  if (!Number.isSafeInteger(minor)) return null
  return negative && minor !== 0 ? -minor : minor
}

// Groups thousands while typing: "1250000" -> "1.250.000" (vi). Leaves input it
// can't read alone, so the field never fights the user.
export function groupWhileTyping(input: string, locale: Locale): string {
  const { group, decimal } = separators(locale)
  const negative = input.trim().startsWith('-')
  const body = input.replaceAll(group, '').replace(/^\s*-/, '')
  const [whole, ...rest] = body.split(decimal)
  if (!/^\d*$/.test(whole)) return input
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, group)
  return (negative ? '-' : '') + grouped + (rest.length ? decimal + rest.join(decimal) : '')
}

// Minor units -> the text a user would type, e.g. 125050 USD -> "1.250,50" (vi),
// so an edit form starts from the saved amount.
export function amountText(minor: number, minorUnit: number, locale: Locale): string {
  const { decimal } = separators(locale)
  const abs = Math.abs(minor)
  const scale = 10 ** minorUnit
  const whole = Math.trunc(abs / scale)
  const fraction = String(abs - whole * scale).padStart(minorUnit, '0')
  return groupWhileTyping(`${minor < 0 ? '-' : ''}${whole}${minorUnit ? decimal + fraction : ''}`, locale)
}
