import { describe, expect, it } from 'vitest'
import { adjustmentFor, detailsPayload, showsLast4 } from './accounts'
import { accountKinds } from './api'

const all = { note: '  Main card  ', creditLimit: 50_000_000, annualFee: 499_000, statementDay: '25', dueDay: '10', interestBp: 2_880,
  installment: 1_000_000, installmentFee: 240_000 }

describe('account details by kind (waterflow#17)', () => {
  it('sends a credit card every detail', () => {
    expect(detailsPayload('credit_card', all)).toEqual({
      note: 'Main card', credit_limit: 50_000_000, annual_fee: 499_000, statement_day: 25, payment_due_day: 10, interest_rate_bp: 2_880,
      installment: null, installment_fee: null,
    })
  })

  it('sends a loan its installment, fee and payment day (waterflow#37)', () => {
    expect(detailsPayload('loan', all)).toEqual({
      note: 'Main card', credit_limit: null, annual_fee: null, statement_day: null, payment_due_day: 10, interest_rate_bp: 2_880,
      installment: 1_000_000, installment_fee: 240_000,
    })
  })

  it('clears what a kind does not take, so changing the kind clears it on the server', () => {
    expect(detailsPayload('savings', all)).toEqual({
      note: 'Main card', credit_limit: null, annual_fee: null, statement_day: null, payment_due_day: null, interest_rate_bp: 2_880,
      installment: null, installment_fee: null,
    })
    for (const kind of ['cash', 'checking', 'investment', 'other_asset', 'other_liability'] as const) {
      expect(detailsPayload(kind, all)).toMatchObject({ note: 'Main card', credit_limit: null, statement_day: null, interest_rate_bp: null })
    }
    for (const kind of ['loan', 'lent'] as const) expect(detailsPayload(kind, all).interest_rate_bp).toBe(2_880)
  })

  it('sends an empty note and an unset day as none', () => {
    expect(detailsPayload('credit_card', { ...all, note: '   ', statementDay: '', dueDay: '' })).toMatchObject({
      note: null, statement_day: null, payment_due_day: null,
    })
  })

  it('shows card digits only where there is a card or account number, or digits already saved', () => {
    expect(accountKinds.filter((k) => showsLast4(k, null))).toEqual(['checking', 'savings', 'investment', 'credit_card', 'loan'])
    expect(showsLast4('cash', '1234')).toBe(true)
  })
})

describe('setting a balance from the edit dialog (waterflow#24)', () => {
  it('adjusts an asset by the difference', () => {
    expect(adjustmentFor('cash', 7_000_000, 6_936_000)).toBe(64_000)
    expect(adjustmentFor('checking', 100, 250)).toBe(-150)
  })

  it('reads what is owed as negative', () => {
    // A card owing 9,896,000 set to owe 10,000,000: 104,000 more spent.
    expect(adjustmentFor('credit_card', 10_000_000, -9_896_000)).toBe(-104_000)
    expect(adjustmentFor('loan', 0, -12_000_000)).toBe(12_000_000)
  })

  it('is zero when nothing changed', () => {
    expect(adjustmentFor('savings', 5_000, 5_000)).toBe(0)
    expect(adjustmentFor('other_liability', 2_000, -2_000)).toBe(0)
  })
})
