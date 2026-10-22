import AddIcon from '@mui/icons-material/Add'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useErrorText } from '../components/errors'
import { currentLanguage } from '../i18n'
import { send, type Book, type Contact } from '../lib/api'
import { formatMoney } from '../lib/money'
import { useContacts, useCurrencies } from '../lib/queries'
import { PersonDialog } from './PersonDialog'
import { RefreshButton } from '../components/RefreshButton'

export function People({ book }: { book: Book }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const qc = useQueryClient()
  const lang = currentLanguage()
  const contacts = useContacts(book.id, true)
  const currencies = useCurrencies()
  const [dialog, setDialog] = useState<Contact | 'new' | null>(null)
  const [menu, setMenu] = useState<{ el: HTMLElement; person: Contact } | null>(null)
  const [notice, setNotice] = useState<{ error?: unknown; info?: string }>({})
  const canEdit = book.role !== 'viewer'
  const navigate = useNavigate()
  const money = (v: number, c: string) => formatMoney(v, c, currencies.data?.get(c)?.minor_unit ?? 0, lang)

  async function act(fn: () => Promise<unknown>) {
    setMenu(null)
    setNotice({})
    try {
      await fn()
    } catch (err) {
      setNotice({ error: err })
    }
    await qc.invalidateQueries({ queryKey: ['books', book.id, 'contacts'] })
  }

  const standing = (p: Contact) => {
    const parts = p.balances.flatMap((b) => [
      b.owed_to_you ? t('people.owesYou', { amount: money(b.owed_to_you, b.currency) }) : '',
      b.you_owe ? t('people.youOwe', { amount: money(b.you_owe, b.currency) }) : '',
    ]).filter(Boolean)
    return parts.length ? parts.join(' · ') : t('people.settled')
  }

  return (
    <Stack spacing={2}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography variant="h5">{t('nav.people')}</Typography>
          <RefreshButton bookId={book.id} />
        </Stack>
        {canEdit && <Button variant="contained" startIcon={<AddIcon />} onClick={() => setDialog('new')}>{t('people.add')}</Button>}
      </Stack>
      <Typography color="text.secondary">{t('people.title')}</Typography>
      <Typography variant="body2" color="text.secondary">{t('people.howTo')}</Typography>
      {notice.error ? <Alert severity="error">{errorText(notice.error)}</Alert> : null}
      {notice.info && <Alert severity="info">{notice.info}</Alert>}
      {contacts.data?.length === 0 && <Typography color="text.secondary">{t('people.empty')}</Typography>}
      {!!contacts.data?.length && (
        <Paper variant="outlined">
          <List disablePadding>
            {contacts.data.map((p) => (
              <ListItem key={p.id} divider disablePadding sx={{ opacity: p.archived_at ? 0.55 : 1 }}
                secondaryAction={canEdit && (
                  <IconButton edge="end" aria-label={t('people.edit')} onClick={(e) => setMenu({ el: e.currentTarget, person: p })}>
                    <MoreVertIcon />
                  </IconButton>
                )}>
                <ListItemButton onClick={() => navigate(`/books/${book.id}/transactions?account_id=${p.id}`)}>
                  <ListItemText primary={<Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}><span>{p.name}</span>{p.archived_at && <Chip size="small" label={t('cat.archived')} />}</Stack>}
                    secondary={[standing(p), p.note].filter(Boolean).join(' · ')} />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        </Paper>
      )}
      <Menu anchorEl={menu?.el} open={!!menu} onClose={() => setMenu(null)}>
        <MenuItem onClick={() => { setDialog(menu!.person); setMenu(null) }}>{t('people.edit')}</MenuItem>
        <MenuItem onClick={() => menu && act(() => send('PATCH', `/v1/books/${book.id}/contacts/${menu.person.id}`, { version: menu.person.version, archived: !menu.person.archived_at }))}>
          {t(menu?.person.archived_at ? 'people.unarchive' : 'people.archive')}
        </MenuItem>
        <MenuItem sx={{ color: 'error.main' }} onClick={() => menu && act(async () => {
          const r = await send<{ archived: boolean }>('DELETE', `/v1/books/${book.id}/contacts/${menu.person.id}?version=${menu.person.version}`)
          if (r.archived) setNotice({ info: t('people.archivedInstead') })
        })}>{t('people.delete')}</MenuItem>
      </Menu>
      {dialog && <PersonDialog book={book} person={dialog === 'new' ? null : dialog} onClose={() => setDialog(null)} />}
    </Stack>
  )
}
