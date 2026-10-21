import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { Book } from '../lib/api'
import { fakeApi } from '../test/fakeApi'
import { desktop, renderApp } from '../test/render'
import { Shell } from './Shell'

const personal: Book = { id: 'b1', name: 'Personal', base_currency: 'VND', timezone: 'UTC', role: 'owner', archived_at: null, version: 1 }
const family: Book = { id: 'b2', name: 'Family', base_currency: 'VND', timezone: 'UTC', role: 'viewer', archived_at: null, version: 1 }

function server(admin = false) {
  return fakeApi({
    'GET /v1/instance': { server_version: '0.1.2' },
    'GET /v1/me': { id: 'u1', profile: { username: 'admin', is_admin: admin } },
    'GET /v1/books': [personal, family],
    'GET /v1/me/book-invites': [],
    'GET /v1/books/b1/changes': { marker: '1.1' },
  })
}
const page = (route = '/books/b1') => renderApp(<Shell book={personal}><p>page</p></Shell>, { route })

describe('phone layout (msaving#28)', () => {
  it('puts the pages in a bar at the bottom, with the current one selected', async () => {
    server()
    await page('/books/b1/transactions')
    const bar = screen.getByRole('link', { name: 'Overview' }).parentElement!
    expect(within(bar).getAllByRole('link').map((a) => a.textContent)).toEqual(['Overview', 'Transactions', 'Accounts', 'Categories'])
    expect(within(bar).getByRole('button', { name: 'More' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Transactions' })).toHaveClass('Mui-selected')
    await userEvent.click(screen.getByRole('link', { name: 'Accounts' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/books/b1/accounts')
  })

  it("shows the book's name on top, which opens the books with your role in each", async () => {
    server()
    await page()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()     // no dropdown on a phone
    await userEvent.click(screen.getByRole('button', { name: 'Switch book' }))
    const sheet = await screen.findByRole('presentation')
    expect(within(sheet).getByText('Personal')).toBeInTheDocument()
    expect(within(sheet).getByText('Viewer')).toBeInTheDocument()
    expect(within(sheet).getByText('New book')).toBeInTheDocument()
    await userEvent.click(within(sheet).getByText('Family'))
    expect(screen.getByTestId('where')).toHaveTextContent('/books/b2')
  })

  it('keeps the rest under More: book settings, profile, sign out, and server admin for the admin', async () => {
    server(false)
    await page()
    await userEvent.click(screen.getByRole('button', { name: 'More' }))
    const sheet = await screen.findByRole('presentation')
    expect(within(sheet).getAllByRole('button').map((b) => b.textContent)).toEqual(['People', 'Book settings', 'Profile and security', 'Sign out'])
    await userEvent.click(within(sheet).getByRole('button', { name: 'People' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/books/b1/people')
  })

  it('shows Server admin under More to the admin', async () => {
    server(true)
    await page()
    await screen.findByRole('button', { name: 'More' })
    await new Promise((r) => setTimeout(r, 20)) // /v1/me answers
    await userEvent.click(screen.getByRole('button', { name: 'More' }))
    const sheet = await screen.findByRole('presentation')
    expect(within(sheet).getByText('Server admin')).toBeInTheDocument()
  })
})

describe('desktop (msaving#22)', () => {
  afterEach(() => desktop(false))

  it('keeps the sidebar with the book dropdown, one shade darker than the page', async () => {
    desktop(true)
    server()
    await page()
    expect(screen.getByRole('combobox', { name: 'Switch book' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument()
    const paper = document.querySelector('.MuiDrawer-paper')!
    expect(getComputedStyle(paper).backgroundColor).toBe('rgb(243, 244, 246)') // on a white page
  })

  it('lists People after Accounts (msaving#68)', async () => {
    desktop(true)
    server()
    await page()
    const nav = screen.getByRole('link', { name: 'Overview' }).closest('ul')!
    expect(within(nav).getAllByRole('link').map((a) => a.textContent).slice(0, 5)).toEqual(['Overview', 'Transactions', 'Accounts', 'People', 'Categories'])
    expect(within(nav).getByRole('link', { name: 'People' })).toHaveAttribute('href', '/books/b1/people')
  })

  it("shows the server's version next to the app's name", async () => {
    desktop(true)
    server()
    await page()
    expect(await screen.findByTitle('Server version 0.1.2')).toHaveTextContent('v0.1.2')
  })

  it('darkens the sidebar in dark mode too', async () => {
    desktop(true, { dark: true })
    server()
    await page()
    const paper = document.querySelector('.MuiDrawer-paper')!
    expect(getComputedStyle(paper).backgroundColor).toBe('rgb(11, 11, 11)') // on #121212
  })
})
