import dayjs, { type Dayjs } from 'dayjs'
import { useState } from 'react'

const ISO = 'YYYY-MM-DD'
const HHMM = 'HH:mm'

export const parseIso = (iso: string): Dayjs | null => (iso ? dayjs(iso) : null)
export const isoOf = (d: Dayjs | null): string => (d && d.isValid() ? d.format(ISO) : '')
const parseTime = (hhmm: string): Dayjs | null => (hhmm ? dayjs(`2000-01-01T${hhmm}`) : null)
const timeOf = (d: Dayjs | null): string => (d && d.isValid() ? d.format(HHMM) : '')

// What a date or time field shows while its parent holds only whole values or ''
// (the transaction filters keep theirs in the address). A half-typed one
// reaches the parent as '', and in a browser MUI X would wipe what was typed
// when its value becomes empty: so the draft stays here, and only a different
// value from the parent replaces it. Returns the draft and a setter that
// gives back what the parent should get.
function useDraft(value: string, parse: (v: string) => Dayjs | null, format: (d: Dayjs | null) => string):
  [Dayjs | null, (d: Dayjs | null) => string] {
  const [draft, setDraft] = useState(() => parse(value))
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    if (value !== format(draft)) setDraft(parse(value))
  }
  const change = (d: Dayjs | null) => {
    setDraft(d)
    return format(d)
  }
  return [draft, change]
}

export const useDraftDate = (value: string) => useDraft(value, parseIso, isoOf)
export const useDraftTime = (value: string) => useDraft(value, parseTime, timeOf)
