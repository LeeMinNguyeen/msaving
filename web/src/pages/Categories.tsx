import AddIcon from '@mui/icons-material/Add'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import ListSubheader from '@mui/material/ListSubheader'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Typography from '@mui/material/Typography'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useErrorText } from '../components/errors'
import { send, type Book, type Category, type CategoryKind } from '../lib/api'
import { categoryTree } from '../lib/categories'
import { BudgetBar } from '../components/BudgetBar'
import { currentLanguage } from '../i18n'
import { formatMoney } from '../lib/money'
import { useBudgets, useCategories, useCurrencies } from '../lib/queries'
import { BudgetDialog } from './BudgetDialog'
import { CategoryDialog } from './CategoryDialog'
import { RefreshButton } from '../components/RefreshButton'

const KINDS: CategoryKind[] = ['expense', 'income', 'transfer']

// A category opens its details, which lead to its transactions.
export function Categories({ book }: { book: Book }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [showArchived, setShowArchived] = useState(false)
  const categories = useCategories(book.id, showArchived)
  const all = useCategories(book.id, true)
  const [dialog, setDialog] = useState<{ category: Category | null; parent?: Category; editing?: boolean } | null>(null)
  const [menu, setMenu] = useState<{ el: HTMLElement; category: Category } | null>(null)
  const [notice, setNotice] = useState<{ error?: unknown; info?: string }>({})
  const canEdit = book.role !== 'viewer'
  const budgets = useBudgets(book.id)
  const currencies = useCurrencies()
  const [budgetFor, setBudgetFor] = useState<Category | null>(null)
  const money = (v: number) => formatMoney(v, book.base_currency, currencies.data?.get(book.base_currency)?.minor_unit ?? 0, currentLanguage())
  // The most used running budget of each category, shown under it.
  const shown = new Map<string, NonNullable<ReturnType<typeof running>>>()
  function running(id: string) {
    return (budgets.data ?? []).filter((b) => b.category_id === id && b.progress)
      .sort((a, b) => (b.progress!.percent_used) - (a.progress!.percent_used))[0]
  }
  for (const c of categories.data ?? []) { const b = running(c.id); if (b) shown.set(c.id, b) }

  async function act(fn: () => Promise<unknown>) {
    setMenu(null)
    setNotice({})
    try {
      await fn()
    } catch (err) {
      setNotice({ error: err })
    }
    await qc.invalidateQueries({ queryKey: ['books', book.id, 'categories'] })
  }
  const archive = (c: Category, archived: boolean) =>
    act(() => send('PATCH', `/v1/books/${book.id}/categories/${c.id}`, { version: c.version, archived }))
  const remove = (c: Category) =>
    act(async () => {
      const r = await send<{ deleted: boolean; archived: boolean }>('DELETE', `/v1/books/${book.id}/categories/${c.id}?version=${c.version}`)
      if (r.archived) setNotice({ info: t('cat.archivedInstead') })
    })

  return (
    <Stack spacing={2}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography variant="h5">{t('cat.title')}</Typography>
          <RefreshButton bookId={book.id} />
        </Stack>
        {canEdit && (
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setDialog({ category: null })}>
            {t('cat.add')}
          </Button>
        )}
      </Stack>
      {notice.error ? <Alert severity="error">{errorText(notice.error)}</Alert> : null}
      {notice.info && <Alert severity="info">{notice.info}</Alert>}
      {categories.data?.length === 0 && <Typography color="text.secondary">{t('cat.empty')}</Typography>}
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' }, alignItems: 'start' }}>
        {KINDS.map((kind) => {
          const rows = categoryTree(categories.data ?? [], kind)
          if (!rows.length) return null
          return (
            <Paper key={kind} variant="outlined">
              <List disablePadding subheader={<ListSubheader>{t(`cat.kinds.${kind}`)}</ListSubheader>}>
                {rows.map(({ category: c, depth }) => (
                  <ListItem key={c.id} disablePadding divider
                    secondaryAction={canEdit && (
                      <IconButton edge="end" aria-label={t('cat.edit')} onClick={(e) => setMenu({ el: e.currentTarget, category: c })}>
                        <MoreVertIcon />
                      </IconButton>
                    )}>
                    <ListItemButton sx={{ pl: 2 + depth * 3, opacity: c.archived_at ? 0.55 : 1 }}
                      onClick={() => setDialog({ category: c })}>
                      <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: c.color ?? 'action.disabled', mr: 1.5, flexShrink: 0 }} />
                      <ListItemText primary={c.name} secondary={shown.get(c.id) && (
                        <BudgetBar label={t(`budget.periods.${shown.get(c.id)!.period}`)} spent={shown.get(c.id)!.progress!.spent}
                          budget={shown.get(c.id)!.amount} percent={shown.get(c.id)!.progress!.percent_used} format={money} />
                      )} slotProps={{ secondary: { component: 'div' } }} sx={{ pr: 1 }} />
                      {c.archived_at && <Chip size="small" label={t('cat.archived')} />}
                    </ListItemButton>
                  </ListItem>
                ))}
              </List>
            </Paper>
          )
        })}
      </Box>
      <FormControlLabel control={<Switch checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />} label={t('cat.showArchived')} />
      <Menu anchorEl={menu?.el} open={!!menu} onClose={() => setMenu(null)}>
        <MenuItem onClick={() => { setDialog({ category: menu!.category, editing: true }); setMenu(null) }}>{t('cat.edit')}</MenuItem>
        <MenuItem onClick={() => { setDialog({ category: null, parent: menu!.category }); setMenu(null) }}>{t('cat.addSub')}</MenuItem>
        {menu?.category.kind === 'expense' && (
          <MenuItem onClick={() => { setBudgetFor(menu.category); setMenu(null) }}>{t('budget.set')}</MenuItem>
        )}
        <MenuItem onClick={() => menu && archive(menu.category, !menu.category.archived_at)}>
          {t(menu?.category.archived_at ? 'cat.unarchive' : 'cat.archive')}
        </MenuItem>
        <MenuItem onClick={() => menu && remove(menu.category)} sx={{ color: 'error.main' }}>{t('cat.delete')}</MenuItem>
      </Menu>
      {budgetFor && <BudgetDialog book={book} category={budgetFor} onClose={() => setBudgetFor(null)} />}
      {dialog && all.data && (
        <CategoryDialog key={dialog.category?.id ?? 'new'} book={book} all={all.data} category={dialog.category} parent={dialog.parent}
          editing={dialog.editing} onTransactions={(c) => navigate(`/books/${book.id}/transactions?category_id=${c.id}`)} onClose={() => setDialog(null)} />
      )}
    </Stack>
  )
}
