import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Account, Book } from '../lib/api'
import { currencies, fakeApi } from '../test/fakeApi'
import { desktop, renderApp } from '../test/render'
import { Accounts } from './Accounts'

const book: Book = { id: 'b1', name: 'Personal', base_currency: 'VND', timezone: 'Asia/Ho_Chi_Minh', role: 'owner', archived_at: null, version: 1 }
const blank = { last4: null, in_net_worth: true, contact_id: null, note: null, credit_limit: null, annual_fee: null, statement_day: null,
  payment_due_day: null, installment: null, installment_fee: null, interest_rate_bp: null, archived_at: null, version: 1 }
const account = (id: string, name: string, kind: Account['kind'], balance: number, converted: number | null, currency = 'VND'): Account =>
  ({ ...blank, id, name, kind, currency, balance, converted_balance: converted })
const all = [
  account('cash', 'Cash', 'cash', 406_000, 406_000),
  account('tp1', 'TPBank1', 'checking', 1_201_836, 1_201_836),
  account('usd', 'US bank', 'checking', 10_000, 2_600_000, 'USD'),
  account('kwd', 'Kuwait', 'checking', 5_000, null, 'KWD'),
  account('mom', 'Nợ mẹ', 'loan', -10_000_000, -10_000_000),
  account('tpb', 'Nợ TPBank', 'loan', -8_002_668, -8_002_668),
  account('lent', 'Lent to Lan', 'lent', 100_000, 100_000),
]

function server(accounts = all) {
  return fakeApi({
    'GET /v1/currencies': [...currencies, { code: 'KWD', minor_unit: 3, name: 'Kuwaiti dinar' }],
    'GET /v1/books/b1/accounts': accounts,
    'GET /v1/books/b1/contacts': [],
    'PUT /v1/books/b1/accounts/cash/pin': undefined,
    'DELETE /v1/books/b1/accounts/mom/pin': undefined,
  })
}

describe('Accounts grouped by kind (waterflow#64)', () => {
  beforeEach(() => desktop(true))
  afterEach(() => desktop(false))

  it('groups accounts by kind in a fixed order, each with its total in the book currency', async () => {
    server()
    await renderApp(<Accounts book={book} />)
    await screen.findByText('Nợ mẹ')
    const headers = screen.getAllByRole('row').filter((r) => r.dataset.group).map((r) => r.dataset.group)
    expect(headers).toEqual(['cash', 'checking', 'loan', 'lent'])
    const checking = screen.getAllByRole('row').find((r) => r.dataset.group === 'checking')!
    expect(checking).toHaveTextContent('Checking · 3')
    expect(checking).toHaveTextContent('₫3,801,836')
    expect(checking).toHaveTextContent('1 not included')
    expect(screen.getAllByRole('row').find((r) => r.dataset.group === 'loan')).toHaveTextContent('-₫18,002,668')
  })

  it('folds a group when its header is clicked', async () => {
    server()
    await renderApp(<Accounts book={book} />)
    const loans = (await screen.findAllByRole('row')).find((r) => r.dataset.group === 'loan')!
    await userEvent.click(within(loans).getByRole('button'))
    expect(screen.queryByText('Nợ mẹ')).not.toBeInTheDocument()
    expect(screen.getByText('TPBank1')).toBeInTheDocument()
    await userEvent.click(within(loans).getByRole('button'))
    expect(screen.getByText('Nợ mẹ')).toBeInTheDocument()
  })

  it("leaves people's own accounts to People (waterflow#85)", async () => {
    server([...all, { ...account('minh', 'Minh', 'person', -150_000, -150_000), contact_id: 'minh' }])
    await renderApp(<Accounts book={book} />)
    await screen.findByText('Nợ mẹ')
    expect(screen.queryByText('Minh')).not.toBeInTheDocument()
    expect(screen.getAllByRole('row').filter((r) => r.dataset.group).map((r) => r.dataset.group)).toEqual(['cash', 'checking', 'loan', 'lent'])
  })

  it('no longer lists people: they have their own page (waterflow#68)', async () => {
    server()
    await renderApp(<Accounts book={book} />)
    await screen.findByText('Nợ mẹ')
    expect(screen.queryByText('People you lend to or borrow from')).not.toBeInTheDocument()
  })
})

