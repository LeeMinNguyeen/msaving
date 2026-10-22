import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, Book, Transaction } from '../lib/api'
import { currencies, fakeApi } from '../test/fakeApi'
import { renderApp } from '../test/render'
import { TxnDialog } from './TxnDialog'

const book: Book = { id: 'b1', name: 'Personal', base_currency: 'VND', timezone: 'Asia/Ho_Chi_Minh', role: 'owner', archived_at: null, version: 1 }
const cash: Account = {
  id: 'cash', name: 'Cash', kind: 'cash', currency: 'VND', balance: 900_000, last4: null, in_net_worth: true, contact_id: null,
  note: null, credit_limit: null, annual_fee: null, statement_day: null, payment_due_day: null, installment: null,
  installment_fee: null, interest_rate_bp: null, archived_at: null, version: 1,
}
const lunch: Transaction = {
  id: 't1', type: 'expense', occurred_on: '2026-10-03', occurred_time: '08:05:00', category_id: null, payee: 'Phở', note: null,
  entries: [{ account_id: 'cash', amount: -65_000, currency: 'VND' }], version: 2, created_at: '2026-10-03T01:05:00Z',
  modified_at: '2026-10-03T01:05:00Z', created_by: 'lan', modified_by: 'lan', running_balance: null,
}

function server() {
  return fakeApi({
    'GET /v1/currencies': currencies,
    'GET /v1/books/b1/accounts': [cash],
    'GET /v1/books/b1/categories': [],
    'POST /v1/books/b1/transactions': ({ body }: { body: unknown }) => body,
    'PUT /v1/books/b1/transactions/t1': ({ body }: { body: unknown }) => body,
  })
}

describe('the time of a transaction', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-05T07:30:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it("starts at the current time in the book's timezone, and is saved with the date", async () => {
    const api = server()
    await renderApp(<TxnDialog book={book} txn={null} onClose={() => {}} />)
    await userEvent.type(await screen.findByLabelText(/^Amount/), '45000')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ occurred_on: '2026-10-05', occurred_time: '14:30' })
  })

  it('keeps the saved time when editing', async () => {
    const api = server()
    await renderApp(<TxnDialog book={book} txn={lunch} onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ occurred_on: '2026-10-03', occurred_time: '08:05', version: 2 })
  })
})

describe('filling in from my own history (msaving#65)', () => {
  const bank: Account = { ...cash, id: 'bank', name: 'Bank', kind: 'checking', balance: 5_000_000 }
  const parking = { id: 'parking', name: 'Parking', parent_id: null, kind: 'expense', color: null, archived_at: null, version: 1 }
  function history() {
    return fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/accounts': [cash, bank],
      'GET /v1/books/b1/categories': [parking],
      'GET /v1/books/b1/transactions/suggest': { account_id: 'bank', category_id: 'parking', payee: 'Gửi xe' },
    })
  }

  it('fills in the account, category and payee for the amount typed', async () => {
    const api = history()
    await renderApp(<TxnDialog book={book} txn={null} onClose={() => {}} />)
    await userEvent.type(await screen.findByLabelText(/^Amount/), '5000')
    expect(await screen.findByDisplayValue('Gửi xe')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /^Account/ })).toHaveTextContent('Bank')
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveTextContent('Parking')
    const asked = api.calls.filter((c) => c.path === '/v1/books/b1/transactions/suggest').at(-1)!
    expect(asked.url).toContain('type=expense')
    expect(asked.url).toContain('amount=5000')
  })

  it('keeps what the user chose', async () => {
    history()
    await renderApp(<TxnDialog book={book} txn={null} onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('combobox', { name: /^Account/ }))
    await userEvent.click(await screen.findByRole('option', { name: /Cash/ }))
    await userEvent.type(screen.getByLabelText('Payee'), 'Mine')
    await userEvent.type(screen.getByLabelText(/^Amount/), '5000')
    expect(await screen.findByText('Parking', { selector: '[role="combobox"] *, [role="combobox"]' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /^Account/ })).toHaveTextContent('Cash')
    expect(screen.getByLabelText('Payee')).toHaveValue('Mine')
  })
})

