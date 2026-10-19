import type { TFunction } from 'i18next'

// The API names purged accounts "Deleted user" (numbered when a book has
// several). That label is translated here; usernames are shown as they are.
export function personName(name: string | null, t: TFunction): string {
  if (!name) return ''
  if (name === 'Deleted user') return t('people.deletedUser')
  const n = /^Deleted user (\d+)$/.exec(name)
  return n ? t('people.deletedUserN', { n: n[1] }) : name
}
