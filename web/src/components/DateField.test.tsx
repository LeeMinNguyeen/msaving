import { fireEvent, screen } from '@testing-library/react'
import { useSearchParams } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { renderApp } from '../test/render'
import { DateField } from './DateField'

// The value the field shows, from the hidden input MUI X keeps in step with its sections.
const shown = (container: HTMLElement) => (container.querySelector('input') as HTMLInputElement).value

// Types digits the way a keyboard does, one at a time into the focused section
// (day, then month, then year); jsdom doesn't turn key presses into input events.
async function type(digits: string) {
  fireEvent.click(screen.getAllByRole('spinbutton')[0]) // selects the day section, as a tap does
  for (const d of digits) fireEvent.input(document.activeElement!, { target: { textContent: d } })
}

// Like the transaction filters: the date lives in the address, a whole date or nothing.
function Filter() {
  const [params, setParams] = useSearchParams()
  const value = params.get('from') ?? ''
  return (
    <>
      <DateField label="From" value={value} onChange={(v) => setParams(v ? { from: v } : {})} />
      <output>{value || 'none'}</output>
    </>
  )
}

describe('DateField (msaving#27)', () => {
  it('shows a date day first in English, in a US-English browser', async () => {
    expect(navigator.language).toBe('en-US')
    const { container } = await renderApp(<DateField label="Date" value="2026-10-03" onChange={() => {}} />, { lang: 'en' })
    expect(shown(container)).toBe('03-10-2026')
  })

  it('shows a date day first in Vietnamese', async () => {
    const { container } = await renderApp(<DateField label="Ngày" value="2026-10-03" onChange={() => {}} />, { lang: 'vi' })
    expect(shown(container)).toBe('03-10-2026')
  })

  it('is typed day, month, year and hands the parent YYYY-MM-DD', async () => {
    const onChange = vi.fn()
    await renderApp(<DateField label="From" value="" onChange={onChange} />)
    await type('01102026')
    expect(onChange).toHaveBeenLastCalledWith('2026-10-01')
  })

  it('reads a whole date (pasted, or filled in by the browser) day first', async () => {
    const onChange = vi.fn()
    const { container } = await renderApp(<DateField label="From" value="" onChange={onChange} />)
    fireEvent.change(container.querySelector('input')!, { target: { value: '01-10-2026' } })
    expect(onChange).toHaveBeenLastCalledWith('2026-10-01') // 1 October, not 10 January
  })

  it("keeps a half-typed date while a parent that stores '' re-renders it (the filters)", async () => {
    const { container } = await renderApp(<Filter />, { route: '/books/b1/transactions' })
    await type('0110')
    expect(screen.getByRole('status')).toHaveTextContent('none')
    expect(shown(container)).toBe('01-10-YYYY')
    for (const d of '2026') fireEvent.input(document.activeElement!, { target: { textContent: d } })
    expect(screen.getByRole('status')).toHaveTextContent('2026-10-01')
  })

  it('keeps a date being changed while the parent drops to \'\' for the half-typed part', async () => {
    const { container } = await renderApp(<Filter />, { route: '/books/b1/transactions?from=2026-10-01' })
    fireEvent.click(screen.getAllByRole('spinbutton')[0])
    for (const d of '15') fireEvent.input(document.activeElement!, { target: { textContent: d } })  // day 15, now on the month
    expect(screen.getByRole('status')).toHaveTextContent('2026-10-15')
    fireEvent.input(document.activeElement!, { target: { textContent: '' } })                     // clear the month
    expect(screen.getByRole('status')).toHaveTextContent('none')
    expect(shown(container)).toBe('15-MM-2026')                                                    // the rest stays
    for (const d of '11') fireEvent.input(document.activeElement!, { target: { textContent: d } })
    expect(screen.getByRole('status')).toHaveTextContent('2026-11-15')
  })

  it("says when what's typed isn't a whole date yet, so a form can wait for it", async () => {
    const onInvalid = vi.fn()
    await renderApp(<DateField label="As of" value="2026-10-03" onChange={() => {}} onInvalid={onInvalid} />)
    fireEvent.click(screen.getAllByRole('spinbutton')[0])
    fireEvent.input(document.activeElement!, { target: { textContent: '0' } })  // half a day
    expect(onInvalid).toHaveBeenLastCalledWith(true)
    fireEvent.input(document.activeElement!, { target: { textContent: '5' } })
    expect(onInvalid).toHaveBeenLastCalledWith(false)
  })

  it('follows a new value from the parent', async () => {
    const { container, rerender } = await renderApp(<DateField label="Date" value="2026-10-03" onChange={() => {}} />)
    rerender(<DateField label="Date" value="2026-11-05" onChange={() => {}} />)
    expect(shown(container)).toBe('05-11-2026')
    rerender(<DateField label="Date" value="" onChange={() => {}} />)
    expect(shown(container)).toBe('')
  })
})
