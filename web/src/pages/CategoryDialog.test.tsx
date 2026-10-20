import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Book, Budget, Category } from '../lib/api'
import { currencies, fakeApi } from '../test/fakeApi'
import { renderApp } from '../test/render'
import { Categories } from './Categories'
import { CategoryDialog } from './CategoryDialog'

const book: Book = { id: 'b1', name: 'Personal', base_currency: 'VND', timezone: 'Asia/Ho_Chi_Minh', role: 'owner', archived_at: null, version: 1 }
const wants: Category = { id: 'c1', parent_id: null, name: 'Wants', kind: 'expense', color: '#9333ea', archived_at: null, version: 1 }
const dining: Category = { id: 'c2', parent_id: 'c1', name: 'Dining out', kind: 'expense', color: '#9333ea', archived_at: null, version: 2 }
const monthly: Budget = { id: 'u1', category_id: 'c2', period: 'monthly', amount: 3_000_000, starts_on: '2026-07-01', ends_on: null, version: 1,
  progress: { period_start: '2026-10-01', period_end: '2026-10-31', spent: 2_425_000, remaining: 575_000, percent_used: 81, not_converted: 0 } }

function server() {
  return fakeApi({
    'GET /v1/currencies': currencies,
    'GET /v1/books/b1/categories': [wants, dining],
    'GET /v1/books/b1/budgets': [monthly],
    'PATCH /v1/books/b1/categories/c2': dining,
  })
}
const name = () => screen.getByRole('textbox', { name: /category name/i })

describe('category details (msaving#23)', () => {
  it('opens greyed out with its budgets; Edit turns the fields on without saving', async () => {
    const api = server()
    await renderApp(<CategoryDialog book={book} all={[wants, dining]} category={dining} onClose={() => {}} />)
    expect(screen.getByText('Category details')).toBeInTheDocument()
    expect(name()).toBeDisabled()
    expect(await screen.findByText(/2,425,000/)).toBeInTheDocument()   // this month's spending against its budget
    const edit = screen.getByRole('button', { name: 'Edit' })
    await userEvent.click(edit)
    expect(screen.getByText('Edit category')).toBeInTheDocument()       // still open: Edit didn't submit the form
    // Save is a new button: in a browser, Edit's element turning into the submit button mid-click submits the form.
    expect(screen.getByRole('button', { name: 'Save' })).not.toBe(edit)
    expect(name()).toBeEnabled()
    expect(api.writes()).toEqual([])
  })

  it('shows its colour even when it is not one of the swatches', async () => {
    server()
    await renderApp(<CategoryDialog book={book} all={[wants, dining]} category={dining} onClose={() => {}} />)
    expect(screen.getByRole('button', { name: '#9333ea' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('saves an edit made after Edit', async () => {
    const api = server()
    const onClose = vi.fn()
    await renderApp(<CategoryDialog book={book} all={[wants, dining]} category={dining} onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await userEvent.clear(name())
    await userEvent.type(name(), 'Eating out')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.writes()[0]).toMatchObject({ method: 'PATCH', path: '/v1/books/b1/categories/c2', body: { name: 'Eating out', version: 2 } })
    expect(onClose).toHaveBeenCalled()
  })

  it('a viewer can look but not edit', async () => {
    server()
    await renderApp(<CategoryDialog book={{ ...book, role: 'viewer' }} all={[wants, dining]} category={dining} onClose={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })

  it('opens from the Categories page and leads to its transactions', async () => {
    server()
    await renderApp(<Categories book={book} />, { route: '/books/b1/categories' })
    await userEvent.click(await screen.findByText('Dining out'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Category details')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'View transactions' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/books/b1/transactions?category_id=c2')
  })
})
