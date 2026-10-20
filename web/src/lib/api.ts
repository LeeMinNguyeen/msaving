import { session } from '../auth/session'

// An error from the API. `code` is what the API sent as `detail` (for example
// not_signed_in or owner_required), which the screens translate.
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(code)
    this.status = status
    this.code = code
  }
}

async function fail(res: Response): Promise<never> {
  const body = await res.json().catch(() => null)
  const code = typeof body?.detail === 'string' ? body.detail : 'unexpected_error'
  // The session ended (expired, signed out elsewhere, account disabled): back to sign-in.
  if (res.status === 401 && code === 'not_signed_in' && session.token()) session.set(null)
  throw new ApiError(res.status, code)
}

function authHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init)
  const token = session.token()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return headers
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = authHeaders(init.headers)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

  const res = await fetch(path, { ...init, headers })
  if (!res.ok) await fail(res)
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

// A file from the API (the data export): saved by the browser under the name it sends.
export async function download(path: string): Promise<void> {
  const res = await fetch(path, { headers: authHeaders() })
  if (!res.ok) await fail(res)
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'export.zip'
  const url = URL.createObjectURL(await res.blob())
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  URL.revokeObjectURL(url)
}

export type AccountStatus = { deletion_requested_at: string | null; deletes_on: string | null }

export const send = <T>(method: string, path: string, body?: unknown) =>
  api<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })

export type Language = 'vi' | 'en'

export type Profile = {
  username: string
  display_name: string | null
  timezone: string
  language: Language
  created_at: string
  deletion_requested_at: string | null
  is_admin: boolean
}

export type Me = { id: string; profile: Profile }

// What a server says about itself before anyone signs in (GET /v1/instance).
export type Instance = { name: string; server_version: string; api_version: number; signup: 'invite' | 'open'; setup_needed: boolean }
export type Token = { token: string }

export type Currency = { code: string; minor_unit: number; name: string }

export type Role = 'owner' | 'editor' | 'viewer'
export type Book = {
  id: string
  name: string
  base_currency: string
  timezone: string
  role: Role
  archived_at: string | null
  version: number
}

// A book's member; `name` is a username or "Deleted user" (lib/people.ts).
export type Member = { user_id: string; name: string; display_name: string | null; role: Role; pending: boolean; me: boolean }
// An invite to someone else's book that I haven't answered.
export type BookInvite = { book_id: string; book_name: string; role: Role; invited_by: string; invited_at: string }

export const accountKinds = [
  'cash', 'checking', 'savings', 'investment', 'credit_card', 'loan', 'lent', 'other_asset', 'other_liability',
] as const
export type AccountKind = (typeof accountKinds)[number]
// Liabilities have negative balances: what's owed is entered as a positive amount.
export const liabilityKinds: readonly AccountKind[] = ['credit_card', 'loan', 'other_liability']
// Details by kind (msaving#17): which kinds have card or account numbers, an
// interest rate, the credit card fields. A note goes on any account.
export const last4Kinds: readonly AccountKind[] = ['checking', 'savings', 'investment', 'credit_card', 'loan']
export const interestKinds: readonly AccountKind[] = ['savings', 'credit_card', 'loan', 'lent']

export type Account = {
  id: string
  name: string
  kind: AccountKind
  currency: string
  last4: string | null
  in_net_worth: boolean
  contact_id: string | null
  note: string | null
  credit_limit: number | null // credit cards: minor units of the account's currency
  annual_fee: number | null
  statement_day: number | null // day of the month
  payment_due_day: number | null
  interest_rate_bp: number | null // hundredths of a percent a year: 5.5 % = 550
  archived_at: string | null
  version: number
  balance: number
}

export type CategoryKind = 'expense' | 'income' | 'transfer'
export type Category = {
  id: string
  parent_id: string | null
  name: string
  kind: CategoryKind
  color: string | null
  archived_at: string | null
  version: number
}

export const txnTypes = ['expense', 'income', 'transfer', 'refund', 'adjustment', 'opening_balance'] as const
export type TxnType = (typeof txnTypes)[number]
// What each type's category must be (null = no category). Refunds reduce an
// expense category's spending.
export const categoryKindFor: Record<TxnType, CategoryKind | null> = {
  expense: 'expense',
  refund: 'expense',
  income: 'income',
  transfer: 'transfer',
  adjustment: null,
  opening_balance: null,
}

export type Entry = { account_id: string; amount: number; currency?: string }
export type Transaction = {
  id: string
  type: TxnType
  occurred_on: string
  category_id: string | null
  payee: string | null
  note: string | null
  entries: Entry[]
  version: number
  created_at: string
  modified_at: string
  created_by: string | null
  modified_by: string | null
  running_balance: number | null
}
export type TxnPage = { items: Transaction[]; next: string | null }

export type HistoryEntry = {
  version: number
  action: 'created' | 'edited' | 'deleted'
  changed_at: string
  changed_by: string | null
  type: TxnType
  occurred_on: string
  category_id: string | null
  payee: string | null
  note: string | null
  entries: Entry[] | null
}

export type Dashboard = {
  currency: string | null
  rates_source: string | null
  net_worth: number
  net_worth_missing_rates: number
  spent_this_month: number
  spent_last_month: number
  income_this_month: number
  cashflow_6_months: { month: string; spent: number; income: number; not_converted: number }[]
  top_categories_this_month: { category_id: string | null; category: string; category_parent_id: string | null; spent: number; not_converted: number }[]
  budgets: { budget_id: string; category_id: string; category: string; period: string; period_start: string; period_end: string; budget: number; spent: number; remaining: number; percent_used: number | null; not_converted: number }[]
  accounts: { account_id: string; name: string; kind: AccountKind; currency: string; balance: number; converted_balance: number | null; in_net_worth: boolean }[]
  people: { contact_id: string; name: string; currency: string; owed_to_you: number; you_owe: number }[]
  recent_transactions: { id: string; type: TxnType; occurred_on: string; payee: string | null; category: string | null; amount: number | null; currency: string | null }[]
}

export type Contact = {
  id: string
  name: string
  note: string | null
  archived_at: string | null
  version: number
  balances: { currency: string; owed_to_you: number; you_owe: number }[]
}
// Only these account kinds can be tied to a person.
export const personKinds: readonly AccountKind[] = ['lent', 'loan']

export const budgetPeriods = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'] as const
export type BudgetPeriod = (typeof budgetPeriods)[number]
export type Budget = {
  id: string
  category_id: string
  period: BudgetPeriod
  amount: number
  starts_on: string
  ends_on: string | null
  version: number
  progress: { period_start: string; period_end: string; spent: number; remaining: number; percent_used: number; not_converted: number } | null
}
