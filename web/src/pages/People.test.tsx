import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Book, Contact } from '../lib/api'
import { currencies, fakeApi } from '../test/fakeApi'
import { renderApp } from '../test/render'
import { People } from './People'

const book: Book = { id: 'b1', name: 'Personal', base_currency: 'VND', timezone: 'Asia/Ho_Chi_Minh', role: 'owner', archived_at: null, version: 1 }
const minh: Contact = { id: 'minh', name: 'Minh', note: null, archived_at: null, version: 1, currency: 'VND',
  balances: [{ currency: 'VND', owed_to_you: 0, you_owe: 150_000 }] }

describe('people are accounts (waterflow#85)', () => {
  it('shows who owes whom, and opens their transactions', async () => {
    fakeApi({ 'GET /v1/currencies': currencies, 'GET /v1/books/b1/contacts': [minh] })
    await renderApp(<People book={book} />)
    expect(await screen.findByText(/You owe ₫150,000/)).toBeInTheDocument()
    await userEvent.click(screen.getByText('Minh'))
    expect(screen.getByTestId('where')).toHaveTextContent('/books/b1/transactions?account_id=minh')
  })

  it('adds a person in the currency picked for their account, the book’s by default', async () => {
    const api = fakeApi({
      'GET /v1/currencies': currencies,
      'GET /v1/books/b1/contacts': [],
      'POST /v1/books/b1/contacts': ({ body }: { body: unknown }) => body,
    })
    await renderApp(<People book={book} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Add person' }))
    await userEvent.type(screen.getByRole('textbox', { name: /^Name/ }), 'Bob')
    expect(screen.getByRole('combobox', { name: 'Currency' })).toHaveValue('VND · Vietnamese Dong')
    await userEvent.click(screen.getByRole('combobox', { name: 'Currency' }))
    await userEvent.click(await screen.findByRole('option', { name: /USD/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ name: 'Bob', currency: 'USD' })
  })
})
