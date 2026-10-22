import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Account, Bill, Book } from '../lib/api'
import { todayIn } from '../lib/labels'
import { currencies, fakeApi } from '../test/fakeApi'
import { renderApp } from '../test/render'
import { AccountDialog } from './AccountDialog'
import { BillPanel, InstallmentsPanel } from './AccountBill'

const book: Book = { id: 'b1', name: 'Personal', base_currency: 'VND', timezone: 'Asia/Ho_Chi_Minh', role: 'owner', archived_at: null, version: 1 }
const blank = { last4: null, in_net_worth: true, contact_id: null, note: null, credit_limit: null, annual_fee: null, statement_day: null,
  payment_due_day: null, installment: null, installment_fee: null, interest_rate_bp: null, archived_at: null, version: 3 }
const bank: Account = { ...blank, id: 'bank', name: 'Vietcombank', kind: 'checking', currency: 'VND', balance: 20_000_000 }
const cash: Account = { ...blank, id: 'cash', name: 'Cash', kind: 'cash', currency: 'VND', balance: 900_000 }
const dollars: Account = { ...blank, id: 'usd', name: 'Dollars', kind: 'cash', currency: 'USD', balance: 50_000 }
const card: Account = { ...blank, id: 'card', name: '2in1', kind: 'credit_card', currency: 'VND', balance: -4_359_793,
  credit_limit: 10_000_000, statement_day: 25, payment_due_day: 10 }
const loan: Account = { ...blank, id: 'loan', name: 'Phone', kind: 'loan', currency: 'VND', balance: -12_000_000,
  installment: 1_000_000, payment_due_day: 15, installment_fee: 240_000, interest_rate_bp: 1_200 }

