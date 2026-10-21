import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Book, HistoryEntry } from '../lib/api'
import { currencies, fakeApi } from '../test/fakeApi'
import { renderApp, testClient } from '../test/render'
import { HistoryDialog } from './HistoryDialog'

const book: Book = { id: 'b1', name: 'Personal', base_currency: 'VND', timezone: 'Asia/Ho_Chi_Minh', role: 'owner', archived_at: null, version: 1 }
const version = (v: number, action: HistoryEntry['action'], amount: number): HistoryEntry => ({
  version: v, action, changed_at: `2026-10-20T0${v}:00:00Z`, changed_by: 'admin', type: 'expense', occurred_on: '2026-10-03', occurred_time: '12:30:00',
  category_id: null, payee: 'Pho', note: null, entries: [{ account_id: 'cash', amount, currency: 'VND' }],
})

describe('HistoryDialog (msaving#18)', () => {
  it('never shows the copy from the last opening: a spinner until the server answers', async () => {
    let history = [version(1, 'created', -45_000)]
    let delay = 0
    fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/accounts': [{ id: 'cash', name: 'Cash' }],
      'GET /v1/books/b1/categories': [],
      'GET /v1/books/b1/transactions/t1/history': () => new Promise((ok) => setTimeout(() => ok(history), delay)),
    })
    const client = testClient() // the same cache for both openings, as in the app
    const first = await renderApp(<HistoryDialog book={book} txnId="t1" onClose={() => {}} />, { client })
    expect(await screen.findByText(/^Created/)).toBeInTheDocument()
    first.unmount()

    // Edited elsewhere (or on this device), on a slow link to the server.
    history = [version(1, 'created', -45_000), version(2, 'edited', -65_000)]
    delay = 100
    await renderApp(<HistoryDialog book={book} txnId="t1" onClose={() => {}} />, { client })
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
    expect(screen.queryByText(/^Created/)).not.toBeInTheDocument()
    expect(await screen.findByText(/^Edited/)).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('writes the date in the UI language and closes with Close', async () => {
    fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/accounts': [{ id: 'cash', name: 'Cash' }],
      'GET /v1/books/b1/categories': [],
      'GET /v1/books/b1/transactions/t1/history': [version(1, 'created', -45_000)],
    })
    await renderApp(<HistoryDialog book={book} txnId="t1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/3 Oct 2026/)).toBeInTheDocument())
    expect(screen.queryByText(/2026-10-03/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })
})
