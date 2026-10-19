import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link as RouterLink, useNavigate } from 'react-router'
import { BudgetBar } from '../components/BudgetBar'
import { CashflowChart } from '../components/charts/CashflowChart'
import { useChartColors } from '../components/charts/palette'
import { useErrorText } from '../components/errors'
import { useOpenTxn } from '../components/txnContext'
import { currentLanguage } from '../i18n'
import { api, type Book, type Transaction } from '../lib/api'
import { todayIn } from '../lib/labels'
import { formatMoney } from '../lib/money'
import { useCategories, useCurrencies, useDashboard } from '../lib/queries'

function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{title}</Typography>
        {action}
      </Stack>
      {children}
    </Paper>
  )
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant="h4" sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', my: 0.5 }}>{value}</Typography>
      {note && <Typography variant="body2" color="text.secondary">{note}</Typography>}
    </Paper>
  )
}

// The six month starts ending with the book's current month, YYYY-MM-01.
function lastSixMonths(today: string): string[] {
  const [y, m] = today.split('-').map(Number)
  return Array.from({ length: 6 }, (_, i) => {
    const n = y * 12 + (m - 1) - (5 - i)
    return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}-01`
  })
}

// Screen 4, the home screen: everything from one API call, in the book's currency.
export function Dashboard({ book }: { book: Book }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const lang = currentLanguage()
  const navigate = useNavigate()
  const openTxn = useOpenTxn()
  const colors = useChartColors()
  const dash = useDashboard(book.id)
  const categories = useCategories(book.id, true)
  const currencies = useCurrencies()
  const minor = (c: string) => currencies.data?.get(c)?.minor_unit ?? 0
  const money = (amount: number, currency = book.base_currency) => formatMoney(amount, currency, minor(currency), lang)
  const locale = lang === 'vi' ? 'vi-VN' : 'en-GB'
  const axis = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'short' })
  const dayFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' })

  if (dash.isPending) return null
  if (dash.isError) return <Alert severity="error">{errorText(dash.error)}</Alert>
  const d = dash.data

  const months = lastSixMonths(todayIn(book.timezone))
  const byMonth = new Map(d.cashflow_6_months.map((m) => [m.month, m]))
  const cashflow = months.map((month) => ({ month, spent: byMonth.get(month)?.spent ?? 0, income: byMonth.get(month)?.income ?? 0 }))
  const notConverted = d.cashflow_6_months.reduce((n, m) => n + m.not_converted, 0)

  // Roll sub-categories into their top-level category.
  const parentOf = new Map((categories.data ?? []).map((c) => [c.id, c.parent_id]))
  const nameOf = new Map((categories.data ?? []).map((c) => [c.id, c.name]))
  const colorOf = new Map((categories.data ?? []).map((c) => [c.id, c.color]))
  const top = (id: string | null) => {
    let cur = id
    while (cur && parentOf.get(cur)) cur = parentOf.get(cur)!
    return cur
  }
  const rolled = new Map<string, { id: string | null; spent: number }>()
  for (const c of d.top_categories_this_month) {
    const id = top(c.category_id)
    const key = id ?? 'none'
    rolled.set(key, { id, spent: (rolled.get(key)?.spent ?? 0) + c.spent })
  }
  const bars = [...rolled.values()].sort((a, b) => b.spent - a.spent).slice(0, 6)
  const barMax = Math.max(1, ...bars.map((b) => b.spent))

  async function openRecent(id: string) {
    openTxn(await api<Transaction>(`/v1/books/${book.id}/transactions/${id}`))
  }

  const empty = d.accounts.length === 0
  return (
    <Stack spacing={2}>
      <Typography variant="h5">{t('dash.title')}</Typography>
      {empty && <Alert severity="info">{t('dash.empty')}</Alert>}
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '2fr 1fr 1fr' } }}>
        <Tile label={t('dash.netWorth')} value={money(d.net_worth)}
          note={d.net_worth_missing_rates ? t('dash.missingRates', { count: d.net_worth_missing_rates }) : undefined} />
        <Tile label={t('dash.spentThisMonth')} value={money(d.spent_this_month)} note={t('dash.vsLastMonth', { amount: money(d.spent_last_month) })} />
        <Tile label={t('dash.incomeThisMonth')} value={money(d.income_this_month)} />
      </Box>

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: '3fr 2fr' }, alignItems: 'start' }}>
        <Card title={t('dash.cashflow')}>
          <CashflowChart
            data={cashflow}
            labels={{ spent: t('dash.spent'), income: t('dash.income'), month: t('dash.month') }}
            formatMoney={(v) => money(v)}
            formatAxis={(v) => axis.format(v / 10 ** minor(book.base_currency))}
            formatMonth={(iso) => monthFmt.format(new Date(`${iso}T00:00:00`))}
          />
          {notConverted > 0 && <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{t('dash.notConverted', { count: notConverted })}</Typography>}
        </Card>

        <Card title={t('dash.topCategories')}>
          {bars.length === 0 && <Typography color="text.secondary">{t('dash.noSpending')}</Typography>}
          <Stack spacing={1.5}>
            {bars.map((b) => (
              <Box key={b.id ?? 'none'} onClick={() => b.id && navigate(`/books/${book.id}/transactions?category_id=${b.id}`)}
                sx={{ cursor: b.id ? 'pointer' : undefined }}>
                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
                    <Box sx={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, bgcolor: (b.id && colorOf.get(b.id)) || 'action.disabled' }} />
                    <Typography variant="body2" noWrap>{b.id ? nameOf.get(b.id) : t('dash.uncategorized')}</Typography>
                  </Stack>
                  <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', ml: 1 }}>{money(b.spent)}</Typography>
                </Stack>
                <Box sx={{ height: 8, borderRadius: '4px', bgcolor: 'action.hover' }}>
                  <Box sx={{ height: 8, borderRadius: '4px', bgcolor: colors.magnitude, width: `${(b.spent / barMax) * 100}%` }} />
                </Box>
              </Box>
            ))}
          </Stack>
        </Card>
      </Box>

      {(d.budgets.length > 0 || d.people.length > 0) && (
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, alignItems: 'start' }}>
          {d.budgets.length > 0 && (
            <Card title={t('dash.budgets')} action={<Button size="small" component={RouterLink} to={`/books/${book.id}/categories`}>{t('dash.seeAll')}</Button>}>
              <Stack spacing={2}>
                {d.budgets.slice(0, 6).map((b) => (
                  <BudgetBar key={b.budget_id} label={`${b.category} · ${t(`budget.periods.${b.period}`)}`} spent={b.spent} budget={b.budget}
                    percent={b.percent_used ?? 0} format={(v) => money(v)} />
                ))}
              </Stack>
            </Card>
          )}
          {d.people.length > 0 && (
            <Card title={t('dash.people')} action={<Button size="small" component={RouterLink} to={`/books/${book.id}/accounts`}>{t('dash.seeAll')}</Button>}>
              <List disablePadding dense>
                {d.people.map((p) => (
                  <ListItemButton key={`${p.contact_id}-${p.currency}`} sx={{ px: 0 }} onClick={() => navigate(`/books/${book.id}/accounts`)}>
                    <ListItemText primary={p.name} />
                    <Stack sx={{ textAlign: 'right' }}>
                      {p.owed_to_you > 0 && <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>{t('people.owesYou', { amount: money(p.owed_to_you, p.currency) })}</Typography>}
                      {p.you_owe > 0 && <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>{t('people.youOwe', { amount: money(p.you_owe, p.currency) })}</Typography>}
                    </Stack>
                  </ListItemButton>
                ))}
              </List>
            </Card>
          )}
        </Box>
      )}

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, alignItems: 'start' }}>
        <Card title={t('dash.accounts')} action={<Button size="small" component={RouterLink} to={`/books/${book.id}/accounts`}>{t('dash.seeAll')}</Button>}>
          <List disablePadding dense>
            {d.accounts.map((a) => (
              <ListItemButton key={a.account_id} onClick={() => navigate(`/books/${book.id}/transactions?account_id=${a.account_id}`)}
                sx={{ px: 0, opacity: a.in_net_worth ? 1 : 0.55 }}>
                <ListItemText primary={a.name} secondary={t(`accounts.kinds.${a.kind}`)} />
                <Box sx={{ textAlign: 'right', ml: 2 }}>
                  <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{money(a.balance, a.currency)}</Typography>
                  {a.currency !== book.base_currency && (
                    <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                      {a.converted_balance === null ? t('dash.noRate') : `≈ ${money(a.converted_balance)}`}
                    </Typography>
                  )}
                </Box>
              </ListItemButton>
            ))}
          </List>
        </Card>

        <Card title={t('dash.recent')} action={<Button size="small" component={RouterLink} to={`/books/${book.id}/transactions`}>{t('dash.seeAll')}</Button>}>
          <List disablePadding dense>
            {d.recent_transactions.map((r) => (
              <ListItemButton key={r.id} onClick={() => openRecent(r.id)} sx={{ px: 0 }}>
                <ListItemText primary={r.payee || t(`txn.types.${r.type}`)}
                  secondary={[dayFmt.format(new Date(`${r.occurred_on}T00:00:00`)), r.category].filter(Boolean).join(' · ')} />
                {r.amount !== null && r.currency && (
                  <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', ml: 2,
                    color: r.type === 'transfer' ? undefined : r.amount < 0 ? 'error.main' : 'success.main' }}>
                    {money(r.type === 'transfer' ? Math.abs(r.amount) : r.amount, r.currency)}
                  </Typography>
                )}
              </ListItemButton>
            ))}
          </List>
        </Card>
      </Box>
    </Stack>
  )
}
