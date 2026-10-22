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

function server() {
  return fakeApi({
    'GET /v1/currencies': [...currencies, { code: 'KWD', minor_unit: 3, name: 'Kuwaiti dinar' }],
    'GET /v1/books/b1/accounts': all,
    'GET /v1/books/b1/contacts': [],
  })
}

describe('Accounts grouped by kind (msaving#64)', () => {
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

  it('no longer lists people: they have their own page (msaving#68)', async () => {
    server()
    await renderApp(<Accounts book={book} />)
    await screen.findByText('Nợ mẹ')
    expect(screen.queryByText('People you lend to or borrow from')).not.toBeInTheDocument()
  })
})
