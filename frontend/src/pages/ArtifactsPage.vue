<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Artifact, ArtifactCategory, ArtifactStatus, Completeness } from '@/types'
import { ARTIFACT_CATEGORIES, ARTIFACT_STATUS_LABEL, COMPLETENESS, basePointLabel } from '@/types'
import type { BasePoint } from '@/types/basepoint'
import StratumDepthBar from '@/components/common/StratumDepthBar.vue'
import UnitPicker from '@/components/common/UnitPicker.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { artifactStore } from '@/stores/artifactStore'
import { stratumStore } from '@/stores/stratumStore'
import { trenchStore } from '@/stores/trenchStore'
import { basePointStore } from '@/stores/basePointStore'
import { recalcArtifact } from '@/utils/reconcile'
import { downloadCsv } from '@/utils/export'
import { uid } from '@/utils/id'

const artifactState = useStore(artifactStore)
const stratumState = useStore(stratumStore)
const trenchState = useStore(trenchStore)
const basePointState = useStore(basePointStore)

const pickTrenchId = ref('')
const pickStratumId = ref('')
const filterCategory = ref<ArtifactCategory | ''>('')
const filterTrenchId = ref('')
const filterStatus = ref<ArtifactStatus | ''>('')
const editingId = ref<string | null>(null)
const selectedIds = ref<string[]>([])

const form = reactive({
  code: '',
  category: '陶器' as ArtifactCategory,
  count: 1,
  completeness: '残片' as Completeness,
  x: 2.5,
  y: 2.5,
  z: 0.5,
  date: new Date().toISOString().slice(0, 10),
  collector: '',
  tempLocation: ''
})

const lockedStratum = computed(() => stratumState.strata.find((item) => item.id === pickStratumId.value) ?? null)

/** 整理室量算平面读数时依据的基点：当前探方生效版本（测绘组那份） */
const activeBasePoint = computed<BasePoint | null>(() =>
  pickTrenchId.value ? basePointState.activeOf(pickTrenchId.value) : null
)

watch(
  () => [trenchState.trenches.length, pickTrenchId.value] as const,
  () => {
    if (!pickTrenchId.value && trenchState.trenches.length > 0) {
      pickTrenchId.value = trenchState.trenches[0].id
      const first = stratumState.strata.find((item) => item.trenchId === pickTrenchId.value)
      if (first) pickStratumId.value = first.id
    }
  },
  { immediate: true }
)

watch(
  () => [stratumState.strata.length, pickTrenchId.value] as const,
  () => {
    const list = stratumState.strata.filter((item) => !pickTrenchId.value || item.trenchId === pickTrenchId.value)
    if (!list.some((item) => item.id === pickStratumId.value)) {
      pickStratumId.value = list[0]?.id ?? ''
    }
    if (lockedStratum.value && !editingId.value) {
      form.z = Math.round(((lockedStratum.value.topDepth + lockedStratum.value.bottomDepth) / 2) * 100) / 100
    }
  },
  { immediate: true }
)

function stratumOf(stratumId: string): string {
  return stratumState.strata.find((item) => item.id === stratumId)?.code ?? '未知单位'
}

function trenchOf(stratumId: string): string {
  const stratum = stratumState.strata.find((item) => item.id === stratumId)
  if (!stratum) return '未知探方'
  const trench = trenchState.trenches.find((item) => item.id === stratum.trenchId)
  return trench ? `${trench.area} · ${trench.code}` : '未知探方'
}

function basePointOf(artifact: Artifact): BasePoint | null {
  return artifact.basePointId ? basePointState.basePoints.find((item) => item.id === artifact.basePointId) ?? null : null
}

/** 按测绘组基点记录实时重算的全局坐标（用于表格与对账提示） */
function globalOf(artifact: Artifact): { north: number; east: number } | null {
  return recalcArtifact(artifact, basePointState.basePoints).global
}

function statusType(status: ArtifactStatus): 'success' | 'warning' | 'info' | 'danger' {
  return status === 'archived' ? 'success' : status === 'held' ? 'danger' : 'warning'
}

