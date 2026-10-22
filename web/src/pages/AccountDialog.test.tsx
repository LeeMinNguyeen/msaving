import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Account, Book } from '../lib/api'
import { todayIn } from '../lib/labels'
import { currencies, fakeApi } from '../test/fakeApi'
import { renderApp } from '../test/render'
import { AccountDialog } from './AccountDialog'
import { Accounts } from './Accounts'

const book: Book = { id: 'b1', name: 'Personal', base_currency: 'VND', timezone: 'Asia/Ho_Chi_Minh', role: 'owner', archived_at: null, version: 1 }
const blank = { last4: null, in_net_worth: true, contact_id: null, note: null, credit_limit: null, annual_fee: null, statement_day: null,
  installment: null, installment_fee: null,
  payment_due_day: null, interest_rate_bp: null, archived_at: null, version: 3 }
const cash: Account = { ...blank, id: 'a1', name: 'Cash', kind: 'cash', currency: 'VND', balance: 6_936_000 }
const card: Account = { ...blank, id: 'a2', name: 'Visa', kind: 'credit_card', currency: 'VND', last4: '3317', balance: -9_896_000,
  credit_limit: 50_000_000, annual_fee: 499_000, statement_day: 25, payment_due_day: 10, interest_rate_bp: 2_880, note: 'Main card' }

function server(onServer: Account[] = [cash, card]) {
  return fakeApi({
    'GET /v1/currencies': currencies,
    'GET /v1/books/b1/contacts': [],
    'GET /v1/books/b1/accounts': () => onServer,
    'GET /v1/books/b1/budgets': [],
    'PATCH /v1/books/b1/accounts/a1': cash,
    'PATCH /v1/books/b1/accounts/a2': card,
    'POST /v1/books/b1/transactions': {},
  })
}
const field = (name: string | RegExp) => screen.getByRole('textbox', { name })
const pick = async (name: string | RegExp, option: string) => {
  await userEvent.click(await screen.findByRole('combobox', { name }))
  await userEvent.click(await screen.findByRole('option', { name: option }))
}

describe('account details (waterflow#23)', () => {
  it('opens greyed out; Edit turns the fields on without saving anything', async () => {
    const api = server()
    await renderApp(<AccountDialog book={book} account={card} onClose={() => {}} />)
    expect(await screen.findByText('Account details')).toBeInTheDocument()
    expect(field(/account name/i)).toBeDisabled()
    expect(field(/credit limit/i)).toHaveValue('50,000,000')
    expect(field(/credit limit/i)).toBeDisabled()
    const edit = screen.getByRole('button', { name: 'Edit' })
    await userEvent.click(edit)
    expect(screen.getByText('Edit account')).toBeInTheDocument()
    // Save is a new button: in a browser, Edit's element turning into the submit button mid-click submits the form.
    expect(screen.getByRole('button', { name: 'Save' })).not.toBe(edit)
    expect(field(/account name/i)).toBeEnabled()
    expect(field(/credit limit/i)).toBeEnabled()
    expect(api.writes()).toEqual([])
  })

  it('leads to the transactions, and a viewer can look but not edit', async () => {
    server()
    const onTransactions = vi.fn()
    await renderApp(<AccountDialog book={{ ...book, role: 'viewer' }} account={cash} onTransactions={onTransactions} onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'View transactions' }))
    expect(onTransactions).toHaveBeenCalledWith(cash)
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })

  it("opens in edit mode from the account's menu; Cancel there closes", async () => {
    server()
    const onClose = vi.fn()
    await renderApp(<AccountDialog book={book} account={cash} editing onClose={onClose} />)
    expect(await screen.findByText('Edit account')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('Cancel after Edit goes back to the details, as they were', async () => {
    server()
    await renderApp(<AccountDialog book={book} account={cash} onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    await userEvent.clear(field(/account name/i))
    await userEvent.type(field(/account name/i), 'Wallet')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(field(/account name/i)).toHaveValue('Cash')
    expect(field(/account name/i)).toBeDisabled()
  })

  it('opens from the Accounts page, instead of jumping to the transactions', async () => {
    server()
    await renderApp(<Accounts book={book} />, { route: '/books/b1/accounts' })
    await userEvent.click(await screen.findByText('Visa'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Account details')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'View transactions' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/books/b1/transactions?account_id=a2')
  })
})

describe('fields by kind (waterflow#17)', () => {
  it('shows each kind its own fields', async () => {
    server()
    await renderApp(<AccountDialog book={book} account={null} onClose={() => {}} />)
    await screen.findByText('Add account')
    const has = (name: RegExp) => screen.queryByRole('textbox', { name }) !== null || screen.queryByRole('combobox', { name }) !== null
    const seen = () => [/last 4/i, /credit limit/i, /annual fee/i, /statement day/i, /due day/i, /interest/i, /^note/i].filter(has).map(String)
    expect(seen()).toEqual(['/^note/i'])                                         // cash: a note, no card digits
    await pick(/account type/i, 'Credit card')
    expect(seen()).toHaveLength(7)
    await pick(/account type/i, 'Savings')
    expect(seen()).toEqual(['/last 4/i', '/interest/i', '/^note/i'])
    await pick(/account type/i, 'Money lent')
    expect(seen()).toEqual(['/interest/i', '/^note/i'])
  })

  it("saves a card's details", async () => {
    const api = server()
    await renderApp(<AccountDialog book={book} account={{ ...card, credit_limit: null, statement_day: null }} onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    await userEvent.type(field(/credit limit/i), '60000000')
    await pick(/statement day/i, '27')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0]).toMatchObject({ method: 'PATCH', path: '/v1/books/b1/accounts/a2',
      body: { credit_limit: 60_000_000, statement_day: 27, payment_due_day: 10, annual_fee: 499_000, interest_rate_bp: 2_880, note: 'Main card' } })
  })

  it("clears a card's details when it becomes another kind", async () => {
    const api = server()
    await renderApp(<AccountDialog book={book} account={card} editing onClose={() => {}} />)
    await pick(/account type/i, 'Checking')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ kind: 'checking', credit_limit: null, annual_fee: null, statement_day: null,
      payment_due_day: null, interest_rate_bp: null, note: 'Main card', last4: null })
  })

  it('takes the interest rate as a percentage, by the language', async () => {
    const api = server()
    await renderApp(<AccountDialog book={book} account={{ ...cash, kind: 'savings', id: 'a1' }} editing onClose={() => {}} />, { lang: 'vi' })
    await userEvent.type(await screen.findByRole('textbox', { name: /lãi suất/i }), '4,75')
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ interest_rate_bp: 475 })
  })
})