describe('paying a card purchase in installments (msaving#71)', () => {
  const visa: Account = { ...cash, id: 'visa', name: 'Visa', kind: 'credit_card', balance: 0, statement_day: 25, payment_due_day: 10,
    credit_limit: 20_000_000 }
  const laptop: Transaction = { ...lunch, id: 't2', payee: 'Laptop', version: 1,
    entries: [{ account_id: 'visa', amount: -6_000_000, currency: 'VND' }] }
  const plan = { id: 'p1', account_id: 'visa', transaction_id: 't2', payee: 'Laptop', occurred_on: '2026-10-03', amount: 6_000_000,
    months: 6, converted_on: '2026-10-03', first_statement: '2026-10-25', fee: 0, fee_split: false, counts_toward_limit: true,
    ended_on: null, version: 1, installment: 1_000_000, billed: 0, left_to_bill: 6_000_000 }

  function cards(plans: unknown[] = []) {
    return fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/accounts': [cash, visa],
      'GET /v1/books/b1/categories': [],
      'GET /v1/books/b1/installments': plans,
      'POST /v1/books/b1/transactions': ({ body }: { body: unknown }) => body,
      'PUT /v1/books/b1/transactions/t2': ({ body }: { body: unknown }) => body,
      'POST /v1/books/b1/installments': ({ body }: { body: unknown }) => body,
      'PATCH /v1/books/b1/installments/p1': plan,
      'DELETE /v1/books/b1/installments/p1': undefined,
    })
  }

  it('saves the purchase, then its plan', async () => {
    const api = cards()
    await renderApp(<TxnDialog book={book} txn={null} defaults={{ account: 'visa' }} onClose={() => {}} />)
    await userEvent.type(await screen.findByLabelText(/^Amount/), '6000000')
    await userEvent.click(screen.getByRole('switch', { name: 'Pay in installments' }))
    expect(screen.getByRole('spinbutton', { name: 'Months' })).toHaveValue(6)
    expect(screen.getByText('6 × ₫1,000,000')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Conversion fee'), '120000')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(2))
    const [purchase, created] = api.writes()
    expect(created.path).toBe('/v1/books/b1/installments')
    expect(created.body).toMatchObject({ transaction_id: (purchase.body as { id: string }).id, months: 6, fee: 120_000,
      fee_split: false, counts_toward_limit: true, converted_on: (purchase.body as { occurred_on: string }).occurred_on })
  })

  it('is only offered on a credit card', async () => {
    cards()
    await renderApp(<TxnDialog book={book} txn={null} defaults={{ account: 'cash' }} onClose={() => {}} />)
    await screen.findByLabelText(/^Amount/)
    expect(screen.queryByRole('switch', { name: 'Pay in installments' })).not.toBeInTheDocument()
  })

  it('shows a saved plan and saves what changed', async () => {
    const api = cards([plan])
    await renderApp(<TxnDialog book={book} txn={laptop} onClose={() => {}} />)
    expect(await screen.findByRole('switch', { name: 'Pay in installments' })).toBeChecked()
    const months = screen.getByRole('spinbutton', { name: 'Months' })
    await userEvent.clear(months)
    await userEvent.type(months, '12')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(2))
    expect(api.writes()[1]).toMatchObject({ method: 'PATCH', path: '/v1/books/b1/installments/p1', body: { version: 1, months: 12 } })
  })

  it('removes the plan when the switch is turned off', async () => {
    const api = cards([plan])
    await renderApp(<TxnDialog book={book} txn={laptop} onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('switch', { name: 'Pay in installments' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(2))
    expect(api.writes()[1]).toMatchObject({ method: 'DELETE', url: '/v1/books/b1/installments/p1?version=1' })
  })

  it('warns that moving the purchase off the card removes its plan', async () => {
    cards([plan])
    await renderApp(<TxnDialog book={book} txn={laptop} onClose={() => {}} />)
    await screen.findByRole('switch', { name: 'Pay in installments' })
    await userEvent.click(screen.getByRole('combobox', { name: /^Account/ }))
    await userEvent.click(await screen.findByRole('option', { name: /Cash/ }))
    expect(screen.getByText("Saving removes this purchase's installment plan.")).toBeInTheDocument()
  })
})

describe('after saving', () => {
  it('closes and says it was saved', async () => {
    server()
    const onClose = vi.fn()
    await renderApp(<TxnDialog book={book} txn={null} onClose={onClose} />)
    await userEvent.type(await screen.findByLabelText(/^Amount/), '45000')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Transaction saved')).toBeInTheDocument()
    expect(onClose).toHaveBeenCalled()
  })

  it('stays open with the error when the save fails', async () => {
    const api = server()
    api.routes['POST /v1/books/b1/transactions'] = new Response(JSON.stringify({ detail: 'invalid' }), { status: 422 })
    const onClose = vi.fn()
    await renderApp(<TxnDialog book={book} txn={null} onClose={onClose} />)
    await userEvent.type(await screen.findByLabelText(/^Amount/), '45000')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByText('Transaction saved')).not.toBeInTheDocument()
  })
})
