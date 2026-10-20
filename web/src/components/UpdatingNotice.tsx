import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import { updateFinished, updating, useUpdating, type UpdateInfo } from '../lib/updating'

// While the server updates itself (started on Server admin), on top of every
// page: reload in a few minutes, not an error. It keeps asking the server
// how the update went, and says when it's done.
export function UpdatingNotice() {
  const { t } = useTranslation()
  const update = useUpdating()
  const running = update?.phase === 'running'
  const info = useQuery({
    queryKey: ['admin', 'update'],
    queryFn: () => api<UpdateInfo>('/v1/admin/update'),
    enabled: running,
    refetchInterval: running ? 5000 : false,
    retry: true,                // the server is away for a while
  })
  const status = info.data?.status
  useEffect(() => {
    if (update?.phase === 'running' && status && updateFinished(status, update.since)) updating.finish(status)
  }, [status, update])

  if (!update) return null
  const reload = (
    <Button color="inherit" size="small" onClick={() => window.location.reload()}>{t('admin.reload')}</Button>
  )
  if (update.phase === 'failed') {
    return <Alert severity="error" sx={{ mb: 2 }}>{t('admin.updateFailed', { detail: update.detail })}</Alert>
  }
  if (update.phase === 'done') {
    return <Alert severity="success" action={reload} sx={{ mb: 2 }}>{t('admin.updatedReload', { version: update.version })}</Alert>
  }
  return <Alert severity="info" action={reload} sx={{ mb: 2 }}>{t('admin.updatingReload', { version: update.version })}</Alert>
}
