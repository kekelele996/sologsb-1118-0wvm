import { onUnmounted, reactive } from 'vue'
import type { StoreApi } from 'zustand/vanilla'
import Dexie, { type Table } from 'dexie'
import type { Artifact, BasePoint, Relation, Stratum, Trench } from '@/types'
import { isBasePointComplete, parseBasePointNote } from '@/types'

/** IndexedDB 数据结构版本号 */
export const SCHEMA_VERSION = 3

export interface MetaRow {
  key: string
  value: number
}

/** Dexie 封装：探方 / 地层单位 / 出土物 / 层位关系 / 基点版本 五张表 + 元数据表 */
class TrenchLogDb extends Dexie {
  trenches!: Table<Trench, string>
  strata!: Table<Stratum, string>
  artifacts!: Table<Artifact, string>
  relations!: Table<Relation, string>
  basePoints!: Table<BasePoint, string>
  meta!: Table<MetaRow, string>

  constructor() {
    super('gbtrenchlog')
    this.version(1).stores({
      trenches: 'id, code, area',
      strata: 'id, trenchId, code, type',
      artifacts: 'id, stratumId, code, category',
      relations: 'id, unitAId, unitBId, type',
      basePoints: 'id, trenchId, version, active',
      meta: 'key'
    })
    // v2：地层单位新增「开口层位」字段，迁移时为历史数据补齐默认值
    this.version(SCHEMA_VERSION)
      .stores({
        trenches: 'id, code, area, backfilled',
        strata: 'id, trenchId, code, type, topDepth',
        artifacts: 'id, stratumId, code, category, date',
        relations: 'id, unitAId, unitBId, type, basis',
        meta: 'key'
      })
      .upgrade(async (tx) => {
        await tx
          .table<Stratum, string>('strata')
          .toCollection()
          .modify((stratum) => {
            if (!stratum.openLayer) {
              stratum.openLayer = '第①层'
            }
            if (!Array.isArray(stratum.inclusions)) {
              stratum.inclusions = []
            }
          })
      })
    // v3：测绘组基点独立成「基点版本台账」；器物增加基点版本、对账状态与进库冻结坐标。
    // 旧数据没有基点版本，升级时按各探方当时基点补齐 v1，并把历史器物挂到该版本上。
    this.version(SCHEMA_VERSION)
      .stores({
        trenches: 'id, code, area, backfilled',
        strata: 'id, trenchId, code, type, topDepth',
        artifacts: 'id, stratumId, code, category, date, status, basePointId',
        relations: 'id, unitAId, unitBId, type, basis',
        basePoints: 'id, trenchId, version, active',
        meta: 'key'
      })
      .upgrade(async (tx) => {
        const basePointsTable = tx.table<BasePoint, string>('basePoints')

        // 旧数据没有基点版本：先读各探方当时基点，补齐 v1（只追加，不改探方记录）
        const trenches = await tx.table<Trench, string>('trenches').toArray()
        const strata = await tx.table<Stratum, string>('strata').toArray()
        const basePoints: BasePoint[] = trenches.map((trench) => {
          const { north, east } = parseBasePointNote(trench.basePoint ?? '')
          return {
            id: `bp_${trench.id}_v1`,
            trenchId: trench.id,
            version: 1,
            north,
            east,
            elevation: null,
            note: trench.basePoint ?? '',
            recorder: '',
            effectiveDate: trench.startDate ?? '',
            active: true
          }
        })
        await basePointsTable.bulkPut(basePoints)

        const trenchById = new Map(trenches.map((item) => [item.id, item]))
        const trenchIdByStratum = new Map(strata.map((item) => [item.id, item.trenchId]))
        const basePointIdByTrench = new Map(basePoints.map((item) => [item.trenchId, item.id]))

        // 历史器物挂到其探方当时基点 v1；基点只有文字、解析不出坐标的先挂起，补录后再对账
        await tx
          .table<Artifact, string>('artifacts')
          .toCollection()
          .modify((artifact) => {
            if (artifact.status) return
            const trenchId = trenchIdByStratum.get(artifact.stratumId) ?? ''
            const basePointId = basePointIdByTrench.get(trenchId) ?? null
            const trench = trenchById.get(trenchId)
            const parsed = trench ? parseBasePointNote(trench.basePoint ?? '') : { north: null, east: null }
            const complete = isBasePointComplete(parsed)
            artifact.basePointId = basePointId
            artifact.status = complete ? 'recorded' : 'held'
            artifact.frozenNorth = null
            artifact.frozenEast = null
            artifact.recalcIssue = complete ? null : 'incomplete-basepoint'
            artifact.holdNote = complete ? '' : '旧数据基点坐标未补齐，按当时基点补录后方可对账进库'
          })
      })
  }
}

export const db = new TrenchLogDb()

/** 写入当前数据结构版本号 */
export async function stampDbVersion(): Promise<void> {
  await db.meta.put({ key: 'schemaVersion', value: SCHEMA_VERSION })
}

/** 读取整表 */
export async function syncAll<T extends object>(table: Table<T, string>): Promise<T[]> {
  return table.toArray()
}

/** 写入一条记录 */
export async function syncPut<T extends object>(table: Table<T, string>, row: T): Promise<void> {
  await table.put(row)
}

/** 删除一条记录 */
export async function syncDelete<T extends object>(table: Table<T, string>, id: string): Promise<void> {
  await table.delete(id)
}

