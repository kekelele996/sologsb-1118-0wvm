import type { Artifact, RecalcIssue } from '@/types/artifact'
import type { BasePoint } from '@/types/basepoint'
import { isBasePointComplete, isCoordinateMatch, rebaseReading, toGlobalCoordinate } from '@/types'

export interface RecalcResult {
  /** 依据基点版本重算得到的全局坐标；基点缺失/不完整时为 null */
  global: { north: number; east: number } | null
  issue: RecalcIssue | null
}

/**
 * 整理室按测绘组基点记录重算一件器物的全局坐标。
 * 只读取测绘组那份基点台账；任何失败都只在器物这份上标记，绝不回写基点。
 */
export function recalcArtifact(artifact: Artifact, basePoints: BasePoint[]): RecalcResult {
  const base = artifact.basePointId ? basePoints.find((item) => item.id === artifact.basePointId) ?? null : null
  if (!base) {
    return { global: null, issue: 'missing-basepoint' }
  }
  if (!isBasePointComplete(base)) {
    return { global: null, issue: 'incomplete-basepoint' }
  }
  const baseCoord = { north: base.north as number, east: base.east as number }
  return { global: toGlobalCoordinate({ x: artifact.x, y: artifact.y }, baseCoord), issue: null }
}

export const RECALC_ISSUE_LABEL: Record<RecalcIssue, string> = {
  'missing-basepoint': '量算依据的基点版本在测绘组台账中不存在',
  'incomplete-basepoint': '基点版本坐标尚未补齐，无法换算',
  mismatch: '重算坐标与进库冻结坐标对不上'
}

/**
 * 与测绘组基点记录对账一件器物，返回新的器物状态（不就地修改）。
 * 规则：
 * - archived 已进库：冻结坐标不变；重算对不上则挂起等测绘组确认，仍保留原冻结值。
 * - recorded 未归档：基点变动后按新基点重算；基点缺失/不完整则挂起，不进库。
 * - held 挂起：维持挂起，刷新问题说明，直到测绘组确认后人工处理。
 */
export function reconcileArtifact(artifact: Artifact, basePoints: BasePoint[]): Artifact {
  const { global, issue } = recalcArtifact(artifact, basePoints)

  if (artifact.status === 'archived') {
    if (issue) {
      return { ...artifact, status: 'held', recalcIssue: issue, holdNote: RECALC_ISSUE_LABEL[issue] }
    }
    const frozen = { north: artifact.frozenNorth as number, east: artifact.frozenEast as number }
    if (!isCoordinateMatch(frozen, global!)) {
      return { ...artifact, status: 'held', recalcIssue: 'mismatch', holdNote: RECALC_ISSUE_LABEL.mismatch }
    }
    return { ...artifact, recalcIssue: null }
  }

  if (artifact.status === 'recorded') {
    if (issue) {
      return { ...artifact, status: 'held', recalcIssue: issue, holdNote: RECALC_ISSUE_LABEL[issue] }
    }
    return { ...artifact, recalcIssue: null }
  }

  // held：重新核算，问题消失则留在挂起态等测绘组确认解除，但更新说明
  if (!issue && artifact.recalcIssue === 'mismatch') {
    const frozen = artifact.frozenNorth !== null && artifact.frozenEast !== null
      ? { north: artifact.frozenNorth, east: artifact.frozenEast }
      : null
    if (!frozen || isCoordinateMatch(frozen, global!)) {
      return { ...artifact, recalcIssue: null, holdNote: '重算已与基点记录一致，待测绘组确认解除挂起' }
    }
  }
  if (issue) {
    return { ...artifact, recalcIssue: issue, holdNote: RECALC_ISSUE_LABEL[issue] }
  }
  return artifact
}

/** 未归档器物进库：按当前基点重算，冻结坐标后置为 archived；基点不可算则保持挂起不进库 */
export function archiveArtifact(artifact: Artifact, basePoints: BasePoint[]): Artifact {
  if (artifact.status === 'archived') return artifact
  const { global, issue } = recalcArtifact(artifact, basePoints)
  if (!global || issue) {
    return {
      ...artifact,
      status: 'held',
      recalcIssue: issue,
      holdNote: issue ? RECALC_ISSUE_LABEL[issue] : '坐标无法换算，暂不进库'
    }
  }
  return {
    ...artifact,
    status: 'archived',
    frozenNorth: global.north,
    frozenEast: global.east,
    recalcIssue: null,
    holdNote: ''
  }
}

/** 测绘组确认后解除挂起：回到未归档，重新走对账/进库流程 */
export function releaseHold(artifact: Artifact): Artifact {
  if (artifact.status !== 'held') return artifact
  return { ...artifact, status: 'recorded', recalcIssue: null, holdNote: '' }
}

/**
 * 测绘组改基点后，把一件未归档器物的平面读数换算到新基点。
 * referenced 为该器物读数实际依据的基点版本；已进库器物坐标冻结，原样返回。
 * 旧基点不完整时无法还原其原始全局坐标，保持挂在旧版本上挂起，绝不拿旧读数硬套新基点。
 */
export function rebaseArtifact(artifact: Artifact, referenced: BasePoint, next: BasePoint): Artifact {
  if (artifact.status === 'archived') return artifact
  if (!isBasePointComplete(referenced)) {
    return {
      ...artifact,
      status: 'held',
      basePointId: referenced.id,
      recalcIssue: 'incomplete-basepoint',
      holdNote: '旧基点坐标未补齐，无法换算到新基点；请测绘组先按当时记录补录旧版本基点'
    }
  }
  if (!isBasePointComplete(next)) {
    return {
      ...artifact,
      status: 'held',
      basePointId: next.id,
      recalcIssue: 'incomplete-basepoint',
      holdNote: '新基点坐标未补齐，平面读数暂无法按新基点重算'
    }
  }
  const reading = rebaseReading(
    { x: artifact.x, y: artifact.y },
    { north: referenced.north as number, east: referenced.east as number },
    { north: next.north as number, east: next.east as number }
  )
  return {
    ...artifact,
    ...reading,
    basePointId: next.id,
    status: artifact.status === 'held' ? artifact.status : 'recorded',
    recalcIssue: artifact.status === 'held' ? artifact.recalcIssue : null
  }
}

