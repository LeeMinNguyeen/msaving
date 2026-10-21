import { screen, waitFor, within } from '@testing-library/react'
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

describe('picking a category (msaving#67)', () => {
  it('opens a parent to pick a sub-category, and saves it', async () => {
    const api = fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/accounts': [cash],
      'GET /v1/books/b1/categories': [
        { id: 'needs', name: 'Thiết yếu', parent_id: null, kind: 'expense', color: null, archived_at: null, version: 1 },
        { id: 'moving', name: 'Di chuyển', parent_id: 'needs', kind: 'expense', color: null, archived_at: null, version: 1 },
      ],
      'POST /v1/books/b1/transactions': ({ body }: { body: unknown }) => body,
    })
    await renderApp(<TxnDialog book={book} txn={null} onClose={() => {}} />)
    await userEvent.type(await screen.findByLabelText(/^Amount/), '5000')
    await userEvent.click(screen.getByRole('combobox', { name: 'Category' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Show the sub-categories of Thiết yếu' }))
    await userEvent.click(within(screen.getByRole('listbox')).getByText('Di chuyển'))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ category_id: 'moving' })
  })
})
