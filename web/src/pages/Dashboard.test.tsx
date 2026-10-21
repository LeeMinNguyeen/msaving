import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Book, Dashboard as Dash } from '../lib/api'
import { currencies, fakeApi } from '../test/fakeApi'
import { renderApp } from '../test/render'
import { Dashboard } from './Dashboard'

const book: Book = { id: 'b1', name: 'Personal', base_currency: 'VND', timezone: 'Asia/Ho_Chi_Minh', role: 'owner', archived_at: null, version: 1 }
export const emptyDash: Dash = {
  currency: 'VND', rates_source: null, net_worth: 0, net_worth_missing_rates: 0, spent_this_month: 0, spent_last_month: 0,
  income_this_month: 0, cashflow_6_months: [], top_categories_this_month: [], budgets: [], accounts: [], people: [], recent_transactions: [],
}

export function dashServer(dash: Partial<Dash>, extra: Record<string, unknown> = {}) {
  return fakeApi({
    'GET /v1/currencies': currencies,
    'GET /v1/books/b1/dashboard': { ...emptyDash, ...dash },
    'GET /v1/books/b1/categories': [],
    ...extra,
  })
}

// jsdom has no ResizeObserver; the charts only need it to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})

describe('Overview', () => {
  it('opens People from who owes whom (msaving#68)', async () => {
    dashServer({ people: [{ contact_id: 'c1', name: 'Mẹ', currency: 'VND', owed_to_you: 0, you_owe: 10_000_000 }] })
    await renderApp(<Dashboard book={book} />)
    const card = (await screen.findByText('Who owes whom')).closest('.MuiPaper-root') as HTMLElement
    await userEvent.click(within(card).getByRole('link', { name: 'See all' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/books/b1/people')
  })
})
