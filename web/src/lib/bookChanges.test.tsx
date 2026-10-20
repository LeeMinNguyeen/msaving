import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { RefreshButton } from '../components/RefreshButton'
import { fakeApi } from '../test/fakeApi'
import { renderApp, testClient } from '../test/render'
import { useAccounts, useBookChanges, useBooks } from './queries'

// A book page: the change watcher (in the Shell) and some of the book's data.
function Page({ bookId }: { bookId: string }) {
  useBookChanges(bookId)
  useAccounts(bookId, false)
  useAccounts('other', false) // another book, which must be left alone
  useBooks()
  return <RefreshButton bookId={bookId} />
}

function server() {
  let marker = '10.100'
  const api = fakeApi({
    'GET /v1/books/b1/changes': () => ({ marker }),
    'GET /v1/books/b1/accounts': [],
    'GET /v1/books/other/accounts': [],
    'GET /v1/books': [],
  })
  const count = (path: string) => api.calls.filter((c) => c.path === path).length
  return { api, count, change: () => { marker = '11.105' } }
}

describe('other members\' changes (msaving#25)', () => {
  it('polls the book\'s marker every 5 seconds', async () => {
    server()
    const client = testClient()
    await renderApp(<Page bookId="b1" />, { client })
    await waitFor(() => expect(client.getQueryData(['books', 'b1', 'changes'])).toEqual({ marker: '10.100' }))
    const query = client.getQueryCache().find({ queryKey: ['books', 'b1', 'changes'] })!
    expect((query.options as { refetchInterval?: number }).refetchInterval).toBe(5_000)
  })

  it('refetches the book when the marker moves, and only then', async () => {
    const { count, change } = server()
    const client = testClient()
    await renderApp(<Page bookId="b1" />, { client })
    await waitFor(() => expect(count('/v1/books/b1/accounts')).toBe(1))
    const poll = () => act(() => client.refetchQueries({ queryKey: ['books', 'b1', 'changes'] }))

    await poll()                                                    // nothing changed
    expect(count('/v1/books/b1/accounts')).toBe(1)

    change()                                                        // someone saved something
    await poll()
    await waitFor(() => expect(count('/v1/books/b1/accounts')).toBe(2))
    expect(count('/v1/books')).toBe(2)                              // names and roles too
    expect(count('/v1/books/other/accounts')).toBe(1)               // not other books
    expect(count('/v1/books/b1/changes')).toBe(3)                   // the marker isn't refetched in a loop
  })

  it('refetches the book at once from the refresh button', async () => {
    const { count } = server()
    await renderApp(<Page bookId="b1" />)
    await waitFor(() => expect(count('/v1/books/b1/accounts')).toBe(1))
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(count('/v1/books/b1/accounts')).toBe(2))
    expect(count('/v1/books/other/accounts')).toBe(1)
  })
})
