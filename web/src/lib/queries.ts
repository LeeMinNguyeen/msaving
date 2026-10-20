import { useInfiniteQuery, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { api, type Account, type Book, type Budget, type Category, type Contact, type Currency, type Dashboard, type HistoryEntry, type Instance, type Me, type Member, type BookInvite, type TxnPage } from './api'

export const keys = {
  me: ['me'] as const,
  books: ['books'] as const,
  bookInvites: ['me', 'book-invites'] as const,
  members: (bookId: string) => ['books', bookId, 'members'] as const,
  accounts: (bookId: string, archived: boolean) => ['books', bookId, 'accounts', archived] as const,
  categories: (bookId: string, archived: boolean) => ['books', bookId, 'categories', archived] as const,
  transactions: (bookId: string, filters?: TxnFilters) => ['books', bookId, 'transactions', filters ?? {}] as const,
}

export const useMe = (enabled = true) => useQuery({ queryKey: keys.me, queryFn: () => api<Me>('/v1/me'), enabled })
export const useInstance = () => useQuery({ queryKey: ['instance'], queryFn: () => api<Instance>('/v1/instance') })
export const useBooks = () => useQuery({ queryKey: keys.books, queryFn: () => api<Book[]>('/v1/books') })
export const useBookInvites = () => useQuery({ queryKey: keys.bookInvites, queryFn: () => api<BookInvite[]>('/v1/me/book-invites') })
export const useMembers = (bookId: string) =>
  useQuery({ queryKey: keys.members(bookId), queryFn: () => api<Member[]>(`/v1/books/${bookId}/members`) })

export function useCurrencies() {
  return useQuery({
    queryKey: ['currencies'],
    queryFn: () => api<Currency[]>('/v1/currencies'),
    staleTime: Infinity,
    select: (list) => new Map(list.map((c) => [c.code, c])),
  })
}

export function useAccounts(bookId: string, includeArchived: boolean) {
  return useQuery({
    queryKey: keys.accounts(bookId, includeArchived),
    queryFn: () => api<Account[]>(`/v1/books/${bookId}/accounts?include_archived=${includeArchived}`),
  })
}

export function useCategories(bookId: string, includeArchived = false) {
  return useQuery({
    queryKey: keys.categories(bookId, includeArchived),
    queryFn: () => api<Category[]>(`/v1/books/${bookId}/categories?include_archived=${includeArchived}`),
  })
}

export type TxnFilters = {
  account_id?: string
  category_id?: string
  type?: string
  from?: string
  to?: string
  q?: string
}

// Newest first, a page at a time ("Load more").
export function useTransactions(bookId: string, filters: TxnFilters) {
  return useInfiniteQuery({
    queryKey: keys.transactions(bookId, filters),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][])
      if (pageParam) params.set('after', pageParam)
      return api<TxnPage>(`/v1/books/${bookId}/transactions?${params}`)
    },
    getNextPageParam: (last) => last.next,
  })
}

// Not kept between openings (msaving#18): a cached copy would show first and
// hide the newest edit until the refetch lands, seconds on a slow link. The
// dialog also waits for a fetch of its own (isFetchedAfterMount).
export function useHistory(bookId: string, txnId: string) {
  return useQuery({
    queryKey: ['books', bookId, 'transactions', 'history', txnId],
    queryFn: () => api<HistoryEntry[]>(`/v1/books/${bookId}/transactions/${txnId}/history`),
    gcTime: 0,
  })
}

// After any money change: transactions and balances both move. The change
// marker is noted first, so the poll doesn't fetch the user's own change again.
export function useInvalidateBook() {
  const qc = useQueryClient()
  return async (bookId: string) => {
    await noteMarker(qc, bookId)
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['books', bookId, 'transactions'] }),
      qc.invalidateQueries({ queryKey: ['books', bookId, 'accounts'] }),
      qc.invalidateQueries({ queryKey: ['books', bookId, 'dashboard'] }),
      qc.invalidateQueries({ queryKey: ['books', bookId, 'contacts'] }),
      qc.invalidateQueries({ queryKey: ['books', bookId, 'budgets'] }),
    ])
  }
}

export function useDashboard(bookId: string) {
  return useQuery({ queryKey: ['books', bookId, 'dashboard'], queryFn: () => api<Dashboard>(`/v1/books/${bookId}/dashboard`) })
}

export function useContacts(bookId: string, includeArchived = false) {
  return useQuery({
    queryKey: ['books', bookId, 'contacts', includeArchived],
    queryFn: () => api<Contact[]>(`/v1/books/${bookId}/contacts?include_archived=${includeArchived}`),
  })
}

export function useBudgets(bookId: string) {
  return useQuery({ queryKey: ['books', bookId, 'budgets'], queryFn: () => api<Budget[]>(`/v1/books/${bookId}/budgets`) })
}

// A book's own queries, without the change marker below.
const ofBook = (bookId: string) => ({
  predicate: (q: { queryKey: readonly unknown[] }) => q.queryKey[0] === 'books' && q.queryKey[1] === bookId && q.queryKey[2] !== 'changes',
})

// Everything shown about a book, fetched again: its data, the book list
// (names, roles) and pending invites.
export function refreshBook(qc: QueryClient, bookId: string) {
  return Promise.all([
    qc.invalidateQueries(ofBook(bookId)),
    qc.invalidateQueries({ queryKey: keys.books, exact: true }),
    qc.invalidateQueries({ queryKey: keys.bookInvites }),
  ])
}

export function useRefreshBook() {
  const qc = useQueryClient()
  return async (bookId: string) => {
    await noteMarker(qc, bookId)
    await refreshBook(qc, bookId)
  }
}

// Another member's change shows within seconds (msaving#25): a tiny marker,
// polled while the page is visible, and the book's data refetched when it moves.
type Changes = { marker: string; handled?: boolean }
const changesKey = (bookId: string) => ['books', bookId, 'changes']

export function useBookChanges(bookId: string) {
  const qc = useQueryClient()
  const changes = useQuery({
    queryKey: changesKey(bookId),
    queryFn: () => api<Changes>(`/v1/books/${bookId}/changes`),
    refetchInterval: 5_000,
  })
  const marker = changes.data?.marker
  const handled = changes.data?.handled
  const seen = useRef<{ bookId: string; marker?: string }>({ bookId, marker })
  useEffect(() => {
    const before = seen.current
    if (!handled && before.bookId === bookId && before.marker && marker && marker !== before.marker) void refreshBook(qc, bookId)
    seen.current = { bookId, marker }
  }, [qc, bookId, marker, handled])
}

// Before the app refetches a book itself (after the user's own change, or
// Refresh): the marker as it is now, marked handled so the poll doesn't refetch
// the same data again. It's read before that refetch, so anything saved after
// it still moves the marker.
async function noteMarker(qc: QueryClient, bookId: string) {
  try {
    await qc.cancelQueries({ queryKey: changesKey(bookId) })
    const { marker } = await api<Changes>(`/v1/books/${bookId}/changes`)
    qc.setQueryData<Changes>(changesKey(bookId), { marker, handled: true })
  } catch {
    // The poll catches up.
  }
}
