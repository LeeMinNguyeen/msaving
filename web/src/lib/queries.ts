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

// Not kept between openings: a cached copy would show first and hide the newest
// edit until the refetch lands, which on a slow link takes seconds (msaving#18).
export function useHistory(bookId: string, txnId: string) {
  return useQuery({
    queryKey: ['books', bookId, 'transactions', 'history', txnId],
    queryFn: () => api<HistoryEntry[]>(`/v1/books/${bookId}/transactions/${txnId}/history`),
    gcTime: 0,
  })
}

// After any money change: transactions and balances both move.
export function useInvalidateBook() {
  const qc = useQueryClient()
  return (bookId: string) =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['books', bookId, 'transactions'] }),
      qc.invalidateQueries({ queryKey: ['books', bookId, 'accounts'] }),
      qc.invalidateQueries({ queryKey: ['books', bookId, 'dashboard'] }),
      qc.invalidateQueries({ queryKey: ['books', bookId, 'contacts'] }),
      qc.invalidateQueries({ queryKey: ['books', bookId, 'budgets'] }),
    ])
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
  return (bookId: string) => refreshBook(qc, bookId)
}


// Another member's change shows within seconds (msaving#25): a tiny marker,
// polled while the page is visible, and the book's data refetched when it moves.
export function useBookChanges(bookId: string) {
  const qc = useQueryClient()
  const changes = useQuery({
    queryKey: ['books', bookId, 'changes'],
    queryFn: () => api<{ marker: string }>(`/v1/books/${bookId}/changes`),
    refetchInterval: 5_000,
  })
  const marker = changes.data?.marker
  const seen = useRef<{ bookId: string; marker?: string }>({ bookId, marker })
  useEffect(() => {
    const before = seen.current
    if (before.bookId === bookId && before.marker && marker && marker !== before.marker) void refreshBook(qc, bookId)
    seen.current = { bookId, marker }
  }, [qc, bookId, marker])
}
