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
  it('opens People from who owes whom (waterflow#68)', async () => {
    dashServer({ people: [{ contact_id: 'c1', name: 'Mẹ', currency: 'VND', owed_to_you: 0, you_owe: 10_000_000 }] })
    await renderApp(<Dashboard book={book} />)
    const card = (await screen.findByText('Who owes whom')).closest('.MuiPaper-root') as HTMLElement
    await userEvent.click(within(card).getByRole('link', { name: 'See all' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/books/b1/people')
  })
})

const row = (i: number, pinned = false) => ({ account_id: `a${i}`, name: `Account ${i}`, kind: 'cash' as const, currency: 'VND', balance: i * 1000,
  converted_balance: i * 1000, in_net_worth: true, pinned })
const txn = (i: number) => ({ id: `t${i}`, type: 'expense' as const, occurred_on: '2026-10-20', occurred_time: '08:00:00', payee: `Payee ${i}`,
  category: null, amount: -i * 1000, currency: 'VND' })
const cardOf = async (title: string) => within((await screen.findByText(title)).closest('.MuiPaper-root') as HTMLElement)

describe('the Overview lists (waterflow#73, waterflow#74)', () => {
  it('shows the 5 latest transactions', async () => {
    dashServer({ recent_transactions: [1, 2, 3, 4, 5, 6, 7].map(txn) })
    await renderApp(<Dashboard book={book} />)
    const recent = await cardOf('Recent transactions')
    expect(recent.getAllByText(/^Payee \d$/).map((e) => e.textContent)).toEqual(['Payee 1', 'Payee 2', 'Payee 3', 'Payee 4', 'Payee 5'])
    expect(recent.getByRole('link', { name: 'See all' })).toBeInTheDocument()
  })

  it('shows the pinned accounts', async () => {
    dashServer({ accounts: [1, 2, 3, 4, 5, 6, 7].map((i) => row(i, i === 3 || i === 6)) })
    await renderApp(<Dashboard book={book} />)
    const accounts = await cardOf('Accounts')
    expect(accounts.getAllByText(/^Account \d$/).map((e) => e.textContent)).toEqual(['Account 3', 'Account 6'])
    expect(accounts.queryByText('Pin accounts on Accounts to choose these.')).not.toBeInTheDocument()
  })

  it("leaves people's own accounts out (waterflow#85)", async () => {
    dashServer({ accounts: [{ ...row(1), name: 'Minh', kind: 'person' as const }, row(2)] })
    await renderApp(<Dashboard book={book} />)
    const accounts = await cardOf('Accounts')
    expect(accounts.getByText('Account 2')).toBeInTheDocument()
    expect(accounts.queryByText('Minh')).not.toBeInTheDocument()
  })

  it('shows the first 5 when none is pinned, and says how to choose', async () => {
    dashServer({ accounts: [1, 2, 3, 4, 5, 6, 7].map((i) => row(i)) })
    await renderApp(<Dashboard book={book} />)
    const accounts = await cardOf('Accounts')
    expect(accounts.getAllByText(/^Account \d$/)).toHaveLength(5)
    expect(accounts.getByText('Pin accounts on Accounts to choose these.')).toBeInTheDocument()
  })
})