/** Zustand vanilla store → Vue 响应式桥接 */
export function useStore<T extends object>(store: StoreApi<T>): T {
  const state = reactive({ ...store.getState() }) as T
  const unsubscribe = store.subscribe((next: T) => {
    Object.assign(state, next)
  })
  onUnmounted(() => unsubscribe())
  return state
}

/** 首次打开写入示例数据 */
export async function seedDemoData(): Promise<void> {
  const count = await db.trenches.count()
  if (count > 0) return

  const today = new Date().toISOString().slice(0, 10)

  await db.trenches.bulkPut([
    {
      id: 'tr_0501',
      code: 'T0501',
      area: 'Ⅱ区',
      size: '5×5 米',
      basePoint: 'N1200 / E3000',
      openLayer: '第①层',
      startDate: today,
      endDate: '',
      leader: '方铭',
      wallNote: '北壁、东壁保存较好；南壁被现代扰坑破坏',
      backfilled: false
    },
    {
      id: 'tr_0502',
      code: 'T0502',
      area: 'Ⅱ区',
      size: '5×5 米',
      basePoint: 'N1205 / E3000',
      openLayer: '第①层',
      startDate: today,
      endDate: today,
      leader: '方铭',
      wallNote: '四壁规整，西壁可见 H12 剖面',
      backfilled: true
    }
  ])

  await db.strata.bulkPut([
    {
      id: 'st_0501_l1',
      trenchId: 'tr_0501',
      code: 'L01',
      type: '地层',
      openLayer: '第①层',
      topDepth: 0,
      bottomDepth: 0.25,
      soil: '灰褐色砂质黏土，疏松',
      inclusions: ['陶片', '炭屑'],
      formation: '近现代耕土层',
      date: today,
      drawingNo: 'T0501-北壁-01'
    },
    {
      id: 'st_0501_l2',
      trenchId: 'tr_0501',
      code: 'L02',
      type: '地层',
      openLayer: '第②层',
      topDepth: 0.25,
      bottomDepth: 0.6,
      soil: '黄褐色黏土，致密',
      inclusions: ['陶片', '骨'],
      formation: '汉代文化层',
      date: today,
      drawingNo: 'T0501-北壁-02'
    },
    {
      id: 'st_0501_h12',
      trenchId: 'tr_0501',
      code: 'H12',
      type: '灰坑',
      openLayer: '第②层下',
      topDepth: 0.6,
      bottomDepth: 1.4,
      soil: '深灰褐土，含大量灰烬',
      inclusions: ['陶片', '骨', '炭屑'],
      formation: '生活垃圾坑',
      date: today,
      drawingNo: 'T0501-H12-平剖面'
    },
    {
      id: 'st_0502_l1',
      trenchId: 'tr_0502',
      code: 'L01',
      type: '地层',
      openLayer: '第①层',
      topDepth: 0,
      bottomDepth: 0.3,
      soil: '灰褐色砂质黏土',
      inclusions: ['陶片'],
      formation: '耕土层',
      date: today,
      drawingNo: 'T0502-西壁-01'
    }
  ])

  await db.basePoints.bulkPut([
    {
      id: 'bp_tr_0501_v1',
      trenchId: 'tr_0501',
      version: 1,
      north: 1200,
      east: 3000,
      elevation: 46.2,
      note: 'N1200 / E3000',
      recorder: '测绘组·岳衡',
      effectiveDate: today,
      active: true
    },
    {
      id: 'bp_tr_0502_v1',
      trenchId: 'tr_0502',
      version: 1,
      north: 1205,
      east: 3000,
      elevation: 46.1,
      note: 'N1205 / E3000',
      recorder: '测绘组·岳衡',
      effectiveDate: today,
      active: true
    }
  ])

  await db.artifacts.bulkPut([
    {
      id: 'af_001',
      stratumId: 'st_0501_l2',
      code: 'T0501②:1',
      category: '陶器',
      count: 3,
      completeness: '残片',
      x: 2.4,
      y: 1.8,
      z: 0.42,
      date: today,
      collector: '祁野',
      tempLocation: '工地临时柜 A-2',
      basePointId: 'bp_tr_0501_v1',
      status: 'recorded',
      frozenNorth: null,
      frozenEast: null,
      recalcIssue: null,
      holdNote: ''
    },
    {
      id: 'af_002',
      stratumId: 'st_0501_h12',
      code: 'T0501H12:1',
      category: '骨器',
      count: 1,
      completeness: '可复原',
      x: 3.1,
      y: 3.6,
      z: 1.05,
      date: today,
      collector: '祁野',
      tempLocation: '工地临时柜 A-3',
      basePointId: 'bp_tr_0501_v1',
      status: 'archived',
      frozenNorth: 1203.6,
      frozenEast: 3003.1,
      recalcIssue: null,
      holdNote: ''
    }
  ])

  await db.relations.bulkPut([
    {
      id: 'rl_001',
      unitAId: 'st_0501_h12',
      type: '打破',
      unitBId: 'st_0501_l2',
      basis: '剖面观察',
      recorder: '方铭',
      note: 'H12 开口于第②层下，打破 L02'
    },
    {
      id: 'rl_002',
      unitAId: 'st_0501_l1',
      type: '叠压',
      unitBId: 'st_0501_l2',
      basis: '剖面观察',
      recorder: '方铭',
      note: 'L01 叠压 L02，界面清晰'
    }
  ])
}
