import CheckIcon from '@mui/icons-material/Check'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useErrorText } from '../components/errors'
import { send, type Book, type Category, type CategoryKind } from '../lib/api'
import { categoryTree } from '../lib/categories'
import { newId } from '../lib/uuid'

// The old app's preset grid (CategoryFormScreen).
const COLORS = ['#64748b', '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#10b981', '#06b6d4',
  '#0ea5e9', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e']

type Props = { book: Book; all: Category[]; category: Category | null; parent?: Category; onClose: () => void }

export function CategoryDialog({ book, all, category, parent, onClose }: Props) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const qc = useQueryClient()
  const id = useRef(category?.id ?? newId())
  const [name, setName] = useState(category?.name ?? '')
  const [kind, setKind] = useState<CategoryKind>(category?.kind ?? parent?.kind ?? 'expense')
  const [parentId, setParentId] = useState(category?.parent_id ?? parent?.id ?? '')
  const [color, setColor] = useState(category?.color ?? parent?.color ?? '')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

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
        <DialogTitle>{t(category ? 'cat.edit' : parent ? 'cat.addSub' : 'cat.add')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField label={t('cat.name')} required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            <TextField select label={t('cat.kind')} value={kind} onChange={(e) => { setKind(e.target.value as CategoryKind); setParentId('') }}
              helperText={kind === 'transfer' ? t('cat.transferHint') : undefined}>
              {(['expense', 'income', 'transfer'] as const).map((k) => <MenuItem key={k} value={k}>{t(`cat.kinds.${k}`)}</MenuItem>)}
            </TextField>
            <TextField select label={t('cat.parent')} value={parentId} onChange={(e) => setParentId(e.target.value)} slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}>
              <MenuItem value="">{t('cat.topLevel')}</MenuItem>
              {parents.map(({ category: c, depth }) => <MenuItem key={c.id} value={c.id} sx={{ pl: 2 + depth * 2 }}>{c.name}</MenuItem>)}
            </TextField>
            <Box>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>{t('cat.color')}</Typography>
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(9, 32px)', gap: 1 }}>
                {['', ...COLORS].map((c) => (
                  <ButtonBase key={c || 'default'} onClick={() => setColor(c)} aria-label={c || t('cat.defaultColor')} aria-pressed={color === c}
                    sx={{ width: 32, height: 32, borderRadius: '50%', bgcolor: c || 'action.disabledBackground', color: '#fff', border: 2,
                          borderColor: color === c ? 'text.primary' : 'transparent' }}>
                    {color === c && <CheckIcon fontSize="small" />}
                  </ButtonBase>
                ))}
              </Box>
            </Box>
            {error ? <Alert severity="error">{errorText(error)}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="contained" loading={busy} disabled={!name.trim()}>{t('accounts.save')}</Button>
        </DialogActions>
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
