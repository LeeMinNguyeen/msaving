import type { Category, CategoryKind } from './api'

// Categories in tree order with their depth, for pickers and the Categories
// screen: each parent followed by its children, names sorted.
export function categoryTree(list: Category[], kind?: CategoryKind): { category: Category; depth: number; path: string }[] {
  const byParent = new Map<string | null, Category[]>()
  const ids = new Set(list.map((c) => c.id))
  for (const c of list) {
    const parent = c.parent_id && ids.has(c.parent_id) ? c.parent_id : null // parent archived/hidden: show at top
    byParent.set(parent, [...(byParent.get(parent) ?? []), c])
  }
  const out: { category: Category; depth: number; path: string }[] = []
  const walk = (parent: string | null, depth: number, prefix: string) => {
    for (const c of (byParent.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      if (kind && c.kind !== kind) continue
      const path = prefix ? `${prefix} › ${c.name}` : c.name
      out.push({ category: c, depth, path })
      walk(c.id, depth + 1, path)
    }
  }
  walk(null, 0, '')
  return out
}