const visible = computed(() =>
  artifactState.artifacts.filter((item) => {
    if (filterCategory.value && item.category !== filterCategory.value) return false
    if (filterStatus.value && item.status !== filterStatus.value) return false
    if (filterTrenchId.value) {
      const stratum = stratumState.strata.find((row) => row.id === item.stratumId)
      if (!stratum || stratum.trenchId !== filterTrenchId.value) return false
    }
    return true
  })
)

const totalCount = computed(() => visible.value.reduce((sum, item) => sum + item.count, 0))
const pendingCount = computed(() => artifactState.artifacts.filter((item) => item.status === 'recorded').length)
const heldCount = computed(() => artifactState.artifacts.filter((item) => item.status === 'held').length)

function resetForm(): void {
  editingId.value = null
  form.code = ''
  form.category = '陶器'
  form.count = 1
  form.completeness = '残片'
  form.x = 2.5
  form.y = 2.5
  form.date = new Date().toISOString().slice(0, 10)
  form.collector = ''
  form.tempLocation = ''
  if (lockedStratum.value) {
    form.z = Math.round(((lockedStratum.value.topDepth + lockedStratum.value.bottomDepth) / 2) * 100) / 100
  }
}

function openEdit(artifact: Artifact): void {
  if (artifact.status === 'archived') {
    ElMessage.info('该器物已进库，坐标已冻结；如需变更须先与测绘组基点记录对账，不能直接改读数')
    return
  }
  editingId.value = artifact.id
  const stratum = stratumState.strata.find((item) => item.id === artifact.stratumId)
  if (stratum) {
    pickTrenchId.value = stratum.trenchId
    pickStratumId.value = stratum.id
  }
  Object.assign(form, {
    code: artifact.code,
    category: artifact.category,
    count: artifact.count,
    completeness: artifact.completeness,
    x: artifact.x,
    y: artifact.y,
    z: artifact.z,
    date: artifact.date,
    collector: artifact.collector,
    tempLocation: artifact.tempLocation
  })
}

async function submit(): Promise<void> {
  if (!lockedStratum.value) {
    ElMessage.warning('请先选择所属地层单位')
    return
  }
  if (!form.code.trim()) {
    ElMessage.warning('请填写器物编号')
    return
  }
  const duplicated = artifactState.artifacts.some(
    (item) => item.id !== editingId.value && item.code.trim().toUpperCase() === form.code.trim().toUpperCase()
  )
  if (duplicated) {
    ElMessage.error(`器物编号「${form.code}」已存在`)
    return
  }
  if (form.z < lockedStratum.value.topDepth || form.z > lockedStratum.value.bottomDepth) {
    ElMessage.warning(
      `出土深度 ${form.z} m 不在单位「${lockedStratum.value.code}」的深度区间（${lockedStratum.value.topDepth}–${lockedStratum.value.bottomDepth} m）内，请核对层位`
    )
    return
  }
  const editing = editingId.value ? artifactState.artifacts.find((item) => item.id === editingId.value) : null
  // 整理室这份：新登记按当前生效基点量算；编辑沿用原量算基点，基点台账不由整理室改动
  const basePointId = editing?.basePointId ?? activeBasePoint.value?.id ?? null
  const baseReady = activeBasePoint.value && activeBasePoint.value.north !== null && activeBasePoint.value.east !== null
  const row: Artifact = {
    id: editingId.value ?? uid('af'),
    stratumId: lockedStratum.value.id,
    code: form.code.trim(),
    category: form.category,
    count: Number(form.count) || 1,
    completeness: form.completeness,
    x: Number(form.x) || 0,
    y: Number(form.y) || 0,
    z: Number(form.z) || 0,
    date: form.date,
    collector: form.collector.trim(),
    tempLocation: form.tempLocation.trim(),
    basePointId,
    status: editing?.status ?? (baseReady ? 'recorded' : 'held'),
    frozenNorth: editing?.frozenNorth ?? null,
    frozenEast: editing?.frozenEast ?? null,
    recalcIssue: editing?.recalcIssue ?? (baseReady ? null : 'incomplete-basepoint'),
    holdNote: editing?.holdNote ?? (baseReady ? '' : '当前探方基点坐标未登记/未补齐，暂缓进库，等测绘组确认')
  }
  await artifactStore.getState().save(row)
  // 保存后立即按测绘组基点记录对账一次（只重算器物这份）
  await artifactStore.getState().reconcile([row.id], basePointState.basePoints)
  ElMessage.success(`出土物 ${row.code} 已登记到 ${lockedStratum.value.code}`)
  resetForm()
}

