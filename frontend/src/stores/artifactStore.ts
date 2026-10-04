import { createStore } from 'zustand/vanilla'
import type { Artifact, BasePointVersion, SuspendResolution } from '@/types'
import { absoluteCoord, basePointByVersion, isCoordMatch, recomputeReading } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'

/** 重算结果 */
export interface RecomputeResult {
  /** 本次成功重算件数 */
  recomputed: number
  /** 本次失败件数 */
  failed: number
}

export interface ArtifactState {
  artifacts: Artifact[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (artifact: Artifact) => Promise<void>
  remove: (id: string) => Promise<void>
  removeByStratum: (stratumId: string) => Promise<void>
  /**
   * 测绘组改基点后：对探方内所有「没进库」的器物读数按新基点重算。
   * 已进库（stocked）坐标冻结，不参与重算，只做事后对账。
   * 失败只落在器物记录上，不改测绘基点台账（各持一份）。
   */
  recomputeTrench: (
    trenchId: string,
    stratumTrenchIds: Record<string, string>,
    baseVersions: BasePointVersion[]
  ) => Promise<RecomputeResult>
  /** 重算失败后只重试自己那份：仅对 failed 器物再跑一遍 */
  retryFailed: (
    trenchId: string,
    stratumTrenchIds: Record<string, string>,
    baseVersions: BasePointVersion[]
  ) => Promise<RecomputeResult>
}

function nowIso(): string {
  return new Date().toISOString()
}

function trenchIdOf(artifact: Artifact, stratumTrenchIds: Record<string, string>): string {
  return stratumTrenchIds[artifact.stratumId] ?? ''
}

async function runRecompute(
  targets: Artifact[],
  baseVersions: BasePointVersion[],
  stratumTrenchIds: Record<string, string>
): Promise<RecomputeResult> {
  let recomputed = 0
  let failed = 0
  for (const artifact of targets) {
    const trenchId = trenchIdOf(artifact, stratumTrenchIds)
    const oldBase = basePointByVersion(baseVersions, trenchId, artifact.baseVersion)
    const newBase = baseVersions.find((item) => item.trenchId === trenchId && item.current)
    if (!oldBase || !newBase) {
      // 换算基准缺失：只标记整理室这份失败，基点补齐后重试
      failed += 1
      await syncPut<Artifact>(db.artifacts, {
        ...artifact,
        status: 'failed',
        holdReason: !oldBase
          ? `重算失败：找不到读数所依据的基点 v${artifact.baseVersion}，请测绘组补台账后重试`
          : '重算失败：探方暂无当前生效基点，请测绘组确认后重试',
        lastRecomputeAt: nowIso()
      })
      continue
    }
    const next = recomputeReading({ x: artifact.x, y: artifact.y, z: artifact.z }, oldBase, newBase)
    recomputed += 1
    await syncPut<Artifact>(db.artifacts, {
      ...artifact,
      x: next.x,
      y: next.y,
      z: next.z,
      baseVersion: newBase.version,
      status: 'pending',
      holdReason: '',
      lastRecomputeAt: nowIso()
    })
  }
  return { recomputed, failed }
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
  remove: async (id) => {
    await syncDelete<Artifact>(db.artifacts, id)
    await get().hydrate()
  },
  removeByStratum: async (stratumId) => {
    const targets = get().artifacts.filter((item) => item.stratumId === stratumId)
    await Promise.all(targets.map((item) => syncDelete<Artifact>(db.artifacts, item.id)))
    await get().hydrate()
  },
  recomputeTrench: async (trenchId, stratumTrenchIds, baseVersions) => {
    const targets = get().artifacts.filter(
      (item) => trenchIdOf(item, stratumTrenchIds) === trenchId && item.status !== 'stocked'
    )
    const result = await runRecompute(targets, baseVersions, stratumTrenchIds)
    await get().hydrate()
    return result
  },
  retryFailed: async (trenchId, stratumTrenchIds, baseVersions) => {
    const targets = get().artifacts.filter(
      (item) => trenchIdOf(item, stratumTrenchIds) === trenchId && item.status === 'failed'
    )
    const result = await runRecompute(targets, baseVersions, stratumTrenchIds)
    await get().hydrate()
    return result
  }
}))

