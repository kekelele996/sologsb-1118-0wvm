import { createStore } from 'zustand/vanilla'
import type { Artifact, BasePoint } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'
import { archiveArtifact, reconcileArtifact, releaseHold } from '@/utils/reconcile'

export interface ArtifactState {
  artifacts: Artifact[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (artifact: Artifact) => Promise<void>
  remove: (id: string) => Promise<void>
  removeByStratum: (stratumId: string) => Promise<void>
  /** 与测绘组基点记录对账：重算并刷新器物状态（只写器物这份） */
  reconcile: (ids: string[], basePoints: BasePoint[]) => Promise<void>
  /** 未归档器物进库：冻结坐标后置为已进库；对不上的仍挂起不进库 */
  archive: (ids: string[], basePoints: BasePoint[]) => Promise<void>
  /** 测绘组确认后解除挂起 */
  releaseHold: (ids: string[]) => Promise<void>
  /** 基点升级后由调用方给出已改好读数的器物，批量落库（仍只写器物表） */
  bulkSave: (artifacts: Artifact[]) => Promise<void>
}

export const artifactStore = createStore<ArtifactState>((set, get) => ({
  artifacts: [],
  loaded: false,
  hydrate: async () => {
    const artifacts = await syncAll<Artifact>(db.artifacts)
    artifacts.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN', { numeric: true }))
    set({ artifacts, loaded: true })
  },
  save: async (artifact) => {
    await syncPut<Artifact>(db.artifacts, artifact)
    await get().hydrate()
  },
  bulkSave: async (artifacts) => {
    await Promise.all(artifacts.map((item) => syncPut<Artifact>(db.artifacts, item)))
    await get().hydrate()
  },
  remove: async (id) => {
    await syncDelete<Artifact>(db.artifacts, id)
    await get().hydrate()
  },
  removeByStratum: async (stratumId) => {
    const targets = get().artifacts.filter((item) => item.stratumId === stratumId)
    await Promise.all(targets.map((item) => syncDelete<Artifact>(db.artifacts, item.id)))
    await get().hydrate()
  },
  reconcile: async (ids, basePoints) => {
    const targets = get().artifacts.filter((item) => ids.includes(item.id))
    await Promise.all(
      targets.map((item) => syncPut<Artifact>(db.artifacts, reconcileArtifact(item, basePoints)))
    )
    await get().hydrate()
  },
  archive: async (ids, basePoints) => {
    const targets = get().artifacts.filter((item) => ids.includes(item.id) && item.status !== 'archived')
    await Promise.all(
      targets.map((item) => syncPut<Artifact>(db.artifacts, archiveArtifact(item, basePoints)))
    )
    await get().hydrate()
  },
  releaseHold: async (ids) => {
    const targets = get().artifacts.filter((item) => ids.includes(item.id) && item.status === 'held')
    await Promise.all(targets.map((item) => syncPut<Artifact>(db.artifacts, releaseHold(item))))
    await get().hydrate()
  }
}))
