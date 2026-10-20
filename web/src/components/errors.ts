import { useTranslation } from 'react-i18next'
import { ApiError } from '../lib/api'

// Any error (from the API, or thrown) -> a message in the
// user's language. Unknown codes get the generic message.
function errorCode(err: unknown): string {
  if (err instanceof ApiError) return err.code
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') return err.code
  return 'unexpected_error'
}

export function useErrorText() {
  const { t } = useTranslation()
  return (err: unknown) => (err ? t(`errors.${errorCode(err)}`, { defaultValue: t('errors.unexpected_error') }) : '')
}
