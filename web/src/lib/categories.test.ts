import { describe, expect, it } from 'vitest'
import type { Category } from './api'
import { categoryTree } from './categories'

const cat = (id: string, name: string, parent: string | null = null, kind: Category['kind'] = 'expense'): Category => ({
  id, name, parent_id: parent, kind, color: null, archived_at: null, version: 1,
})

describe('categoryTree', () => {
  const list = [cat('b', 'Wants'), cat('a', 'Needs'), cat('a2', 'Rent', 'a'), cat('a1', 'Food', 'a'), cat('i', 'Salary', null, 'income'), cat('x', 'Orphan', 'gone')]

  it('puts children under their parent, names sorted', () => {
    expect(categoryTree(list).map((r) => [r.path, r.depth])).toEqual([
      ['Needs', 0], ['Needs › Food', 1], ['Needs › Rent', 1], ['Orphan', 0], ['Salary', 0], ['Wants', 0],
    ])
  })

  it('filters by kind', () => {
    expect(categoryTree(list, 'income').map((r) => r.path)).toEqual(['Salary'])
  })
})
