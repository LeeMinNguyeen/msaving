import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Category } from '../lib/api'
import { categoryTree } from '../lib/categories'
import { renderApp } from '../test/render'
import { CategoryPicker } from './CategoryPicker'

const cat = (id: string, name: string, parent_id: string | null = null): Category =>
  ({ id, name, parent_id, kind: 'expense', color: null, archived_at: null, version: 1 })
const all = [
  cat('ca-nhan', 'Cá nhân'), cat('an-ngoai', 'Ăn ngoài', 'ca-nhan'),
  cat('thiet-yeu', 'Thiết yếu'), cat('di-chuyen', 'Di chuyển', 'thiet-yeu'), cat('gui-xe', 'Gửi xe', 'di-chuyen'),
  cat('xang', 'Xăng', 'di-chuyen'), cat('internet', 'Internet', 'thiet-yeu'),
]

function Picker({ start = '', onChange }: { start?: string; onChange: (id: string) => void }) {
  const [value, setValue] = useState(start)
  return <CategoryPicker label="Category" noneLabel="No category" options={categoryTree(all)} value={value}
    onChange={(id) => { setValue(id); onChange(id) }} />
}
const open = async () => {
  await userEvent.click(screen.getByRole('combobox', { name: 'Category' }))
  return within(await screen.findByRole('listbox'))
}
const shown = (list: ReturnType<typeof within>) => list.getAllByRole('option').map((o: HTMLElement) => o.querySelector('[data-name]')?.textContent)

describe('CategoryPicker (msaving#67)', () => {
  it('shows the top level first and opens a branch without closing', async () => {
    const onChange = vi.fn()
    await renderApp(<Picker onChange={onChange} />)
    let list = await open()
    expect(shown(list)).toEqual(['No category', 'Cá nhân', 'Thiết yếu'])
    await userEvent.click(list.getByRole('button', { name: 'Show the sub-categories of Thiết yếu' }))
    list = within(screen.getByRole('listbox'))
    expect(shown(list)).toEqual(['No category', 'Cá nhân', 'Thiết yếu', 'Di chuyển', 'Internet'])
    await userEvent.click(list.getByRole('button', { name: 'Show the sub-categories of Di chuyển' }))
    await userEvent.click(within(screen.getByRole('listbox')).getByText('Gửi xe'))
    expect(onChange).toHaveBeenLastCalledWith('gui-xe')
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('Thiết yếu › Di chuyển › Gửi xe')
  })

  it('finds a category at any depth by typing', async () => {
    const onChange = vi.fn()
    await renderApp(<Picker onChange={onChange} />)
    await userEvent.type(screen.getByRole('combobox', { name: 'Category' }), 'xăng')
    const list = within(await screen.findByRole('listbox'))
    expect(shown(list)).toEqual(['Thiết yếu › Di chuyển › Xăng'])
    await userEvent.click(list.getByText('Thiết yếu › Di chuyển › Xăng'))
    expect(onChange).toHaveBeenLastCalledWith('xang')
  })

  it("opens with the chosen category's branch expanded", async () => {
    await renderApp(<Picker start="gui-xe" onChange={() => {}} />)
    const list = await open()
    expect(shown(list)).toEqual(['No category', 'Cá nhân', 'Thiết yếu', 'Di chuyển', 'Gửi xe', 'Xăng', 'Internet'])
  })

  it('clears with the none option', async () => {
    const onChange = vi.fn()
    await renderApp(<Picker start="xang" onChange={onChange} />)
    const list = await open()
    await userEvent.click(list.getByText('No category'))
    expect(onChange).toHaveBeenLastCalledWith('')
  })
})