/** 与测绘组基点记录对账：默认对全部未归档/挂起器物，或勾选的器物 */
async function reconcileNow(): Promise<void> {
  const ids = selectedIds.value.length > 0
    ? selectedIds.value
    : artifactState.artifacts.filter((item) => item.status !== 'archived').map((item) => item.id)
  if (ids.length === 0) {
    ElMessage.info('没有需要对账的未归档器物')
    return
  }
  await artifactStore.getState().reconcile(ids, basePointState.basePoints)
  const held = artifactState.artifacts.filter((item) => ids.includes(item.id) && item.status === 'held').length
  held > 0
    ? ElMessage.warning(`对账完成：${held} 件与测绘组基点记录对不上，已挂起等确认`)
    : ElMessage.success('对账完成，所选器物均与基点记录一致')
  selectedIds.value = []
}

/** 进库：按当前基点重算并冻结坐标；对不上的保持挂起不进库 */
async function archiveSelected(): Promise<void> {
  const ids = selectedIds.value.length > 0
    ? selectedIds.value
    : artifactState.artifacts.filter((item) => item.status === 'recorded').map((item) => item.id)
  if (ids.length === 0) {
    ElMessage.info('请先勾选要进库的未归档器物')
    return
  }
  const before = new Set(ids)
  await artifactStore.getState().archive(ids, basePointState.basePoints)
  const stillHeld = artifactState.artifacts.filter((item) => before.has(item.id) && item.status === 'held').length
  const archived = artifactState.artifacts.filter((item) => before.has(item.id) && item.status === 'archived').length
  archived > 0 && ElMessage.success(`${archived} 件器物已进库，坐标按基点记录冻结`)
  stillHeld > 0 && ElMessage.warning(`${stillHeld} 件对不上基点记录，已挂起暂不进库`)
  selectedIds.value = []
}

/** 测绘组确认后解除挂起 */
async function releaseSelected(): Promise<void> {
  const ids = selectedIds.value.length > 0
    ? selectedIds.value
    : artifactState.artifacts.filter((item) => item.status === 'held').map((item) => item.id)
  const heldIds = artifactState.artifacts.filter((item) => ids.includes(item.id) && item.status === 'held').map((item) => item.id)
  if (heldIds.length === 0) {
    ElMessage.info('没有挂起待确认的器物')
    return
  }
  await artifactStore.getState().releaseHold(heldIds)
  ElMessage.success(`已解除 ${heldIds.length} 件挂起，回到未归档，可重新对账进库`)
  selectedIds.value = []
}

async function remove(artifact: Artifact): Promise<void> {
  await ElMessageBox.confirm(`确认删除出土物「${artifact.code}」？`, '删除确认', { type: 'warning' })
  await artifactStore.getState().remove(artifact.id)
  ElMessage.success('出土物已删除')
}

