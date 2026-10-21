import RefreshIcon from '@mui/icons-material/Refresh'
import CircularProgress from '@mui/material/CircularProgress'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useRefreshBook } from '../lib/queries'

// Fetch the book's data again now, without waiting for the automatic refresh.
export function RefreshButton({ bookId }: { bookId: string }) {
  const { t } = useTranslation()
  const refresh = useRefreshBook()
  const [busy, setBusy] = useState(false)
  async function click() {
    setBusy(true)
    try {
      await refresh(bookId)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Tooltip title={t('common.refresh')}>
      <span>
        <IconButton aria-label={t('common.refresh')} onClick={click} disabled={busy}>
          {busy ? <CircularProgress size={20} /> : <RefreshIcon />}
        </IconButton>
      </span>
    </Tooltip>
  )
}
