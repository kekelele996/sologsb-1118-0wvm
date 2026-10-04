import { onUnmounted, reactive } from 'vue'
import type { StoreApi } from 'zustand/vanilla'
import Dexie, { type Table } from 'dexie'
import type { Artifact, BasePointVersion, Relation, Stratum, Trench } from '@/types'
import { absoluteCoord, parseBasePointText } from '@/types'

/** IndexedDB 数据结构版本号 */
export const SCHEMA_VERSION = 3

export interface MetaRow {
  key: string
  value: number
}

/** Dexie 封装：基点版本 / 探方 / 地层单位 / 出土物 / 层位关系 五张表 + 元数据表 */
class TrenchLogDb extends Dexie {
  basePoints!: Table<BasePointVersion, string>
  trenches!: Table<Trench, string>
  strata!: Table<Stratum, string>
  artifacts!: Table<Artifact, string>
  relations!: Table<Relation, string>
  meta!: Table<MetaRow, string>

  constructor() {
    super('gbtrenchlog')
    this.version(1).stores({
      trenches: 'id, code, area',
      strata: 'id, trenchId, code, type',
      artifacts: 'id, stratumId, code, category',
      relations: 'id, unitAId, unitBId, type',
      meta: 'key'
    })
    // v2：地层单位新增「开口层位」字段，迁移时为历史数据补齐默认值
    this.version(2)
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
    // v3：基点版本台账独立成表；旧数据没基点版本，升级时按当时基点补齐
    this.version(SCHEMA_VERSION)
      .stores({
        basePoints: 'id, trenchId, version, current',
        trenches: 'id, code, area, backfilled',
        strata: 'id, trenchId, code, type, topDepth',
        artifacts: 'id, stratumId, code, category, date, status, baseVersion',
        relations: 'id, unitAId, unitBId, type, basis',
        meta: 'key'
      })
      .upgrade(async (tx) => {
        const baseTable = tx.table<BasePointVersion, string>('basePoints')
        const trenchTable = tx.table<Trench, string>('trenches')
        const stratumTable = tx.table<Stratum, string>('strata')
        const artifactTable = tx.table<Artifact, string>('artifacts')

        const trenches = await trenchTable.toArray()
        const strata = await stratumTable.toArray()
        const trenchBaseVersion = new Map<string, BasePointVersion>()

        // 每个旧探方按其登记的基点坐标补一条 v1（解析不了的落到 (0,0) 并留痕，等测绘组校正）
        for (const trench of trenches) {
          let northing = 0
          let easting = 0
          let note = '系统升级时按当时登记基点补齐'
          try {
            const parsed = parseBasePointText(trench.basePoint ?? '')
            northing = parsed.northing
            easting = parsed.easting
          } catch {
            note = `系统升级时基点文本「${trench.basePoint ?? ''}」无法解析，暂记 (0,0)，待测绘组校正`
          }
          const version: BasePointVersion = {
            id: `bp_${trench.id}_v1`,
            trenchId: trench.id,
            version: 1,
            northing,
            easting,
            elevation: 0,
            effectiveDate: trench.startDate || '',
            surveyor: trench.leader || '',
            note,
            current: true
          }
          trenchBaseVersion.set(trench.id, version)
          await baseTable.put(version)
        }

        // 旧器物一律按当时基点（v1）补齐版本信息；历史坐标不可变，视作已进库并冻结
        await artifactTable.toCollection().modify((artifact) => {
          const stratum = strata.find((item) => item.id === artifact.stratumId)
          const base = stratum ? trenchBaseVersion.get(stratum.trenchId) : undefined
          if (base) {
            const coord = absoluteCoord(base, { x: artifact.x, y: artifact.y, z: artifact.z })
            artifact.baseVersion = base.version
            artifact.status = 'stocked'
            artifact.frozenNorth = coord.north
            artifact.frozenEast = coord.east
            artifact.frozenElev = coord.elev
            artifact.frozenVersion = base.version
            artifact.stockedDate = artifact.date || ''
            artifact.holdReason = '升级前历史数据，按当时基点补齐并冻结'
            artifact.lastRecomputeAt = ''
          }
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

  await db.basePoints.bulkPut([
    {
      id: 'bp_0501_v1',
      trenchId: 'tr_0501',
      version: 1,
      northing: 1200,
      easting: 3000,
      elevation: 45.2,
      effectiveDate: today,
      surveyor: '衡准',
      note: '首版基点，T0501 西南角',
      current: true
    },
    {
      id: 'bp_0501_v2',
      trenchId: 'tr_0501',
      version: 2,
      northing: 1200.5,
      easting: 3000,
      elevation: 45.2,
      effectiveDate: today,
      surveyor: '衡准',
      note: '原木桩被施工扰动，基点北移 0.5 m（历史版本记录）',
      current: false
    },
    {
      id: 'bp_0502_v1',
      trenchId: 'tr_0502',
      version: 1,
      northing: 1205,
      easting: 3000,
      elevation: 45.0,
      effectiveDate: today,
      surveyor: '衡准',
      note: '首版基点',
      current: true
    }
  ])

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
      tempLocation: '库房 3 号架',
      baseVersion: 1,
      status: 'stocked',
      frozenNorth: 1202.4,
      frozenEast: 3001.8,
      frozenElev: 44.78,
      frozenVersion: 1,
      stockedDate: today,
      holdReason: '',
      lastRecomputeAt: ''
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
      tempLocation: '库房 3 号架',
      baseVersion: 1,
      status: 'stocked',
      frozenNorth: 1203.1,
      frozenEast: 3003.6,
      frozenElev: 44.15,
      frozenVersion: 1,
      stockedDate: today,
      holdReason: '',
      lastRecomputeAt: ''
    },
    {
      id: 'af_003',
      stratumId: 'st_0501_l2',
      code: 'T0501②:2',
      category: '石器',
      count: 1,
      completeness: '完整',
      x: 1.2,
      y: 4.1,
      z: 0.5,
      date: today,
      collector: '祁野',
      tempLocation: '工地临时柜 A-2',
      baseVersion: 1,
      status: 'pending',
      frozenNorth: null,
      frozenEast: null,
      frozenElev: null,
      frozenVersion: null,
      stockedDate: '',
      holdReason: '',
      lastRecomputeAt: ''
    },
    {
      id: 'af_004',
      stratumId: 'st_0501_h12',
      code: 'T0501H12:2',
      category: '陶器',
      count: 2,
      completeness: '残片',
      x: 0.8,
      y: 2.2,
      z: 0.9,
      date: today,
      collector: '祁野',
      tempLocation: '库房暂存区',
      baseVersion: 1,
      status: 'suspended',
      // 进库冻结坐标与测绘基点记录重算结果对不上，挂起等测绘组确认
      frozenNorth: 1200.92,
      frozenEast: 3002.2,
      frozenElev: 44.3,
      frozenVersion: 1,
      stockedDate: '',
      holdReason: '对账差异：N 向差 0.12 m，超出容差 0.01 m，待测绘组确认',
      lastRecomputeAt: ''
    },
    {
      id: 'af_005',
      stratumId: 'st_0501_l2',
      code: 'T0501②:3',
      category: '骨器',
      count: 1,
      completeness: '残片',
      x: 2.0,
      y: 2.0,
      z: 0.35,
      date: today,
      collector: '祁野',
      tempLocation: '工地临时柜 A-2',
      // 读数挂在测绘台账缺失的基点版本上，重算失败，等基点补齐后只重试这一件
      baseVersion: 3,
      status: 'failed',
      frozenNorth: null,
      frozenEast: null,
      frozenElev: null,
      frozenVersion: null,
      stockedDate: '',
      holdReason: '重算失败：找不到读数所依据的基点 v3，请测绘组补台账后重试',
      lastRecomputeAt: today
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