describe('setting the balance (waterflow#24)', () => {
  it('adds an adjustment for the difference from the balance now, dated today', async () => {
    // Someone added 14,000 since the dialog opened: the save answers with 6,950,000.
    const api = server()
    api.routes['PATCH /v1/books/b1/accounts/a1'] = { ...cash, balance: 6_950_000, version: 4 }
    await renderApp(<AccountDialog book={book} account={cash} editing onClose={() => {}} />)
    expect(await screen.findByRole('textbox', { name: 'Current balance' })).toHaveValue('6,936,000')
    await userEvent.clear(field('Current balance'))
    await userEvent.type(field('Current balance'), '7000000')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(2))
    const [patch, adjust] = api.writes() // the account first: a refused edit leaves no adjustment behind
    expect(patch.method).toBe('PATCH')
    expect(adjust).toMatchObject({ method: 'POST', path: '/v1/books/b1/transactions', body: {
      type: 'adjustment', occurred_on: todayIn(book.timezone), entries: [{ account_id: 'a1', amount: 50_000 }], category_id: null } })
  })

  it("reads a card's balance as what's owed", async () => {
    const api = server()
    await renderApp(<AccountDialog book={book} account={card} editing onClose={() => {}} />)
    expect(await screen.findByRole('textbox', { name: 'Amount owed now' })).toHaveValue('9,896,000')
    await userEvent.clear(field('Amount owed now'))
    await userEvent.type(field('Amount owed now'), '10000000')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(2))
    expect(api.writes()[1].body).toMatchObject({ type: 'adjustment', entries: [{ account_id: 'a2', amount: -104_000 }] })
  })

  it('adds nothing when the balance is left as it was', async () => {
    const api = server()
    await renderApp(<AccountDialog book={book} account={cash} editing onClose={() => {}} />)
    await userEvent.type(await screen.findByRole('textbox', { name: /^note/i }), 'Wallet')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].method).toBe('PATCH')
  })

  // A server whose adjustments are idempotent by id, like the real one, and whose first answer to one is lost.
  function lossyServer() {
    const api = server()
    let balance = cash.balance
    let version = cash.version
    const saved = new Set<string>()
    let lose = true
    api.routes['PATCH /v1/books/b1/accounts/a1'] = () => ({ ...cash, balance, version: ++version })
    api.routes['POST /v1/books/b1/transactions'] = (c: { body: unknown }) => {
      const body = c.body as { id: string; entries: { amount: number }[] }
      if (!saved.has(body.id)) {
        saved.add(body.id)
        balance += body.entries[0].amount
      }
      if (lose) {
        lose = false
        return new Response('{"detail":"unexpected_error"}', { status: 500 })
      }
      return {}
    }
    const posts = () => api.writes().filter((c) => c.method === 'POST') as { body: { id: string; entries: { amount: number }[] } }[]
    return { api, posts, balance: () => balance }
  }

  async function saveBalance(typed: string) {
    await userEvent.clear(await screen.findByRole('textbox', { name: 'Current balance' }))
    await userEvent.type(field('Current balance'), typed)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  }

  it('sends the same adjustment again on a retry, so it is never added twice', async () => {
    const { api, posts, balance } = lossyServer()
    await renderApp(<AccountDialog book={book} account={cash} editing onClose={() => {}} />)
    await saveBalance('7000000')
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(3))
    expect(api.writes().map((c) => c.method)).toEqual(['PATCH', 'POST', 'PATCH']) // the first was saved: nothing left to add
    expect((api.writes()[2].body as { version: number }).version).toBe(4)         // carries on from the first save
    expect(posts()).toHaveLength(1)
    expect(balance()).toBe(7_000_000)
  })

  it('makes a new adjustment for a different balance typed after a failed save', async () => {
    const { api, posts, balance } = lossyServer()
    await renderApp(<AccountDialog book={book} account={cash} editing onClose={() => {}} />)
    await saveBalance('7000000')
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    await saveBalance('7100000')
    await waitFor(() => expect(api.writes()).toHaveLength(4))
    expect(posts()[1].body.id).not.toBe(posts()[0].body.id)
    expect(posts()[1].body.entries[0].amount).toBe(100_000)
    expect(balance()).toBe(7_100_000)
  })

  it('on a conflict, shows the account as someone else saved it, adds nothing, and saves from there', async () => {
    const api = server()
    const renamed = { ...cash, name: 'Wallet', version: 4 }
    api.routes['GET /v1/books/b1/accounts'] = [renamed, card]
    api.routes['PATCH /v1/books/b1/accounts/a1'] = (c: { body: unknown }) =>
      (c.body as { version: number }).version === 4 ? renamed : new Response('{"detail":"conflict"}', { status: 409 })
    await renderApp(<AccountDialog book={book} account={cash} editing onClose={() => {}} />)
    await saveBalance('7000000')
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed somewhere else/i)
    expect(field(/account name/i)).toHaveValue('Wallet')
    expect(field('Current balance')).toHaveValue('6,936,000')
    expect(postsTo(api)).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes().at(-1)).toMatchObject({ method: 'PATCH', body: { version: 4, name: 'Wallet' } }))
  })
})

