import DeleteIcon from '@mui/icons-material/DeleteOutlined'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { AmountField } from '../components/AmountField'
import { BudgetBar } from '../components/BudgetBar'
import { useErrorText } from '../components/errors'
import { currentLanguage } from '../i18n'
import { budgetPeriods, send, type Book, type Budget, type BudgetPeriod, type Category } from '../lib/api'
import { todayIn } from '../lib/labels'
import { formatMoney, parseAmount } from '../lib/money'
import { useBudgets, useCurrencies, useInvalidateBook } from '../lib/queries'
import { newId } from '../lib/uuid'

// A category's budgets: one per period, in the book's currency. Sub-categories count too.
export function BudgetDialog({ book, category, onClose }: { book: Book; category: Category; onClose: () => void }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const lang = currentLanguage()
  const invalidate = useInvalidateBook()
  const budgets = useBudgets(book.id)
  const currencies = useCurrencies()
  const minor = currencies.data?.get(book.base_currency)?.minor_unit ?? 0
  const money = (v: number) => formatMoney(v, book.base_currency, minor, lang)
  const mine = (budgets.data ?? []).filter((b) => b.category_id === category.id)
  const free = budgetPeriods.filter((p) => !mine.some((b) => b.period === p))
  const [period, setPeriod] = useState<BudgetPeriod>(free.includes('monthly') ? 'monthly' : free[0] ?? 'monthly')
  const [amount, setAmount] = useState('')
  const [startsOn, setStartsOn] = useState(todayIn(book.timezone))
  const [endsOn, setEndsOn] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [id, setId] = useState(() => newId())
  const parsed = parseAmount(amount, minor, lang)

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      return true
    } catch (err) {
      setError(err)
      return false
    } finally {
      setBusy(false)
      await invalidate(book.id)
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!parsed || parsed <= 0) return
    const ok = await run(() => send('POST', `/v1/books/${book.id}/budgets`, {
      id, category_id: category.id, period, amount: parsed, starts_on: startsOn, ends_on: endsOn || null,
    }))
    if (ok) {
      setAmount('')
      setEndsOn('')
      setId(newId())
      const next = free.filter((p) => p !== period)
      if (next.length) setPeriod(next.includes('monthly') ? 'monthly' : next[0])
    }
  }

  const remove = (b: Budget) => run(() => send('DELETE', `/v1/books/${book.id}/budgets/${b.id}?version=${b.version}`))

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('budget.title')} · {category.name}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">{t('budget.subcategoriesCount')}</Typography>
          {mine.length > 0 && (
            <Stack spacing={2}>
              <Typography variant="subtitle2">{t('budget.existing')}</Typography>
              {mine.map((b) => (
                <Stack key={b.id} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <Stack sx={{ flex: 1, minWidth: 0 }}>
                    {b.progress ? (
                      <BudgetBar label={t(`budget.periods.${b.period}`)} spent={b.progress.spent} budget={b.amount} percent={b.progress.percent_used} format={money} />
                    ) : (
                      <Typography variant="body2">{t(`budget.periods.${b.period}`)} · {money(b.amount)} · {t('budget.notActive')}</Typography>
                    )}
                  </Stack>
                  <IconButton aria-label={t('budget.delete')} onClick={() => remove(b)} disabled={busy}>
                    <DeleteIcon />
                  </IconButton>
                </Stack>
              ))}
              <Divider />
            </Stack>
          )}
          {free.length > 0 && (
            <Stack component="form" spacing={2} onSubmit={add}>
              <Typography variant="subtitle2">{t('budget.add')}</Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField select label={t('budget.period')} value={period} onChange={(e) => setPeriod(e.target.value as BudgetPeriod)} sx={{ minWidth: 160 }}>
                  {free.map((p) => <MenuItem key={p} value={p}>{t(`budget.periods.${p}`)}</MenuItem>)}
                </TextField>
                <AmountField label={`${t('budget.amount')} (${book.base_currency})`} required value={amount} onChange={setAmount} minorUnit={minor} />
              </Stack>
              <Stack direction="row" spacing={2}>
                <TextField type="date" label={t('budget.startsOn')} value={startsOn} onChange={(e) => setStartsOn(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
                <TextField type="date" label={t('budget.endsOn')} value={endsOn} onChange={(e) => setEndsOn(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
              </Stack>
              <Button type="submit" variant="contained" loading={busy} disabled={!parsed || parsed <= 0} sx={{ alignSelf: 'start' }}>
                {t('budget.save')}
              </Button>
            </Stack>
          )}
          {error ? <Alert severity="error">{errorText(error)}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
      </DialogActions>
    </Dialog>
  )
}
