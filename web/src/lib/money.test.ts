import { describe, expect, it } from 'vitest'
import { amountText, formatMoney, groupWhileTyping, parseAmount } from './money'

const nbsp = (s: string) => s.replace(/[  ]/g, ' ')

describe('formatMoney', () => {
  it('formats by language and the currency decimals', () => {
    expect(nbsp(formatMoney(1_250_000, 'VND', 0, 'vi'))).toBe('1.250.000 ₫')
    expect(nbsp(formatMoney(1_250_000, 'VND', 0, 'en'))).toBe('₫1,250,000')
    expect(formatMoney(-45000, 'USD', 2, 'en')).toBe('-$450.00')
    expect(formatMoney(1234, 'KWD', 3, 'en').replace(/\s/g, ' ')).toContain('1.234')
  })

  it('keeps amounts too large for float cents exact', () => {
    expect(formatMoney(900_719_925_474_099, 'USD', 2, 'en')).toBe('$9,007,199,254,740.99')
  })
})

describe('parseAmount', () => {
  it('reads Vietnamese grouping', () => {
    expect(parseAmount('1.250', 0, 'vi')).toBe(1250)
    expect(parseAmount('1.250.000', 0, 'vi')).toBe(1_250_000)
    expect(parseAmount('1.250,5', 2, 'vi')).toBe(125_050)
  })

  it('reads English grouping', () => {
    expect(parseAmount('1,250.05', 2, 'en')).toBe(125_005)
    expect(parseAmount('-450', 2, 'en')).toBe(-45_000)
    expect(parseAmount('.5', 2, 'en')).toBe(50)
  })

  it('refuses what it cannot read exactly', () => {
    expect(parseAmount('1,5', 0, 'vi')).toBeNull() // VND has no decimals
    expect(parseAmount('1.234', 2, 'en')).toBeNull() // three decimals for USD
    expect(parseAmount('abc', 2, 'en')).toBeNull()
    expect(parseAmount('', 2, 'en')).toBeNull()
    expect(parseAmount('1.2.3', 2, 'en')).toBeNull()
  })
})

describe('groupWhileTyping', () => {
  it('groups the whole part as the user types', () => {
    expect(groupWhileTyping('1250000', 'vi')).toBe('1.250.000')
    expect(groupWhileTyping('1250000,5', 'vi')).toBe('1.250.000,5')
    expect(groupWhileTyping('-1250', 'en')).toBe('-1,250')
    expect(groupWhileTyping('12a', 'en')).toBe('12a')
  })

  it('drops leading zeros but keeps a zero before the decimals', () => {
    expect(groupWhileTyping('099999', 'en')).toBe('99,999')
    expect(groupWhileTyping('09', 'vi')).toBe('9')
    expect(groupWhileTyping('000', 'en')).toBe('0')
    expect(groupWhileTyping('0', 'en')).toBe('0')
    expect(groupWhileTyping('0.5', 'en')).toBe('0.5')
    expect(groupWhileTyping('0,5', 'vi')).toBe('0,5')
    expect(groupWhileTyping('-05', 'en')).toBe('-5')
    expect(groupWhileTyping('0.050', 'en')).toBe('0.050')
  })
})

describe('amountText', () => {
  it('turns minor units back into what parseAmount reads', () => {
    expect(amountText(125050, 2, 'vi')).toBe('1.250,50')
    expect(amountText(-1_250_000, 0, 'vi')).toBe('-1.250.000')
    expect(amountText(5, 2, 'en')).toBe('0.05')
    for (const [minor, unit] of [[125050, 2], [-7, 3], [1_000_000, 0]] as const) {
      expect(parseAmount(amountText(minor, unit, 'vi'), unit, 'vi')).toBe(minor)
      expect(parseAmount(amountText(minor, unit, 'en'), unit, 'en')).toBe(minor)
    }
  })
})
