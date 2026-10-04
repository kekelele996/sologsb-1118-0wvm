/**
 * 基点版本台账（测绘组管）
 *
 * 测绘组负责基点坐标与换算基准：一个探方的基点可以改版，
 * 每次改版都生成一条不可物理删除的版本记录，器物按版本号对账。
 */

/** 基点坐标解析/登记异常 */
export class BasePointError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BasePointError'
  }
}

/** 基点版本（测绘台账，一份） */
export interface BasePointVersion {
  id: string
  /** 所属探方 */
  trenchId: string
  /** 版本号，从 1 起，同探方内递增 */
  version: number
  /** 北坐标（米，如 N1200） */
  northing: number
  /** 东坐标（米，如 E3000） */
  easting: number
  /** 基准面高程（米，用于 Z 换算；缺省按 0 处理） */
  elevation: number
  /** 生效日期 YYYY-MM-DD */
  effectiveDate: string
  /** 测绘记录人（测绘组） */
  surveyor: string
  /** 改版/校正说明（如「原点被施工扰动，北移 0.5 m」） */
  note: string
  /** 是否为当前生效版本（同探方仅一条为 true） */
  current: boolean
}

/** 坐标值保留精度（米） */
export const COORD_EPSILON = 0.005

/** 对账容差（米）：差值不超过即视为吻合 */
export const RECONCILE_TOLERANCE = 0.01

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * 解析形如「N1200 / E3000」「N1200.5,E3000.2」的基点文本。
 * 旧数据只留了这串文本，迁移时按当时基点补齐数值。
 */
export function parseBasePointText(text: string): { northing: number; easting: number } {
  const compact = text.trim().toUpperCase().replace(/\s+/g, '')
  const match = /N(-?\d+(?:\.\d+)?)[\/,，]?E(-?\d+(?:\.\d+)?)/.exec(compact)
  if (!match) {
    throw new BasePointError(`基点坐标「${text || '空'}」无法解析，需形如 N1200 / E3000`)
  }
  return { northing: Number(match[1]), easting: Number(match[2]) }
}

/** 拼成展示文本 */
export function formatBasePoint(version: Pick<BasePointVersion, 'northing' | 'easting'>): string {
  return `N${version.northing} / E${version.easting}`
}

/** 取探方当前基点版本 */
export function currentBasePoint(versions: BasePointVersion[], trenchId: string): BasePointVersion | null {
  return versions.find((item) => item.trenchId === trenchId && item.current) ?? null
}

/** 取探方指定版本 */
export function basePointByVersion(
  versions: BasePointVersion[],
  trenchId: string,
  version: number
): BasePointVersion | null {
  return versions.find((item) => item.trenchId === trenchId && item.version === version) ?? null
}

/** 探方基点版本按版本号排序 */
export function versionsOfTrench(versions: BasePointVersion[], trenchId: string): BasePointVersion[] {
  return versions
    .filter((item) => item.trenchId === trenchId)
    .slice()
    .sort((a, b) => a.version - b.version)
}

/**
 * 平面读数换算：基点移动后，器物相对新基点的读数 = 旧读数 +（旧基点 − 新基点）。
 * 测绘组改的是基点绝对坐标，整理室量的是相对基点的读数，基点北移则读数减小。
 */
export function recomputeReading(
  oldReading: { x: number; y: number; z: number },
  oldBase: Pick<BasePointVersion, 'northing' | 'easting' | 'elevation'>,
  newBase: Pick<BasePointVersion, 'northing' | 'easting' | 'elevation'>
): { x: number; y: number; z: number } {
  return {
    x: round3(oldReading.x + (oldBase.northing - newBase.northing)),
    y: round3(oldReading.y + (oldBase.easting - newBase.easting)),
    z: round3(oldReading.z + (oldBase.elevation - newBase.elevation))
  }
}

/** 由基点 + 相对读数求器物绝对坐标（进库时冻结的那份） */
export function absoluteCoord(
  base: Pick<BasePointVersion, 'northing' | 'easting' | 'elevation'>,
  reading: { x: number; y: number; z: number }
): { north: number; east: number; elev: number } {
  return {
    north: round3(base.northing + reading.x),
    east: round3(base.easting + reading.y),
    elev: round3(base.elevation - reading.z)
  }
}

/** 两坐标差是否在对账容差内 */
export function isCoordMatch(
  a: { north: number; east: number; elev: number },
  b: { north: number; east: number; elev: number },
  tolerance = RECONCILE_TOLERANCE
): boolean {
  return (
    Math.abs(a.north - b.north) <= tolerance &&
    Math.abs(a.east - b.east) <= tolerance &&
    Math.abs(a.elev - b.elev) <= tolerance
  )
}