const postsTo = (api: ReturnType<typeof fakeApi>) => api.writes().filter((c) => c.method === 'POST')

describe('fields that follow the kind and currency', () => {
  it("keeps an untouched balance as it is when the currency changes (it isn't read back)", async () => {
    const api = server()
    const usd = { ...cash, currency: 'USD', balance: 0 }
    api.routes['PATCH /v1/books/b1/accounts/a1'] = { ...usd, currency: 'VND' }
    await renderApp(<AccountDialog book={book} account={usd} editing onClose={() => {}} />)
    expect(await screen.findByRole('textbox', { name: 'Current balance' })).toHaveValue('0.00')
    await userEvent.click(screen.getByRole('combobox', { name: 'Currency' }))
    await userEvent.click(await screen.findByRole('option', { name: /VND/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ currency: 'VND' })
  })

  it("doesn't let a field the kind hides hold up Save", async () => {
    const api = server()
    await renderApp(<AccountDialog book={book} account={card} editing onClose={() => {}} />)
    await userEvent.clear(await screen.findByRole('textbox', { name: /credit limit/i }))
    await userEvent.type(field(/credit limit/i), '-5')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await pick(/account type/i, 'Cash')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ kind: 'cash', credit_limit: null })
  })

  it('shows an untouched balance the way the new kind reads it, and adds nothing for it', async () => {
    const api = server()
    await renderApp(<AccountDialog book={book} account={cash} editing onClose={() => {}} />)
    expect(await screen.findByRole('textbox', { name: 'Current balance' })).toHaveValue('6,936,000')
    await pick(/account type/i, 'Credit card')
    expect(field('Amount owed now')).toHaveValue('-6,936,000')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].method).toBe('PATCH')
  })

  it('waits for a whole date before a new account can be saved', async () => {
    server()
    await renderApp(<AccountDialog book={book} account={null} onClose={() => {}} />)
    await userEvent.type(await screen.findByRole('textbox', { name: /account name/i }), 'Wallet')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    fireEvent.click(screen.getAllByRole('spinbutton')[0]) // the day of "As of"
    fireEvent.input(document.activeElement!, { target: { textContent: '0' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.input(document.activeElement!, { target: { textContent: '5' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })
})
