import { createStore } from 'zustand/vanilla'
import type { BasePoint } from '@/types/basepoint'
import { isBasePointComplete } from '@/types'
import { db, syncAll, syncPut } from '@/hooks/usePersistentStore'

export interface NewBasePointInput {
  north: number | null
  east: number | null
  elevation?: number | null
  note: string
  recorder: string
  effectiveDate: string
}

export interface BasePointState {
  basePoints: BasePoint[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** 测绘组改基点：同一探方只追加新版本，旧版本保留作对账依据；返回新旧版本 */
  addVersion: (trenchId: string, input: NewBasePointInput) => Promise<{ added: BasePoint; previous: BasePoint | null }>
  /** 旧数据补录：仅当该版本坐标尚未补齐时允许填写；已完整的基点要改只能追加新版本 */
  backfill: (id: string, patch: Pick<NewBasePointInput, 'north' | 'east' | 'note'>) => Promise<BasePoint>
  listByTrench: (trenchId: string) => BasePoint[]
  activeOf: (trenchId: string) => BasePoint | null
}

function sortByVersion(list: BasePoint[]): BasePoint[] {
  return [...list].sort((a, b) => b.version - a.version)
}

export const basePointStore = createStore<BasePointState>((set, get) => ({
  basePoints: [],
  loaded: false,
  hydrate: async () => {
    const basePoints = await syncAll<BasePoint>(db.basePoints)
    set({ basePoints: sortByVersion(basePoints), loaded: true })
  },
  addVersion: async (trenchId, input) => {
    const existing = get().basePoints.filter((item) => item.trenchId === trenchId)
    const previous = existing.find((item) => item.active) ?? existing[0] ?? null
    const added: BasePoint = {
      id: `bp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      trenchId,
      version: existing.reduce((max, item) => Math.max(max, item.version), 0) + 1,
      north: input.north,
      east: input.east,
      elevation: input.elevation ?? null,
      note: input.note.trim(),
      recorder: input.recorder.trim(),
      effectiveDate: input.effectiveDate,
      active: true
    }
    // 新版本生效，同探方旧版本转为历史（保留记录，不删除）
    await Promise.all([
      ...existing.filter((item) => item.active).map((item) => syncPut(db.basePoints, { ...item, active: false })),
      syncPut(db.basePoints, added)
    ])
    await get().hydrate()
    return { added, previous }
  },
  backfill: async (id, patch) => {
    const target = get().basePoints.find((item) => item.id === id)
    if (!target) throw new Error('基点版本不存在')
    if (isBasePointComplete(target)) {
      throw new Error('该基点版本坐标已完整，修正基点请追加新版本，不得覆盖测绘记录')
    }
    const updated: BasePoint = {
      ...target,
      north: patch.north,
      east: patch.east,
      note: patch.note?.trim() || target.note
    }
    await syncPut(db.basePoints, updated)
    await get().hydrate()
    return updated
  },
  listByTrench: (trenchId) =>
    sortByVersion(get().basePoints.filter((item) => item.trenchId === trenchId)),
  activeOf: (trenchId) => get().basePoints.find((item) => item.trenchId === trenchId && item.active) ?? null
}))
