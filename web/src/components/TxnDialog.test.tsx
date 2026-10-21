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