// A day relative to today in the book's timezone, as the API writes dates.
const inDays = (days: number) => {
  const d = new Date(`${todayIn(book.timezone)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
const cardBill: Bill = { kind: 'card', period_start: '2026-08-26', period_end: '2026-09-25', due_on: inDays(5), amount: 2_511_432,
  paid: 500_000, remaining: 2_011_432, owed_now: 4_359_793, interest: 0, interest_transaction_id: null, fee: 0, fee_transaction_id: null,
  pay_from: 'cash' }
const loanBill: Bill = { kind: 'loan', period_start: '2026-10-16', period_end: inDays(10), due_on: inDays(10), amount: 1_240_000, paid: 0,
  remaining: 1_240_000, owed_now: 12_000_000, interest: 120_000, interest_transaction_id: 'interest-id', fee: 240_000,
  fee_transaction_id: 'fee-id', pay_from: null }

function server(account: Account, bills: Bill | Bill[] | null) {
  return fakeApi({
    'GET /v1/currencies': currencies,
    'GET /v1/books/b1/contacts': [],
    'GET /v1/books/b1/accounts': [bank, cash, dollars, card, loan],
    [`GET /v1/books/b1/accounts/${account.id}/bills`]: bills === null ? [] : Array.isArray(bills) ? bills : [bills],
    [`PATCH /v1/books/b1/accounts/${account.id}`]: account,
    'POST /v1/books/b1/transactions': {},
  })
}
const panel = (account: Account, canPay = true) =>
  renderApp(<BillPanel book={book} account={account} minorUnit={0} canPay={canPay} />)
const posts = (api: ReturnType<typeof fakeApi>) => api.writes().filter((c) => c.method === 'POST').map((c) => c.body as Record<string, unknown>)

describe('the statement so far, once the last one is paid (msaving#82)', () => {
  const openBill: Bill = { ...cardBill, statement_open: true, period_start: '2026-10-02', period_end: '2026-11-01', due_on: '2026-11-15',
    amount: 861_798, paid: 0, remaining: 861_798, owed_now: 4_510_793, fee: 10_000, limit_used: 4_510_793,
    installments: [{ plan_id: 'p1', transaction_id: 't1', payee: 'Laptop', number: 1, months: 6, amount: 731_798 }],
    fees: [{ plan_id: 'p1', transaction_id: 'f1', payee: 'Laptop', amount: 10_000 }] }

  it('shows what it would ask for if it closed today, and when it closes and is due', async () => {
    server(card, openBill)
    await panel(card)
    expect(await screen.findByText('This statement: 2 Oct – 1 Nov')).toBeInTheDocument()
    expect(screen.getByText('Open')).toBeInTheDocument()
    expect(screen.getByText('Nothing left to pay on the statement of 1 Oct.')).toBeInTheDocument()
    expect(screen.getByText('Statement balance so far').parentElement).toHaveTextContent('₫851,798')
    expect(screen.getByText('Laptop · 1 of 6').parentElement).toHaveTextContent('₫731,798')
    expect(screen.getByText('Installment fees').parentElement).toHaveTextContent('₫10,000')
    expect(screen.getByText('Statement date').parentElement).toHaveTextContent('1 Nov 2026')
    expect(screen.getByText('Due').parentElement).toHaveTextContent('15 Nov 2026')
    expect(screen.getByText('To pay so far').parentElement).toHaveTextContent('₫861,798')
    expect(screen.queryByText('Paid since the statement')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pay' })).toBeInTheDocument()
  })

  it("shows last month's statement too while it has something to pay, each with Pay", async () => {
    server(card, [cardBill, { ...openBill, amount: 120_000, remaining: 120_000, fee: 0, installments: [], fees: [] }])
    await panel(card)
    expect(await screen.findByText('Statement 26 Aug – 25 Sept')).toBeInTheDocument()
    expect(screen.getByText('This statement: 2 Oct – 1 Nov')).toBeInTheDocument()
    expect(screen.queryByText(/Nothing left to pay on the statement/)).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Pay' })).toHaveLength(2)
    expect(screen.getAllByText('Owed now')).toHaveLength(1)
  })

  it('pays any amount, even with nothing left to pay', async () => {
    const api = server(card, { ...openBill, amount: 0, remaining: 0, fee: 0, installments: [], fees: [] })
    await panel(card)
    await userEvent.click(await screen.findByRole('button', { name: 'Pay' }))
    const amount = within(await screen.findByRole('dialog')).getByRole('textbox', { name: /amount/i })
    expect(amount).toHaveValue('')
    await userEvent.type(amount, '500000')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm payment' }))
    await waitFor(() => expect(posts(api)[0]?.entries).toEqual([{ account_id: 'cash', amount: -500_000 }, { account_id: 'card', amount: 500_000 }]))
  })
})

describe("a credit card's bill (msaving#37)", () => {
  it('shows the statement, what is paid and what is left, and when it is due', async () => {
    server(card, cardBill)
    await panel(card)
    expect(await screen.findByText('Statement 26 Aug – 25 Sept')).toBeInTheDocument()
    expect(screen.getByText('Statement balance').parentElement).toHaveTextContent('₫2,511,432')
    expect(screen.getByText('Paid since the statement').parentElement).toHaveTextContent('₫500,000')
    expect(screen.getByText('Remaining payable').parentElement).toHaveTextContent('₫2,011,432')
    expect(screen.getByText('5 days left')).toBeInTheDocument()
    expect(screen.getByText('Owed now').parentElement).toHaveTextContent('₫4,359,793')
  })

  it('pays it with a transfer from the account used last time, pre-filled and changeable', async () => {
    const api = server(card, cardBill)
    await panel(card)
    await userEvent.click(await screen.findByRole('button', { name: 'Pay' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByRole('combobox', { name: 'Pay from' })).toHaveTextContent('Cash')
    expect(dialog.getByRole('textbox', { name: /amount/i })).toHaveValue('2,011,432')
    await userEvent.click(dialog.getByRole('combobox', { name: 'Pay from' }))
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent)
    expect(options).toEqual([expect.stringContaining('Vietcombank'), expect.stringContaining('Cash'), expect.stringContaining('Phone')])  // same currency, owned first
    await userEvent.click(screen.getByRole('option', { name: /Vietcombank/ }))
    await userEvent.click(dialog.getByRole('button', { name: 'Confirm payment' }))
    await waitFor(() => expect(posts(api)).toHaveLength(1))
    expect(posts(api)[0]).toMatchObject({ type: 'transfer', occurred_on: todayIn(book.timezone), note: 'Statement to 25 Sept 2026',
      entries: [{ account_id: 'bank', amount: -2_011_432 }, { account_id: 'card', amount: 2_011_432 }] })
  })

  it('takes part of it, too', async () => {
    const api = server(card, cardBill)
    await panel(card)
    await userEvent.click(await screen.findByRole('button', { name: 'Pay' }))
    const amount = within(await screen.findByRole('dialog')).getByRole('textbox', { name: /amount/i })
    await userEvent.clear(amount)
    await userEvent.type(amount, '1000000')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm payment' }))
    await waitFor(() => expect(posts(api)[0]?.entries).toEqual([{ account_id: 'cash', amount: -1_000_000 }, { account_id: 'card', amount: 1_000_000 }]))
  })

  it('says when it is paid, or overdue', async () => {
    server(card, { ...cardBill, paid: 2_511_432, remaining: 0 })
    const { unmount } = await panel(card)
    expect(await screen.findByText('Paid', { selector: '.MuiChip-label' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pay' })).toBeInTheDocument()                // any amount, any time
    unmount()
    server(card, { ...cardBill, due_on: inDays(-2) })
    await panel(card)
    expect(await screen.findByText('Overdue')).toBeInTheDocument()
  })

  it("shows in the card's details, not while editing", async () => {
    server(card, cardBill)
    await renderApp(<AccountDialog book={book} account={card} onClose={() => {}} />)
    expect(await screen.findByText('Statement 26 Aug – 25 Sept')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.queryByText('Statement 26 Aug – 25 Sept')).not.toBeInTheDocument()
  })

  it('asks for the days it needs, and shows nothing to a viewer', async () => {
    server(card, null)
    const { unmount } = await panel(card)
    expect(await screen.findByText(/Add the statement day and the payment due day/)).toBeInTheDocument()
    unmount()
    const api = server(card, null)
    await panel(card, false)
    await waitFor(() => expect(api.calls.some((c) => c.path.endsWith('/bills'))).toBe(true))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe("a loan's installment (msaving#37)", () => {
  it('pays the installment with the fee once, recording the fee and the interest as expenses on the loan', async () => {
    const api = server(loan, loanBill)
    await panel(loan)
    expect(await screen.findByText("This month's installment")).toBeInTheDocument()
    expect(screen.getByText('Installment').parentElement).toHaveTextContent('₫1,000,000of which interest ₫120,000')
    expect(screen.getByText('Installment fee, once').parentElement).toHaveTextContent('₫240,000')
    await userEvent.click(screen.getByRole('button', { name: 'Pay' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByRole('combobox', { name: 'Pay from' })).toHaveTextContent('Vietcombank')   // no payment yet: what's owned first
    expect(dialog.getByRole('textbox', { name: /amount/i })).toHaveValue('1,240,000')
    expect(dialog.getByText(/120,000 of it is the month's interest/)).toBeInTheDocument()
    await userEvent.click(dialog.getByRole('button', { name: 'Confirm payment' }))
    await waitFor(() => expect(posts(api)).toHaveLength(3))
    expect(posts(api)).toEqual([
      expect.objectContaining({ id: 'fee-id', type: 'expense', note: 'Installment fee', entries: [{ account_id: 'loan', amount: -240_000 }] }),
      expect.objectContaining({ id: 'interest-id', type: 'expense', entries: [{ account_id: 'loan', amount: -120_000 }] }),
      expect.objectContaining({ type: 'transfer', entries: [{ account_id: 'bank', amount: -1_240_000 }, { account_id: 'loan', amount: 1_240_000 }] }),
    ])
  })

  it('takes the installment, payment day and fee in the loan\'s details', async () => {
    const api = server(loan, null)
    await renderApp(<AccountDialog book={book} account={{ ...loan, installment: null, installment_fee: null, payment_due_day: null }}
      editing onClose={() => {}} />)
    await userEvent.type(await screen.findByRole('textbox', { name: 'Monthly installment' }), '1000000')
    await userEvent.type(screen.getByRole('textbox', { name: 'Installment fee' }), '240000')
    await userEvent.click(screen.getByRole('combobox', { name: 'Payment day each month' }))
    await userEvent.click(await screen.findByRole('option', { name: '15' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ installment: 1_000_000, installment_fee: 240_000, payment_due_day: 15 })
  })
})

describe('installments on a card (msaving#71)', () => {
  const withPlans: Bill = { ...cardBill, amount: 2_120_000, paid: 0, remaining: 2_120_000, fee: 120_000, limit_used: 1_000_000,
    installments: [{ plan_id: 'p1', transaction_id: 'laptop', payee: 'Laptop', number: 3, months: 6, amount: 1_000_000 }],
    fees: [{ plan_id: 'p1', transaction_id: 'fee-1', payee: 'Laptop', amount: 120_000 }] }
  const plan = { id: 'p1', account_id: 'card', transaction_id: 'laptop', payee: 'Laptop', occurred_on: '2026-09-10', amount: 6_000_000,
    months: 6, converted_on: '2026-09-10', first_statement: '2026-09-25', fee: 120_000, fee_split: false, counts_toward_limit: false,
    ended_on: null, version: 2, installment: 1_000_000, billed: 3, left_to_bill: 3_000_000 }
  const elsewhere = { ...plan, id: 'p2', account_id: 'other-card', payee: 'Phone' }

  it("shows this statement's installments, their fees and the limit used", async () => {
    server(card, withPlans)
    await panel(card)
    expect(await screen.findByText('Laptop · 3 of 6')).toBeInTheDocument()
    expect(screen.getByText('Laptop · 3 of 6').parentElement).toHaveTextContent('₫1,000,000')
    expect(screen.getByText('Installment fees').parentElement).toHaveTextContent('₫120,000')
    expect(screen.getByText('Limit used').parentElement).toHaveTextContent('₫1,000,000 of ₫10,000,000')
  })

  it('records each fee on the card, then the payment', async () => {
    const api = server(card, withPlans)
    await panel(card)
    await userEvent.click(await screen.findByRole('button', { name: 'Pay' }))
    const dialog = within(await screen.findByRole('dialog'))
    await userEvent.click(dialog.getByRole('button', { name: 'Confirm payment' }))
    await waitFor(() => expect(posts(api)).toHaveLength(2))
    expect(posts(api)[0]).toMatchObject({ id: 'fee-1', type: 'expense', note: 'Installment fee: Laptop',
      entries: [{ account_id: 'card', amount: -120_000 }] })
    expect(posts(api)[1]).toMatchObject({ type: 'transfer', entries: [{ account_id: 'cash', amount: -2_120_000 }, { account_id: 'card', amount: 2_120_000 }] })
  })

  it("lists the card's plans, and ends one early", async () => {
    const api = fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/installments': [plan, elsewhere],
      'PATCH /v1/books/b1/installments/p1': plan,
    })
    await renderApp(<InstallmentsPanel book={book} account={card} minorUnit={0} canEdit />)
    expect(await screen.findByText('Laptop')).toBeInTheDocument()
    expect(screen.queryByText('Phone')).not.toBeInTheDocument()
    expect(screen.getByText(/3 of 6 billed · ₫1,000,000 a month · ₫3,000,000 left to bill/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'End early' }))
    const confirm = within(await screen.findByRole('dialog'))
    expect(confirm.getByText('Everything left is billed on the next statement.')).toBeInTheDocument()
    await userEvent.click(confirm.getByRole('button', { name: 'End early' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toEqual({ version: 2, ended_on: todayIn(book.timezone) })
  })

  it("shows on the card's details", async () => {
    fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/contacts': [],
      'GET /v1/books/b1/accounts': [card],
      'GET /v1/books/b1/accounts/card/bills': [withPlans],
      'GET /v1/books/b1/installments': [plan],
    })
    await renderApp(<AccountDialog book={book} account={card} onClose={() => {}} />)
    expect(await screen.findByRole('heading', { name: 'Installments' })).toBeInTheDocument()
  })
})
