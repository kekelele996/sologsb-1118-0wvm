/**
 * 测绘组台账：探方基点版本
 * 测绘组管基点坐标与换算基准；基点改动只追加新版本，不覆盖历史记录。
 */
export interface BasePoint {
  id: string
  /** 所属探方 */
  trenchId: string
  /** 同一探方内基点版本号，从 1 递增 */
  version: number
  /** 北坐标（米）；旧数据补录前允许为空 */
  north: number | null
  /** 东坐标（米）；旧数据补录前允许为空 */
  east: number | null
  /** 高程（米，可选） */
  elevation: number | null
  /** 测绘原始记录，如 N1200 / E3000 */
  note: string
  /** 测绘组登记人 */
  recorder: string
  /** 启用日期 YYYY-MM-DD，此后登记的未归档器物按该版本量算 */
  effectiveDate: string
  /** 是否为当前生效版本 */
  active: boolean
}

/** 从测绘原始记录文本中解析北/东坐标数字，解析不到返回 null（如旧数据只有文字描述） */
export function parseBasePointNote(note: string): { north: number | null; east: number | null } {
  const northMatch = note.match(/N\s*([-+]?\d+(?:\.\d+)?)/i)
  const eastMatch = note.match(/E\s*([-+]?\d+(?:\.\d+)?)/i)
  return {
    north: northMatch ? Number(northMatch[1]) : null,
    east: eastMatch ? Number(eastMatch[1]) : null
  }
}

/** 基点坐标是否已补齐（换算基准完整） */
export function isBasePointComplete(point: Pick<BasePoint, 'north' | 'east'>): boolean {
  return typeof point.north === 'number' && typeof point.east === 'number'
}

/** 基点版本的显示标签 */
export function basePointLabel(point: Pick<BasePoint, 'version' | 'north' | 'east'>): string {
  return isBasePointComplete(point)
    ? `v${point.version}（N${point.north} / E${point.east}）`
    : `v${point.version}（坐标待补录）`
}
