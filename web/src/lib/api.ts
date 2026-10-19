import { config } from '../config'
import { supabase } from './supabase'

// An error from the API. `code` is what the API sent as `detail` (for example
// not_signed_in or plan_limit), which the screens translate.
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(code)
    this.status = status
    this.code = code
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await supabase.auth.getSession()
  const headers = new Headers(init.headers)
  if (data.session) headers.set('Authorization', `Bearer ${data.session.access_token}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

  const res = await fetch(`${config.apiUrl}${path}`, { ...init, headers })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const code = typeof body?.detail === 'string' ? body.detail : 'unexpected_error'
    throw new ApiError(res.status, code)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

// A file from the API (the data export): saved by the browser under the name it sends.
export async function download(path: string): Promise<void> {
  const { data } = await supabase.auth.getSession()
  const res = await fetch(`${config.apiUrl}${path}`, { headers: data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {} })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new ApiError(res.status, typeof body?.detail === 'string' ? body.detail : 'unexpected_error')
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'export.zip'
  const url = URL.createObjectURL(await res.blob())
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  URL.revokeObjectURL(url)
}

export type ConsentStatus = { current_version: string | null; current_path: string | null; agreed_version: string | null; agreed_at: string | null; needs_consent: boolean }
export type AccountStatus = { deletion_requested_at: string | null; deletes_on: string | null }

export const send = <T>(method: string, path: string, body?: unknown) =>
  api<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })

export type Language = 'vi' | 'en'

export type Profile = {
  username: string
  display_name: string | null
  email: string
  timezone: string
  language: Language
  created_at: string
  deletion_requested_at: string | null
  plan: string
}

// profile is null until the user picks a username and agrees to the privacy policy.
export type Me = { id: string; profile: Profile | null; needs_consent: boolean }

export type Currency = { code: string; minor_unit: number; name: string }
export type Policy = { version: string; path: string }

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

export const accountKinds = [
  'cash', 'checking', 'savings', 'investment', 'credit_card', 'loan', 'lent', 'other_asset', 'other_liability',
] as const
export type AccountKind = (typeof accountKinds)[number]
// Liabilities have negative balances: what's owed is entered as a positive amount.
export const liabilityKinds: readonly AccountKind[] = ['credit_card', 'loan', 'other_liability']

export type Account = {
  id: string
  name: string
  kind: AccountKind
  currency: string
  last4: string | null
  in_net_worth: boolean
  contact_id: string | null
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
