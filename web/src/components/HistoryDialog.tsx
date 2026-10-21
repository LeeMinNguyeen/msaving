import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { currentLanguage } from '../i18n'
import type { Book } from '../lib/api'
import { formatMoney } from '../lib/money'
import { personName } from '../lib/people'
import { useAccounts, useCategories, useCurrencies, useHistory } from '../lib/queries'
import { useErrorText } from './errors'

// Every saved version of a transaction, oldest first: created, each edit, deleted.
export function HistoryDialog({ book, txnId, onClose }: { book: Book; txnId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const lang = currentLanguage()
  const history = useHistory(book.id, txnId)
  // Only what was fetched since this opening: an older copy would hide the newest edit.
  const fresh = history.isFetchedAfterMount ? history.data : undefined
  const accounts = useAccounts(book.id, true)
  const categories = useCategories(book.id, true)
  const currencies = useCurrencies()
  const accountName = (id: string) => accounts.data?.find((a) => a.id === id)?.name ?? ''
  const categoryName = (id: string | null) => (id ? categories.data?.find((c) => c.id === id)?.name ?? '' : '')
  const locale = lang === 'vi' ? 'vi-VN' : 'en-GB'
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
  const day = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('txn.historyTitle')}</DialogTitle>
      <DialogContent>
        {!fresh && !history.isError && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={28} />
          </Box>
        )}
        {history.isError && <Alert severity="error">{errorText(history.error)}</Alert>}
        <Stack spacing={2}>
          {fresh?.map((h, i) => (
            <Fragment key={`${h.version}-${h.action}`}>
              {i > 0 && <Divider />}
              <Stack spacing={0.5}>
                <Typography variant="subtitle2">
                  {t(`txn.actions.${h.action}`)} · {when.format(new Date(h.changed_at))}
                  {h.changed_by ? ` · ${t('txn.by', { name: personName(h.changed_by, t) })}` : ''}
                </Typography>
                {h.action !== 'deleted' && (
                  <Typography variant="body2" color="text.secondary">
                    {[
                      t(`txn.types.${h.type}`),
                      day.format(new Date(`${h.occurred_on}T00:00:00`)),
                      ...(h.entries ?? []).map(
                        (e) => `${accountName(e.account_id)} ${formatMoney(e.amount, e.currency ?? '', currencies.data?.get(e.currency ?? '')?.minor_unit ?? 0, lang)}`,
                      ),
                      categoryName(h.category_id),
                      h.payee,
                      h.note,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Typography>
                )}
              </Stack>
            </Fragment>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.close')}</Button>
      </DialogActions>
    </Dialog>
  )
}
