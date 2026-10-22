import CheckIcon from '@mui/icons-material/Check'
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { BudgetBar } from '../components/BudgetBar'
import { useErrorText } from '../components/errors'
import { currentLanguage } from '../i18n'
import { send, type Book, type Category, type CategoryKind } from '../lib/api'
import { categoryTree } from '../lib/categories'
import { formatMoney } from '../lib/money'
import { useBudgets, useCurrencies } from '../lib/queries'
import { newId } from '../lib/uuid'
import { DialogFooter } from '../components/DialogFooter'
import { useToast } from '../lib/toast'

// The old app's preset grid (CategoryFormScreen).
const COLORS = ['#64748b', '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#10b981', '#06b6d4',
  '#0ea5e9', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e']

type Props = {
  book: Book
  all: Category[]
  category: Category | null
  parent?: Category
  editing?: boolean // open an existing category straight in edit mode (its menu's Edit)
  onTransactions?: (category: Category) => void
  onClose: () => void
}

// Add, show or edit a category. An existing one opens with its fields greyed
// out and its budgets; Edit turns the fields on.
export function CategoryDialog({ book, all, category, parent, editing: startEditing = false, onTransactions, onClose }: Props) {
  const { t } = useTranslation()
  const toast = useToast()
  const errorText = useErrorText()
  const qc = useQueryClient()
  const budgets = useBudgets(book.id)
  const currencies = useCurrencies()
  const id = useRef(category?.id ?? newId())
  const canEdit = book.role !== 'viewer'
  const [editing, setEditing] = useState(!category || (startEditing && canEdit))
  const [name, setName] = useState(category?.name ?? '')
  const [kind, setKind] = useState<CategoryKind>(category?.kind ?? parent?.kind ?? 'expense')
  const [parentId, setParentId] = useState(category?.parent_id ?? parent?.id ?? '')
  const [color, setColor] = useState(category?.color ?? parent?.color ?? '')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const ro = !editing
  const mine = (budgets.data ?? []).filter((b) => b.category_id === category?.id && b.progress)
  const money = (v: number) => formatMoney(v, book.base_currency, currencies.data?.get(book.base_currency)?.minor_unit ?? 0, currentLanguage())

  function cancel() {
    if (category && !startEditing) {
      setName(category.name)
      setKind(category.kind)
      setParentId(category.parent_id ?? '')
      setColor(category.color ?? '')
      setError(null)
      setEditing(false)
    } else onClose()
  }

  // A category can sit under one of the same kind, never under itself or its own children.
  const below = descendants(all, category?.id)
  const parents = categoryTree(all, kind).filter((r) => !r.category.archived_at && !below.has(r.category.id))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (category) {
        await send('PATCH', `/v1/books/${book.id}/categories/${category.id}`, {
          version: category.version,
          name: name.trim(),
          kind: kind === category.kind ? null : kind,
          parent_id: parentId || null,
          top_level: !parentId,
          color,
        })
      } else {
        await send('POST', `/v1/books/${book.id}/categories`, { id: id.current, name: name.trim(), kind, parent_id: parentId || null, color: color || null })
      }
      toast(t('toast.categorySaved'))
      onClose()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
      await qc.invalidateQueries({ queryKey: ['books', book.id, 'categories'] })
    }
  }

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <form onSubmit={submit}>
        <DialogTitle>
          {t(category ? (editing ? 'cat.edit' : 'cat.details') : parent ? 'cat.addSub' : 'cat.add')}
          {category?.archived_at && <Chip size="small" label={t('cat.archived')} sx={{ ml: 1 }} />}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField label={t('cat.name')} required autoFocus={editing} disabled={ro} value={name} onChange={(e) => setName(e.target.value)} />
            <TextField select label={t('cat.kind')} disabled={ro} value={kind} onChange={(e) => { setKind(e.target.value as CategoryKind); setParentId('') }}
              helperText={kind === 'transfer' ? t('cat.transferHint') : undefined}>
              {(['expense', 'income', 'transfer'] as const).map((k) => <MenuItem key={k} value={k}>{t(`cat.kinds.${k}`)}</MenuItem>)}
            </TextField>
            <TextField select label={t('cat.parent')} disabled={ro} value={parentId} onChange={(e) => setParentId(e.target.value)} slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}>
              <MenuItem value="">{t('cat.topLevel')}</MenuItem>
              {parents.map(({ category: c, depth }) => <MenuItem key={c.id} value={c.id} sx={{ pl: 2 + depth * 2 }}>{c.name}</MenuItem>)}
            </TextField>
            <Box>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>{t('cat.color')}</Typography>
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(9, 32px)', gap: 1 }}>
                {/* A colour from outside the grid (the starter categories have some) shows too */}
                {['', ...COLORS, ...(category?.color && !COLORS.includes(category.color) ? [category.color] : [])].map((c) => (
                  <ButtonBase key={c || 'default'} disabled={ro} onClick={() => setColor(c)} aria-label={c || t('cat.defaultColor')} aria-pressed={color === c}
                    sx={{ width: 32, height: 32, borderRadius: '50%', bgcolor: c || 'action.disabledBackground', color: '#fff', border: 2,
                          borderColor: color === c ? 'text.primary' : 'transparent', opacity: ro && color !== c ? 0.35 : 1 }}>
                    {color === c && <CheckIcon fontSize="small" />}
                  </ButtonBase>
                ))}
              </Box>
            </Box>
            {category && mine.length > 0 && (
              <Box>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>{t('cat.budgets')}</Typography>
                <Stack spacing={1}>
                  {mine.map((b) => (
                    <BudgetBar key={b.id} label={t(`budget.periods.${b.period}`)} spent={b.progress!.spent} budget={b.amount}
                      percent={b.progress!.percent_used} format={money} />
                  ))}
                </Stack>
              </Box>
            )}
            {error ? <Alert severity="error">{errorText(error)}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogFooter>
          {category && !editing && onTransactions && (
            <Button startIcon={<ReceiptLongIcon />} onClick={() => onTransactions(category)}>{t('common.viewTransactions')}</Button>
          )}
          <Box sx={{ flex: 1 }} />
          {editing ? (
            <>
              <Button onClick={cancel}>{t('common.cancel')}</Button>
              <Button key="save" type="submit" variant="contained" loading={busy} disabled={!name.trim()}>{t('accounts.save')}</Button>
            </>
          ) : (
            <>
              <Button onClick={onClose}>{t('common.close')}</Button>
              {/* Its own key: reusing the Save button's element would submit the form on this click */}
              {canEdit && <Button key="edit" variant="contained" onClick={() => setEditing(true)}>{t('common.edit')}</Button>}
            </>
          )}
        </DialogFooter>
      </form>
    </Dialog>
  )
}

// The category and everything under it.
function descendants(all: Category[], id: string | undefined): Set<string> {
  const out = new Set<string>(id ? [id] : [])
  for (let grew = !!id; grew; ) {
    grew = false
    for (const c of all) {
      if (c.parent_id && out.has(c.parent_id) && !out.has(c.id)) {
        out.add(c.id)
        grew = true
      }
    }
  }
  return out
}
