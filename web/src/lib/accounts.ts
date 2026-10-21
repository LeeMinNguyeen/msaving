import { interestKinds, last4Kinds, liabilityKinds, type AccountKind } from './api'

// As the API wants them: the details that don't belong to the kind are sent as
// null, so changing an account's kind clears them.
export type Details = {
  note: string
  creditLimit: number | null
  annualFee: number | null
  statementDay: string // '' = none, else '1' to '31'
  dueDay: string // a card's repayment day, a loan's payment day
  installment: number | null
  installmentFee: number | null
  interestBp: number | null // hundredths of a percent a year
}

export function detailsPayload(kind: AccountKind, d: Details) {
  const card = kind === 'credit_card'
  const loan = kind === 'loan'
  return {
    note: d.note.trim() || null,
    credit_limit: card ? d.creditLimit : null,
    annual_fee: card ? d.annualFee : null,
    statement_day: card && d.statementDay ? Number(d.statementDay) : null,
    payment_due_day: (card || loan) && d.dueDay ? Number(d.dueDay) : null,
    installment: loan ? d.installment : null,
    installment_fee: loan ? d.installmentFee : null,
    interest_rate_bp: interestKinds.includes(kind) ? d.interestBp : null,
  }
}

// Card or account numbers make sense only for some kinds; an account that
// already has digits keeps the field so they can be cleared.
export const showsLast4 = (kind: AccountKind, existing: string | null | undefined) => last4Kinds.includes(kind) || !!existing

// A balance as typed in an account's edit dialog, as the ledger holds it: what's
// owed (credit card, loan) is typed positive and is negative in the ledger.
export const ledgerBalance = (kind: AccountKind, typed: number) => (liabilityKinds.includes(kind) ? -typed : typed)

// The adjustment that takes an account from its balance now to the one typed
// in its edit dialog.
export function adjustmentFor(kind: AccountKind, typed: number, balanceNow: number): number {
  return ledgerBalance(kind, typed) - balanceNow
}
