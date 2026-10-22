import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { RefreshButton } from '../components/RefreshButton'
import { fakeApi } from '../test/fakeApi'
import { renderApp, testClient } from '../test/render'
import { useAccounts, useBookChanges, useBooks, useInvalidateBook } from './queries'

// A book page: the change watcher (in the Shell) and some of the book's data.
// "Save" stands for the user's own change, which refetches what it touched.
function Page({ bookId, onSave }: { bookId: string; onSave?: () => void }) {
  useBookChanges(bookId)
  useAccounts(bookId, false)
  useAccounts('other', false) // another book, which must be left alone
  useBooks()
  const invalidate = useInvalidateBook()
  return (
    <>
      <RefreshButton bookId={bookId} />
      <button onClick={() => { onSave?.(); void invalidate(bookId) }}>Save</button>
    </>
  )
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
  let changes = 0
  return { api, count, change: () => { marker = `11.${105 + ++changes}` } } // each change a new marker
}

// The page as it is once loaded, and a poll of the marker. TanStack Query tells
// React about new data on a timer, so each step waits for that too: otherwise,
// on a busy machine, two markers can reach the page in one render.
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)))
async function loaded(client: QueryClient, count: (path: string) => number) {
  await waitFor(() => expect(count('/v1/books/b1/accounts')).toBe(1))
  await waitFor(() => expect(client.getQueryData(['books', 'b1', 'changes'])).toBeTruthy())
  await settle()
  return async () => {
    await act(() => client.refetchQueries({ queryKey: ['books', 'b1', 'changes'] }))
    await settle()
  }
}

describe('other members\' changes (waterflow#25)', () => {
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
    const poll = await loaded(client, count)

    await poll()                                                    // nothing changed
    expect(count('/v1/books/b1/accounts')).toBe(1)

    change()                                                        // someone saved something
    await poll()
    await waitFor(() => expect(count('/v1/books/b1/accounts')).toBe(2))
    expect(count('/v1/books')).toBe(2)                              // names and roles too
    expect(count('/v1/books/other/accounts')).toBe(1)               // not other books
    expect(count('/v1/books/b1/changes')).toBe(3)                   // the marker isn't refetched in a loop
  })

  it("doesn't fetch the user's own change a second time, but still sees one saved after it", async () => {
    const { count, change } = server()
    const client = testClient()
    await renderApp(<Page bookId="b1" onSave={change} />, { client })
    const poll = await loaded(client, count)

    await userEvent.click(screen.getByRole('button', { name: 'Save' }))     // the user's own save moves the marker
    await waitFor(() => expect(count('/v1/books/b1/accounts')).toBe(2))    // refetched by the save itself
    await poll()
    expect(count('/v1/books/b1/accounts')).toBe(2)                          // not again for the marker
    expect(count('/v1/books')).toBe(1)

    change()                                                                // then someone else saves
    await poll()
    await waitFor(() => expect(count('/v1/books/b1/accounts')).toBe(3))
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
