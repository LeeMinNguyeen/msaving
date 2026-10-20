import dayjs, { type Dayjs } from 'dayjs'
import { useState } from 'react'

const ISO = 'YYYY-MM-DD'

export const parseIso = (iso: string): Dayjs | null => (iso ? dayjs(iso) : null)
export const isoOf = (d: Dayjs | null): string => (d && d.isValid() ? d.format(ISO) : '')

// The date a date field shows while its parent holds only whole dates or ''
// (the transaction filters keep theirs in the address). A half-typed date
// reaches the parent as '', and in a browser MUI X would wipe what was typed
// when its value becomes empty: so the draft stays here, and only a different
// date from the parent replaces it. Returns the draft and a setter that
// gives back what the parent should get.
export function useDraftDate(value: string): [Dayjs | null, (d: Dayjs | null) => string] {
  const [draft, setDraft] = useState(() => parseIso(value))
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    if (value !== isoOf(draft)) setDraft(parseIso(value))
  }
  const change = (d: Dayjs | null) => {
    setDraft(d)
    return isoOf(d)
  }
  return [draft, change]
}
