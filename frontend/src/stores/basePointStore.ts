import { createStore } from 'zustand/vanilla'
import type { BasePointVersion } from '@/types'
import { db, syncAll, syncPut } from '@/hooks/usePersistentStore'

export interface BasePointState {
  versions: BasePointVersion[]
  loaded: boolean
  hydrate: () => Promise<void>
  /**
   * 测绘组改基点：原当前版本归档，写入新的当前版本。
   * 只动测绘组那份台账，不直接改器物坐标。
   */
  changeBase: (
    trenchId: string,
    next: Pick<BasePointVersion, 'northing' | 'easting' | 'elevation' | 'effectiveDate' | 'surveyor' | 'note'>,
    genId: () => string
  ) => Promise<BasePointVersion>
  /** 测绘组事后校正历史版本记录（坐标勘误），留痕说明 */
  correctBase: (
    id: string,
    patch: Partial<Pick<BasePointVersion, 'northing' | 'easting' | 'elevation' | 'note'>>
  ) => Promise<void>
}

export const basePointStore = createStore<BasePointState>((set, get) => ({
  versions: [],
  loaded: false,
  hydrate: async () => {
    const versions = await syncAll<BasePointVersion>(db.basePoints)
    versions.sort((a, b) => `${a.trenchId}:${a.version}`.localeCompare(`${b.trenchId}:${b.version}`))
    set({ versions, loaded: true })
  },
  changeBase: async (trenchId, next, genId) => {
    const existing = get().versions.filter((item) => item.trenchId === trenchId)
    const current = existing.find((item) => item.current)
    const nextVersion = (current?.version ?? existing.reduce((max, item) => Math.max(max, item.version), 0)) + 1
    if (current) {
      await syncPut<BasePointVersion>(db.basePoints, { ...current, current: false })
    }
    const created: BasePointVersion = {
      id: genId(),
      trenchId,
      version: nextVersion,
      northing: next.northing,
      easting: next.easting,
      elevation: next.elevation,
      effectiveDate: next.effectiveDate,
      surveyor: next.surveyor,
      note: next.note,
      current: true
    }
    await syncPut<BasePointVersion>(db.basePoints, created)
    await get().hydrate()
    return created
  },
  correctBase: async (id, patch) => {
    const target = get().versions.find((item) => item.id === id)
    if (!target) return
    await syncPut<BasePointVersion>(db.basePoints, { ...target, ...patch })
    await get().hydrate()
  }
}))
