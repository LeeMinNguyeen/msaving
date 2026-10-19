import Button from '@mui/material/Button'
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

// Every saved version of a transaction, oldest first: created, each edit, deleted.
export function HistoryDialog({ book, txnId, onClose }: { book: Book; txnId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const lang = currentLanguage()
  const history = useHistory(book.id, txnId)
  const accounts = useAccounts(book.id, true)
  const categories = useCategories(book.id, true)
  const currencies = useCurrencies()
  const accountName = (id: string) => accounts.data?.find((a) => a.id === id)?.name ?? ''
  const categoryName = (id: string | null) => (id ? categories.data?.find((c) => c.id === id)?.name ?? '' : '')
  const when = new Intl.DateTimeFormat(lang === 'vi' ? 'vi-VN' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' })

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('txn.historyTitle')}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          {history.data?.map((h, i) => (
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
                      h.occurred_on,
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
        <Button onClick={onClose}>{t('common.cancel')}</Button>
      </DialogActions>
    </Dialog>
  )
}