function exportList(): void {
  downloadCsv(
    '出土物清单.csv',
    visible.value.map((item) => {
      const bp = basePointOf(item)
      const global = globalOf(item)
      return {
        code: item.code,
        stratum: stratumOf(item.stratumId),
        trench: trenchOf(item.stratumId),
        category: item.category,
        count: item.count,
        completeness: item.completeness,
        x: item.x,
        y: item.y,
        z: item.z,
        basePoint: bp ? basePointLabel(bp) : '未挂基点',
        status: ARTIFACT_STATUS_LABEL[item.status],
        frozenNorth: item.frozenNorth ?? '',
        frozenEast: item.frozenEast ?? '',
        calcNorth: global?.north ?? '',
        calcEast: global?.east ?? '',
        holdNote: item.holdNote,
        date: item.date,
        collector: item.collector,
        tempLocation: item.tempLocation
      }
    }) as unknown as Record<string, unknown>[],
    [
      { key: 'code', label: '器物编号' },
      { key: 'stratum', label: '地层单位' },
      { key: 'trench', label: '探方' },
      { key: 'category', label: '类别' },
      { key: 'count', label: '件数' },
      { key: 'completeness', label: '残整程度' },
      { key: 'x', label: 'X(m)' },
      { key: 'y', label: 'Y(m)' },
      { key: 'z', label: 'Z 深度(m)' },
      { key: 'basePoint', label: '量算基点' },
      { key: 'status', label: '对账状态' },
      { key: 'frozenNorth', label: '进库N' },
      { key: 'frozenEast', label: '进库E' },
      { key: 'calcNorth', label: '重算N' },
      { key: 'calcEast', label: '重算E' },
      { key: 'holdNote', label: '挂起原因' },
      { key: 'date', label: '出土日期' },
      { key: 'collector', label: '提取人' },
      { key: 'tempLocation', label: '临时存放' }
    ]
  )
  ElMessage.success('出土物清单已导出')
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">出土物登记与清单</h2>
        <p class="page-sub">
          登记时先锁定所属地层单位（选择器按探方与类型级联），页面即时带出该单位的深度区间并校验出土深度是否落在区间内。
        </p>
      </div>
      <el-button @click="exportList">导出清单</el-button>
    </div>

    <el-card shadow="never" class="form-card">
      <template #header>登记出土物（层位上下文锁定）</template>
      <UnitPicker
        v-model="pickStratumId"
        v-model:trench-id="pickTrenchId"
        :trenches="trenchState.trenches"
        :strata="stratumState.strata"
      />
      <div v-if="lockedStratum" class="locked">
        <StratumDepthBar :stratum="lockedStratum" :length="240" />
        <span class="muted">
          该单位包含物：{{ lockedStratum.inclusions.join('、') || '无' }} · 堆积成因：{{ lockedStratum.formation || '—' }}
        </span>
      </div>
      <el-alert
        v-if="activeBasePoint"
        :type="activeBasePoint.north === null || activeBasePoint.east === null ? 'warning' : 'info'"
        :closable="false"
        show-icon
        class="bp-banner"
        :title="`整理室按测绘组当前基点 ${basePointLabel(activeBasePoint)} 量取平面读数（启用 ${activeBasePoint.effectiveDate || '—'}，登记 ${activeBasePoint.recorder || '—'}）`"
        :description="activeBasePoint.north === null || activeBasePoint.east === null ? '该基点坐标未补齐，新登记器物将挂起，等测绘组确认后才能对账进库。' : ''"
      />
      <el-form label-width="100px" class="form">
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="器物编号" required>
              <el-input v-model="form.code" placeholder="如 T0501②:2" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="类别">
              <el-select v-model="form.category" style="width: 100%">
                <el-option v-for="item in ARTIFACT_CATEGORIES" :key="item" :label="item" :value="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="件数">
              <el-input-number v-model="form.count" :min="1" :controls="false" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="残整程度">
              <el-select v-model="form.completeness" style="width: 100%">
                <el-option v-for="item in COMPLETENESS" :key="item" :label="item" :value="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="出土 X(m)">
              <el-input-number v-model="form.x" :min="0" :max="10" :step="0.1" :controls="false" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="出土 Y(m)">
              <el-input-number v-model="form.y" :min="0" :max="10" :step="0.1" :controls="false" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="出土 Z 深度(m)">
              <el-input-number v-model="form.z" :min="0" :max="10" :step="0.01" :precision="2" :controls="false" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="出土日期">
              <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="提取人">
              <el-input v-model="form.collector" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="临时存放">
              <el-input v-model="form.tempLocation" placeholder="如 工地临时柜 A-2" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <div class="actions">
        <el-button type="primary" @click="submit">{{ editingId ? '保存修改' : '登记出土物' }}</el-button>
        <el-button v-if="editingId" @click="resetForm">取消编辑</el-button>
      </div>
    </el-card>

    <div class="toolbar">
      <el-select v-model="filterTrenchId" placeholder="全部探方" clearable style="width: 190px">
        <el-option v-for="trench in trenchState.trenches" :key="trench.id" :label="`${trench.area} · ${trench.code}`" :value="trench.id" />
      </el-select>
      <el-select v-model="filterCategory" placeholder="全部类别" clearable style="width: 130px">
        <el-option v-for="item in ARTIFACT_CATEGORIES" :key="item" :label="item" :value="item" />
      </el-select>
      <el-select v-model="filterStatus" placeholder="全部状态" clearable style="width: 140px">
        <el-option
          v-for="item in (['recorded', 'archived', 'held'] as ArtifactStatus[])"
          :key="item"
          :label="ARTIFACT_STATUS_LABEL[item]"
          :value="item"
        />
      </el-select>
      <el-tag type="info" effect="plain">命中 {{ visible.length }} 条 · 合计 {{ totalCount }} 件</el-tag>
      <el-tag type="warning" effect="plain">未归档 {{ pendingCount }}</el-tag>
      <el-tag type="danger" effect="plain">挂起 {{ heldCount }}</el-tag>
      <span class="toolbar-spacer" />
      <el-button type="primary" plain size="small" @click="reconcileNow">与基点记录对账</el-button>
      <el-button type="success" plain size="small" @click="archiveSelected">进库并冻结坐标</el-button>
      <el-button type="warning" plain size="small" @click="releaseSelected">测绘组已确认·解除挂起</el-button>
    </div>

    <el-table :data="visible" border stripe row-key="id" @selection-change="(rows: Artifact[]) => (selectedIds = rows.map((item) => item.id))">
      <el-table-column type="selection" width="42" />
      <el-table-column prop="code" label="器物编号" width="140" />
      <el-table-column label="探方" width="150">
        <template #default="{ row }: { row: Artifact }">
          <span class="mono">{{ trenchOf(row.stratumId) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="地层单位" width="110">
        <template #default="{ row }: { row: Artifact }">
          <span class="mono">{{ stratumOf(row.stratumId) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="深度区间" width="240">
        <template #default="{ row }: { row: Artifact }">
          <StratumDepthBar
            v-if="stratumState.strata.find((item) => item.id === row.stratumId)"
            :stratum="stratumState.strata.find((item) => item.id === row.stratumId)!"
            :length="170"
            :show-thickness="false"
          />
        </template>
      </el-table-column>
      <el-table-column prop="category" label="类别" width="90" />
      <el-table-column prop="count" label="件数" width="70" />
      <el-table-column prop="completeness" label="残整" width="80" />
      <el-table-column label="平面读数 (X,Y,Z)" width="160">
        <template #default="{ row }: { row: Artifact }">{{ row.x }}, {{ row.y }}, {{ row.z }}</template>
      </el-table-column>
      <el-table-column label="量算基点" width="130">
        <template #default="{ row }: { row: Artifact }">
          <span v-if="basePointOf(row)" class="mono">{{ basePointLabel(basePointOf(row)!) }}</span>
          <el-tag v-else type="danger" size="small" effect="plain">未挂基点</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="对账状态" width="110">
        <template #default="{ row }: { row: Artifact }">
          <el-tag :type="statusType(row.status)" size="small">{{ ARTIFACT_STATUS_LABEL[row.status] }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="进库冻结/重算坐标" min-width="230">
        <template #default="{ row }: { row: Artifact }">
          <div v-if="row.status === 'archived'" class="coord-cell">
            <span class="mono">进库 N{{ row.frozenNorth }} / E{{ row.frozenEast }}</span>
            <span class="muted">（基点再改不重算）</span>
          </div>
          <div v-else-if="globalOf(row)" class="coord-cell">
            <span class="mono">重算 N{{ globalOf(row)?.north }} / E{{ globalOf(row)?.east }}</span>
          </div>
          <el-tooltip v-else-if="row.holdNote" :content="row.holdNote" placement="top">
            <el-tag type="danger" size="small" effect="plain">{{ row.holdNote }}</el-tag>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column prop="date" label="出土日期" width="110" />
      <el-table-column prop="collector" label="提取人" width="80" />
      <el-table-column prop="tempLocation" label="临时存放" min-width="130" show-overflow-tooltip />
      <el-table-column label="操作" width="120" fixed="right">
        <template #default="{ row }: { row: Artifact }">
          <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.form-card {
  border-radius: 12px;
  margin-bottom: 16px;
}
.locked {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin: 10px 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: #f7f4ee;
}
.form {
  margin-top: 8px;
}
.actions {
  padding-left: 100px;
}
.bp-banner {
  margin-bottom: 10px;
}
.toolbar-spacer {
  flex: 1;
}
.coord-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
}
</style>
