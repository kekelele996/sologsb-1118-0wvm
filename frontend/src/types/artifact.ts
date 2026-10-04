/** 器物类别 */
export const ARTIFACT_CATEGORIES = ['陶器', '瓷器', '石器', '骨器', '铜器'] as const
export type ArtifactCategory = (typeof ARTIFACT_CATEGORIES)[number]

/** 残整程度 */
export const COMPLETENESS = ['完整', '可复原', '残片'] as const
export type Completeness = (typeof COMPLETENESS)[number]

/**
 * 对账状态（整理室持有）
 * - recorded  未归档：仅按某基点版本量算了平面读数，尚未与测绘组基点记录对账
 * - archived  已进库：坐标已对账并冻结，基点再改也不重算
 * - held      挂起：与测绘组基点记录对不上，等测绘组确认，先不进库
 */
export const ARTIFACT_STATUSES = ['recorded', 'archived', 'held'] as const
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number]

export const ARTIFACT_STATUS_LABEL: Record<ArtifactStatus, string> = {
  recorded: '未归档',
  archived: '已进库',
  held: '挂起待确认'
}

/** 重算失败时，整理室只重试自己那份（器物平面读数），不动测绘组基点台账 */
export type RecalcIssue =
  | 'missing-basepoint' // 量算时依据的基点版本已不存在
  | 'incomplete-basepoint' // 基点版本坐标未补齐（旧数据未升级）
  | 'mismatch' // 重算结果与已冻结的进库坐标对不上

/** Artifact 出土物（整理室台账：器物编号、平面读数、存放位置） */
export interface Artifact {
  id: string
  /** 所属地层单位（登记时锁定） */
  stratumId: string
  /** 器物编号 */
  code: string
  category: ArtifactCategory
  /** 件数 */
  count: number
  completeness: Completeness
  /** 探方内坐标 X（米）——整理室按基点量取的平面读数 */
  x: number
  /** 探方内坐标 Y（米）——整理室按基点量取的平面读数 */
  y: number
  /** 探方内坐标 Z（距地表深度，米） */
  z: number
  date: string
  /** 提取人 */
  collector: string
  /** 临时存放位置 */
  tempLocation: string

  /** 量算该平面读数时依据的基点版本（测绘组台账 BasePoint.id） */
  basePointId: string | null
  /** 对账状态 */
  status: ArtifactStatus
  /** 进库时冻结的全局北坐标（基点 N + 读数 Y），进库后基点改动不影响此值 */
  frozenNorth: number | null
  /** 进库时冻结的全局东坐标（基点 E + 读数 X） */
  frozenEast: number | null
  /** 最近一次对账/重算的问题说明；无问题为 null */
  recalcIssue: RecalcIssue | null
  /** 挂起原因（对不上时记录，供测绘组确认） */
  holdNote: string
}

/** 由基点全局坐标与探方内平面读数换算全局坐标（X 对应东向、Y 对应北向） */
export function toGlobalCoordinate(
  reading: { x: number; y: number },
  base: { north: number; east: number }
): { north: number; east: number } {
  return {
    north: round3(base.north + reading.y),
    east: round3(base.east + reading.x)
  }
}

/** 全局坐标与进库冻结值是否一致（允许 1mm 量算误差） */
export function isCoordinateMatch(a: { north: number; east: number }, b: { north: number; east: number }): boolean {
  return Math.abs(a.north - b.north) <= 0.001 && Math.abs(a.east - b.east) <= 0.001
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** 基点迁移：由旧基点下的平面读数和新旧基点，换算新基点下的平面读数（毫米取整） */
export function rebaseReading(
  reading: { x: number; y: number },
  oldBase: { north: number; east: number },
  newBase: { north: number; east: number }
): { x: number; y: number } {
  const global = toGlobalCoordinate(reading, oldBase)
  return {
    x: round3(global.east - newBase.east),
    y: round3(global.north - newBase.north)
  }
}

export { round3 }