// A server that keeps the pins, so the list it returns after a pin shows it.
function pinServer(pinned: string[]) {
  const pins = new Set(pinned)
  const api = server()
  api.routes['GET /v1/books/b1/accounts'] = () => all.map((a) => ({ ...a, pinned: pins.has(a.id) }))
  for (const a of all) {
    api.routes[`PUT /v1/books/b1/accounts/${a.id}/pin`] = () => { pins.add(a.id) }
    api.routes[`DELETE /v1/books/b1/accounts/${a.id}/pin`] = () => { pins.delete(a.id) }
  }
  return api
}

async function menuOf(row: HTMLElement) {
  await userEvent.click(within(row).getByRole('button', { name: 'Account actions' }))
  return screen.findByRole('menu')
}

describe('pinning accounts to the Overview (waterflow#74, waterflow#88)', () => {
  it("pins from the row's menu on a phone, with no other button beside the balance", async () => {
    const api = pinServer([])
    await renderApp(<Accounts book={book} />)
    const cash = (await screen.findByText('Cash', { selector: 'span' })).closest('li')!
    expect(within(cash).getAllByRole('button').filter((b) => !b.contains(screen.getByText('Cash', { selector: 'span' })))
      .map((b) => b.getAttribute('aria-label'))).toEqual(['Account actions'])
    await userEvent.click(within(await menuOf(cash)).getByRole('menuitem', { name: 'Pin to the Overview' }))
    expect(api.writes().map((c) => `${c.method} ${c.path}`)).toEqual(['PUT /v1/books/b1/accounts/cash/pin'])
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(within(await menuOf(cash)).getByRole('menuitem', { name: 'Unpin from the Overview' })).toBeInTheDocument()
  })

  it('keeps the menu to words, without icons', async () => {
    pinServer(['cash'])
    await renderApp(<Accounts book={book} />)
    const cash = (await screen.findByText('Cash', { selector: 'span' })).closest('li')!
    const menu = await menuOf(cash)
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Unpin from the Overview', 'Edit account', 'Archive'])
    expect(menu.querySelector('svg')).toBeNull()
  })

  describe('on desktop', () => {
    beforeEach(() => desktop(true))
    afterEach(() => desktop(false))

    it('pins and unpins from the menu, which then offers the other one', async () => {
      const api = pinServer(['mom'])
      await renderApp(<Accounts book={book} />)
      const cash = (await screen.findByText('Cash', { selector: 'span' })).closest('tr')!
      expect(within(cash).queryByRole('button', { name: 'Pin to the Overview' })).not.toBeInTheDocument()
      await userEvent.click(within(await menuOf(cash)).getByRole('menuitem', { name: 'Pin to the Overview' }))
      expect(within(await menuOf(cash)).getByRole('menuitem', { name: 'Unpin from the Overview' })).toBeInTheDocument()
      await userEvent.keyboard('{Escape}')
      const mom = screen.getByText('Nợ mẹ').closest('tr')!
      await userEvent.click(within(await menuOf(mom)).getByRole('menuitem', { name: 'Unpin from the Overview' }))
      expect(within(await menuOf(mom)).getByRole('menuitem', { name: 'Pin to the Overview' })).toBeInTheDocument()
      expect(api.writes().map((c) => `${c.method} ${c.path}`)).toEqual([
        'PUT /v1/books/b1/accounts/cash/pin', 'DELETE /v1/books/b1/accounts/mom/pin'])
    })

    it('lets a viewer pin too: a pin is their own view', async () => {
      pinServer([])
      await renderApp(<Accounts book={{ ...book, role: 'viewer' }} />)
      const cash = (await screen.findByText('Cash', { selector: 'span' })).closest('tr')!
      expect(within(await menuOf(cash)).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Pin to the Overview'])
    })
  })
})
