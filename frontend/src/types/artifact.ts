/** 器物类别 */
export const ARTIFACT_CATEGORIES = ['陶器', '瓷器', '石器', '骨器', '铜器'] as const
export type ArtifactCategory = (typeof ARTIFACT_CATEGORIES)[number]

/** 残整程度 */
export const COMPLETENESS = ['完整', '可复原', '残片'] as const
export type Completeness = (typeof COMPLETENESS)[number]

/**
 * 整理室台账状态（整理室管器物编号、平面读数和存放位置）。
 * - pending   未归档：读数按当前基点量取，测绘组改版后要重算
 * - stocked   已进库：坐标已按进库时基点冻结，不再随基点改版变化
 * - suspended 挂起：与测绘基点记录对不上，等测绘组确认，先不进库
 * - failed    重算失败：找不到旧基点版本等，整理室只重试自己那份读数
 */
export const ARTIFACT_LEDGER_STATUS = ['pending', 'stocked', 'suspended', 'failed'] as const
export type ArtifactLedgerStatus = (typeof ARTIFACT_LEDGER_STATUS)[number]

export const ARTIFACT_STATUS_LABEL: Record<ArtifactLedgerStatus, string> = {
  pending: '未归档',
  stocked: '已进库',
  suspended: '挂起待确认',
  failed: '重算失败'
}

/** Artifact 出土物（整理室台账） */
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
  /** 平面读数 X（米，相对所在基点版本，整理室量） */
  x: number
  /** 平面读数 Y（米，相对所在基点版本，整理室量） */
  y: number
  /** 探方内坐标 Z（距地表深度，米） */
  z: number
  date: string
  /** 提取人 */
  collector: string
  /** 临时存放位置 */
  tempLocation: string

  /** 读数所依据的基点版本号（测绘组台账） */
  baseVersion: number
  /** 台账状态 */
  status: ArtifactLedgerStatus
  /** 进库后冻结的绝对坐标 N/E/高程（米）；未进库为 null */
  frozenNorth: number | null
  frozenEast: number | null
  frozenElev: number | null
  /** 进库时冻结的基点版本号 */
  frozenVersion: number | null
  /** 进库日期 */
  stockedDate: string
  /** 挂起/重算失败原因，以及测绘组确认意见 */
  holdReason: string
  /** 最近一次重算时间（ISO） */
  lastRecomputeAt: string
}

/** 挂起器物经测绘组确认后的处理方式 */
export const SUSPEND_RESOLUTIONS = ['确认进库', '退回重测'] as const
export type SuspendResolution = (typeof SUSPEND_RESOLUTIONS)[number]