/** 由地层单位列表构造 单位 id -> 探方 id 映射 */
export function buildStratumTrenchMap(strata: { id: string; trenchId: string }[]): Record<string, string> {
  return Object.fromEntries(strata.map((item) => [item.id, item.trenchId]))
}

/** 对单件已进库器物按测绘基点记录对账：吻合返回 null，否则返回期望/冻结两份绝对坐标 */
export function reconcileArtifact(
  artifact: Artifact,
  trenchId: string,
  baseVersions: BasePointVersion[]
): { expected: { north: number; east: number; elev: number }; frozen: { north: number; east: number; elev: number } } | null {
  if (
    artifact.frozenNorth === null ||
    artifact.frozenEast === null ||
    artifact.frozenElev === null ||
    artifact.frozenVersion === null
  ) {
    return null
  }
  const frozenBase = basePointByVersion(baseVersions, trenchId, artifact.frozenVersion)
  if (!frozenBase) return null
  const expected = absoluteCoord(frozenBase, { x: artifact.x, y: artifact.y, z: artifact.z })
  const frozen = { north: artifact.frozenNorth, east: artifact.frozenEast, elev: artifact.frozenElev }
  return isCoordMatch(expected, frozen) ? null : { expected, frozen }
}

/**
 * 进库：以读数所在基点版本换算绝对坐标并冻结。
 * 已进库器物坐标不再随基点变化；外部应先调用对账，对不上则走挂起。
 */
export async function stockArtifact(
  artifact: Artifact,
  trenchId: string,
  baseVersions: BasePointVersion[]
): Promise<{ ok: boolean; reason?: string }> {
  if (artifact.status === 'stocked') return { ok: false, reason: '器物已进库，坐标已冻结' }
  const base = basePointByVersion(baseVersions, trenchId, artifact.baseVersion)
  if (!base) {
    return { ok: false, reason: `读数依据的基点 v${artifact.baseVersion} 在测绘台账中不存在` }
  }
  const coord = absoluteCoord(base, { x: artifact.x, y: artifact.y, z: artifact.z })
  await syncPut<Artifact>(db.artifacts, {
    ...artifact,
    status: 'stocked',
    frozenNorth: coord.north,
    frozenEast: coord.east,
    frozenElev: coord.elev,
    frozenVersion: base.version,
    stockedDate: new Date().toISOString().slice(0, 10),
    holdReason: ''
  })
  return { ok: true }
}

/** 对账不一致 → 挂起等测绘组确认，先不进库 */
export async function suspendArtifact(artifact: Artifact, reason: string): Promise<void> {
  await syncPut<Artifact>(db.artifacts, {
    ...artifact,
    status: 'suspended',
    holdReason: reason
  })
}

/**
 * 挂起器物经测绘组确认后的处理：
 * - 确认进库：以当前测绘基点记录为准冻结坐标
 * - 退回重测：回到未归档，整理室按确认结果重新量取登记
 */
export async function resolveSuspendedArtifact(
  artifact: Artifact,
  trenchId: string,
  resolution: SuspendResolution,
  comment: string,
  baseVersions: BasePointVersion[]
): Promise<{ ok: boolean; reason?: string }> {
  if (resolution === '确认进库') {
    const base = baseVersions.find((item) => item.trenchId === trenchId && item.current)
    if (!base) return { ok: false, reason: '探方当前无生效基点版本' }
    const coord = absoluteCoord(base, { x: artifact.x, y: artifact.y, z: artifact.z })
    await syncPut<Artifact>(db.artifacts, {
      ...artifact,
      baseVersion: base.version,
      status: 'stocked',
      frozenNorth: coord.north,
      frozenEast: coord.east,
      frozenElev: coord.elev,
      frozenVersion: base.version,
      stockedDate: new Date().toISOString().slice(0, 10),
      holdReason: `测绘组确认进库：${comment || '差异以测绘基点记录为准'}`
    })
    return { ok: true }
  }
  await syncPut<Artifact>(db.artifacts, {
    ...artifact,
    status: 'pending',
    holdReason: `测绘组退回重测：${comment || '按确认结果重新量取'}`
  })
  return { ok: true }
}
