import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Book, Category } from '../lib/api'
import { currencies, fakeApi } from '../test/fakeApi'
import { renderApp } from '../test/render'
import { BudgetDialog } from './BudgetDialog'

const book: Book = { id: 'b1', name: 'Personal', base_currency: 'VND', timezone: 'Asia/Ho_Chi_Minh', role: 'owner', archived_at: null, version: 1 }
const food: Category = { id: 'food', name: 'Food', kind: 'expense', parent_id: null, color: null, archived_at: null, version: 1 }

describe('BudgetDialog', () => {
  it('saves from the button bar, then closes and says so', async () => {
    const api = fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/budgets': [],
      'POST /v1/books/b1/budgets': ({ body }: { body: unknown }) => body,
    })
    const onClose = vi.fn()
    await renderApp(<BudgetDialog book={book} category={food} onClose={onClose} />)
    await userEvent.type(await screen.findByLabelText(/^Limit/), '3000000')
    const bar = screen.getByRole('button', { name: 'Cancel' }).parentElement!
    await userEvent.click(within(bar).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ category_id: 'food', period: 'monthly', amount: 3_000_000 })
    expect(await screen.findByText('Budget added')).toBeInTheDocument()
    expect(onClose).toHaveBeenCalled()
  })
})
