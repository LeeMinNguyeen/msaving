import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import Autocomplete from '@mui/material/Autocomplete'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import TextField from '@mui/material/TextField'
import type { SxProps, Theme } from '@mui/material/styles'
import { useMemo, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Category } from '../lib/api'

type Row = { category: Category; depth: number; path: string }

type Props = {
  label?: string
  ariaLabel?: string
  noneLabel: string // what '' means: no category, or all of them
  options: Row[] // categoryTree() order
  value: string
  onChange: (id: string) => void
  size?: 'small' | 'medium'
  disabled?: boolean
  sx?: SxProps<Theme>
}

// The tree starts folded to the top level (the chosen category's branch open); typing searches every level.
export function CategoryPicker({ label, ariaLabel, noneLabel, options, value, onChange, size, disabled, sx }: Props) {
  const { t } = useTranslation()
  const none: Row = useMemo(() => ({
    category: { id: '', name: noneLabel, parent_id: null, kind: 'expense', color: null, archived_at: null, version: 0 }, depth: 0, path: noneLabel,
  }), [noneLabel])
  const parentOf = useMemo(() => new Map(options.map((r) => [r.category.id, r.category.parent_id])), [options])
  const parents = useMemo(() => new Set(options.map((r) => r.category.parent_id).filter((p): p is string => !!p && parentOf.has(p))), [options, parentOf])
  const ancestors = (id: string) => {
    const out: string[] = []
    for (let p = parentOf.get(id); p && parentOf.has(p); p = parentOf.get(p)) out.push(p)
    return out
  }
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(ancestors(value)))
  const selected = options.find((r) => r.category.id === value) ?? none
  const [input, setInput] = useState(selected.path)
  const [highlighted, setHighlighted] = useState<Row | null>(null)
  const searching = input !== '' && input !== selected.path
  const shown = (r: Row) => ancestors(r.category.id).every((p) => expanded.has(p))
  const toggle = (id: string, open?: boolean) => setExpanded((e) => {
    const next = new Set(e)
    if (open ?? !next.has(id)) next.add(id)
    else next.delete(id)
    return next
  })

  function onKeyDown(e: KeyboardEvent) {
    const id = highlighted?.category.id
    if (searching || !id || !parents.has(id) || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return
    e.preventDefault()
    toggle(id, e.key === 'ArrowRight')
  }

  return (
    <Autocomplete
      options={[none, ...options]}
      value={selected}
      inputValue={input}
      onInputChange={(_, v) => setInput(v)}
      onChange={(_, r) => onChange(r?.category.id ?? '')}
      onHighlightChange={(_, r) => setHighlighted(r)}
      getOptionLabel={(r) => r.path}
      isOptionEqualToValue={(a, b) => a.category.id === b.category.id}
      filterOptions={(rows) => searching
        ? rows.filter((r) => r.category.id && r.path.toLocaleLowerCase().includes(input.toLocaleLowerCase()))
        : rows.filter((r) => !r.category.id || shown(r))}
      disabled={disabled}
      size={size}
      sx={sx}
      renderOption={({ key: _key, ...props }, r) => (
        <li key={r.category.id || 'none'} {...props}>
          <Box sx={{ display: 'flex', alignItems: 'center', pl: searching ? 0 : r.depth * 2.5, width: '100%', minWidth: 0 }}>
            <Box sx={{ width: 30, flexShrink: 0 }}>
              {!searching && parents.has(r.category.id) && (
                <IconButton size="small" aria-label={t(expanded.has(r.category.id) ? 'cat.hideSubs' : 'cat.showSubs', { name: r.category.name })}
                  onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); toggle(r.category.id) }}>
                  {expanded.has(r.category.id) ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
                </IconButton>
              )}
            </Box>
            {r.category.id && (
              <Box component="span" sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: r.category.color ?? 'action.disabled', mr: 1, flexShrink: 0 }} />
            )}
            <Box component="span" data-name sx={{ fontStyle: r.category.id ? undefined : 'italic' }}>{searching ? r.path : r.category.name}</Box>
          </Box>
        </li>
      )}
      renderInput={(params) => (
        <TextField {...params} label={label} slotProps={{
          ...params.slotProps,
          htmlInput: { ...params.slotProps.htmlInput, onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
            onKeyDown(e)
            params.slotProps.htmlInput.onKeyDown?.(e)
          }, ...(ariaLabel ? { 'aria-label': ariaLabel } : {}) },
        }} />
      )}
    />
  )
}
