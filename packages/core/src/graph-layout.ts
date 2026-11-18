import type { Dependency } from './model.js'

export function graphLayout(ids: string[], dependencies: Dependency[]) {
  const levels = new Map<string, number>()
  const remaining = new Set(ids)
  for (let pass = 0; remaining.size && pass < ids.length; pass++) {
    let changed = false
    for (const id of remaining) {
      const parents = dependencies.filter(edge => edge.after === id).map(edge => edge.before)
      if (parents.some(parent => !levels.has(parent))) continue
      levels.set(id, parents.length ? Math.max(...parents.map(parent => levels.get(parent)!)) + 1 : 0)
      remaining.delete(id); changed = true
    }
    if (!changed) throw new Error('Cannot lay out a cyclic graph or a missing dependency')
  }
  const rows = new Map<number, number>()
  const nodes = ids.map(id => {
    const level = levels.get(id)!
    const row = rows.get(level) ?? 0
    rows.set(level, row + 1)
    return { id, level, x: 20 + level * 270, y: 24 + row * 112 }
  })
  return { nodes, width: Math.max(320, 40 + rows.size * 270), height: Math.max(150, 40 + Math.max(0, ...rows.values()) * 112) }
}
