<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Artifact, ArtifactCategory, ArtifactLedgerStatus, Completeness } from '@/types'
import {
  ARTIFACT_CATEGORIES,
  ARTIFACT_LEDGER_STATUS,
  ARTIFACT_STATUS_LABEL,
  COMPLETENESS,
  currentBasePoint
} from '@/types'
import StratumDepthBar from '@/components/common/StratumDepthBar.vue'
import UnitPicker from '@/components/common/UnitPicker.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { artifactStore, reconcileArtifact, stockArtifact, suspendArtifact } from '@/stores/artifactStore'
import { basePointStore } from '@/stores/basePointStore'
import { stratumStore } from '@/stores/stratumStore'
import { trenchStore } from '@/stores/trenchStore'
import { downloadCsv } from '@/utils/export'
import { uid } from '@/utils/id'

const artifactState = useStore(artifactStore)
const stratumState = useStore(stratumStore)
const trenchState = useStore(trenchStore)
const basePointState = useStore(basePointStore)

const pickTrenchId = ref('')
const pickStratumId = ref('')
const filterCategory = ref<ArtifactCategory | ''>('')
const filterStatus = ref<ArtifactLedgerStatus | ''>('')
const filterTrenchId = ref('')
const editingId = ref<string | null>(null)

const form = reactive({
  code: '',
  category: '陶器' as ArtifactCategory,
  count: 1,
  completeness: '残片' as Completeness,
  x: 2.4,
  y: 1.8,
  z: 0.5,
  date: new Date().toISOString().slice(0, 10),
  collector: '',
  tempLocation: ''
})

const lockedStratum = computed(() => stratumState.strata.find((item) => item.id === pickStratumId.value) ?? null)

/** 选中探方的当前基点版本（整理室按这个版本量读数） */
const currentBase = computed(() =>
  pickTrenchId.value ? currentBasePoint(basePointState.versions, pickTrenchId.value) : null
)

/** 正在编辑的器物是否已进库：坐标冻结，不可改 */
const editingStocked = computed(() =>
  Boolean(editingId.value && artifactState.artifacts.find((item) => item.id === editingId.value)?.status === 'stocked')
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

function trenchIdOf(stratumId: string): string {
  return stratumState.strata.find((item) => item.id === stratumId)?.trenchId ?? ''
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

function statusTagType(status: ArtifactLedgerStatus): 'success' | 'info' | 'danger' | 'warning' {
  switch (status) {
    case 'stocked':
      return 'success'
    case 'pending':
      return 'info'
    case 'suspended':
      return 'danger'
    case 'failed':
      return 'warning'
  }
}

function resetForm(): void {
  editingId.value = null
  form.code = ''
  form.category = '陶器'
  form.count = 1
  form.completeness = '残片'
  form.x = 2.4
  form.y = 1.8
  form.date = new Date().toISOString().slice(0, 10)
  form.collector = ''
  form.tempLocation = ''
  if (lockedStratum.value) {
    form.z = Math.round(((lockedStratum.value.topDepth + lockedStratum.value.bottomDepth) / 2) * 100) / 100
  }
}

function openEdit(artifact: Artifact): void {
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

  const existing = editingId.value ? artifactState.artifacts.find((item) => item.id === editingId.value) : null
  // 已进库器物坐标冻结：只允许改存放等档案信息，读数不能动
  if (existing?.status === 'stocked') {
    const row: Artifact = {
      ...existing,
      count: Number(form.count) || 1,
      completeness: form.completeness,
      date: form.date,
      collector: form.collector.trim(),
      tempLocation: form.tempLocation.trim()
    }
    await artifactStore.getState().save(row)
    ElMessage.success(`已进库器物 ${row.code} 档案已更新（坐标保持冻结）`)
    resetForm()
    return
  }

  if (!currentBase.value) {
    ElMessage.error('该探方尚无测绘组基点记录，无法登记读数，请先在「基点与对账」页建立基点')
    return
  }
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
    // 新读数按当前基点版本量取
    baseVersion: currentBase.value.version,
    status: existing?.status === 'suspended' || existing?.status === 'failed' ? existing.status : 'pending',
    frozenNorth: null,
    frozenEast: null,
    frozenElev: null,
    frozenVersion: null,
    stockedDate: '',
    holdReason: existing?.status === 'suspended' || existing?.status === 'failed' ? existing.holdReason : '',
    lastRecomputeAt: existing?.lastRecomputeAt ?? ''
  }
  await artifactStore.getState().save(row)
  ElMessage.success(`出土物 ${row.code} 已登记（读数依据基点 v${row.baseVersion}）`)
  resetForm()
}

/**
 * 进库：先和测绘基点记录对账，吻合才冻结进库；对不上挂起等测绘组确认，先不进库。
 */
async function stock(artifact: Artifact): Promise<void> {
  const trenchId = trenchIdOf(artifact.stratumId)
  await ElMessageBox.confirm(
    `确认将「${artifact.code}」进库？进库后坐标按基点 v${artifact.baseVersion} 冻结，测绘组再改基点也不会变化。`,
    '进库确认',
    { type: 'warning' }
  )
  const result = await stockArtifact(artifact, trenchId, basePointState.versions)
  if (!result.ok) {
    // 基点记录缺失等：挂起等测绘组确认，先不进库
    await suspendArtifact(artifact, result.reason ?? '对账依据缺失，挂起等测绘组确认')
    await artifactStore.getState().hydrate()
    ElMessage.error(`${result.reason}，已挂起`)
    return
  }
  await artifactStore.getState().hydrate()
  ElMessage.success(`「${artifact.code}」已进库，绝对坐标已冻结`)
}

/** 已进库器物事后对账（由基点勘误触发核对） */
async function checkStocked(artifact: Artifact): Promise<void> {
  const trenchId = trenchIdOf(artifact.stratumId)
  const mismatch = reconcileArtifact(artifact, trenchId, basePointState.versions)
  if (!mismatch) {
    ElMessage.success(`「${artifact.code}」冻结坐标与基点记录吻合`)
    return
  }
  try {
    await ElMessageBox.confirm(
      `「${artifact.code}」冻结坐标与基点记录对不上（ΔN ${(
        mismatch.frozen.north - mismatch.expected.north
      ).toFixed(3)} m，ΔE ${(mismatch.frozen.east - mismatch.expected.east).toFixed(3)} m）。挂起等测绘组确认？`,
      '对账不一致',
      { type: 'warning' }
    )
  } catch {
    return
  }
  // 已进库坐标不能改：另登记一条挂起意见，但保留冻结坐标
  await artifactStore.getState().save({
    ...artifact,
    status: 'suspended',
    holdReason: `进库后对账差异：N/E 与基点 v${artifact.frozenVersion} 重算结果不一致，待测绘组确认`
  })
  ElMessage.warning('已标记挂起，坐标仍保持冻结；请在「基点与对账」页等测绘组确认')
}

async function remove(artifact: Artifact): Promise<void> {
  await ElMessageBox.confirm(`确认删除出土物「${artifact.code}」？`, '删除确认', { type: 'warning' })
  await artifactStore.getState().remove(artifact.id)
  ElMessage.success('出土物已删除')
}

function exportList(): void {
  downloadCsv(
    '出土物清单.csv',
    visible.value.map((item) => ({
      code: item.code,
      stratum: stratumOf(item.stratumId),
      trench: trenchOf(item.stratumId),
      category: item.category,
      count: item.count,
      completeness: item.completeness,
      status: ARTIFACT_STATUS_LABEL[item.status],
      baseVersion: `v${item.baseVersion}`,
      x: item.x,
      y: item.y,
      z: item.z,
      frozen: item.frozenNorth === null ? '' : `${item.frozenNorth}, ${item.frozenEast}, ${item.frozenElev}`,
      date: item.date,
      collector: item.collector,
      tempLocation: item.tempLocation,
      holdReason: item.holdReason
    })) as unknown as Record<string, unknown>[],
    [
      { key: 'code', label: '器物编号' },
      { key: 'stratum', label: '地层单位' },
      { key: 'trench', label: '探方' },
      { key: 'category', label: '类别' },
      { key: 'count', label: '件数' },
      { key: 'completeness', label: '残整程度' },
      { key: 'status', label: '台账状态' },
      { key: 'baseVersion', label: '读数基点' },
      { key: 'x', label: 'X(m)' },
      { key: 'y', label: 'Y(m)' },
      { key: 'z', label: 'Z 深度(m)' },
      { key: 'frozen', label: '进库冻结绝对坐标' },
      { key: 'date', label: '出土日期' },
      { key: 'collector', label: '提取人' },
      { key: 'tempLocation', label: '存放位置' },
      { key: 'holdReason', label: '挂起/重算说明' }
    ]
  )
  ElMessage.success('出土物清单已导出')
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">出土物登记与清单（整理室台账）</h2>
        <p class="page-sub">
          平面读数按测绘组当前基点量取并记录基点版本；进库时按基点换算绝对坐标并冻结，进库前与测绘基点记录对账，对不上的挂起等测绘确认。
        </p>
      </div>
      <el-button @click="exportList">导出清单</el-button>
    </div>

    <el-card shadow="never" class="form-card">
      <template #header>
        <div class="form-head">
          <span>登记出土物（层位上下文锁定）</span>
          <el-tag v-if="currentBase" type="success" effect="plain" size="small">
            读数基准：基点 v{{ currentBase.version }}（N{{ currentBase.northing }} / E{{ currentBase.easting }}）
          </el-tag>
          <el-tag v-else type="danger" effect="plain" size="small">该探方缺测绘基点记录</el-tag>
          <el-tag v-if="editingStocked" type="warning" effect="plain" size="small">已进库：坐标冻结，仅可改档案信息</el-tag>
        </div>
      </template>
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
            <el-form-item label="平面读数 X(m)">
              <el-input-number
                v-model="form.x"
                :step="0.1"
                :controls="false"
                style="width: 100%"
                :disabled="editingStocked"
              />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="平面读数 Y(m)">
              <el-input-number
                v-model="form.y"
                :step="0.1"
                :controls="false"
                style="width: 100%"
                :disabled="editingStocked"
              />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="出土 Z 深度(m)">
              <el-input-number
                v-model="form.z"
                :step="0.01"
                :precision="2"
                :controls="false"
                style="width: 100%"
                :disabled="editingStocked"
              />
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
            <el-form-item label="存放位置">
              <el-input v-model="form.tempLocation" placeholder="如 工地临时柜 A-2 / 库房 3 号架" />
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
        <el-option v-for="item in ARTIFACT_LEDGER_STATUS" :key="item" :label="ARTIFACT_STATUS_LABEL[item]" :value="item" />
      </el-select>
      <el-tag type="info" effect="plain">命中 {{ visible.length }} 条 · 合计 {{ totalCount }} 件</el-tag>
    </div>

    <el-table :data="visible" border stripe row-key="id">
      <el-table-column prop="code" label="器物编号" width="140" />
      <el-table-column label="探方" width="140">
        <template #default="{ row }: { row: Artifact }">
          <span class="mono">{{ trenchOf(row.stratumId) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="地层单位" width="100">
        <template #default="{ row }: { row: Artifact }">
          <span class="mono">{{ stratumOf(row.stratumId) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="台账状态" width="110">
        <template #default="{ row }: { row: Artifact }">
          <el-tag :type="statusTagType(row.status)" size="small">{{ ARTIFACT_STATUS_LABEL[row.status] }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="读数基点" width="90">
        <template #default="{ row }: { row: Artifact }">v{{ row.baseVersion }}</template>
      </el-table-column>
      <el-table-column prop="category" label="类别" width="80" />
      <el-table-column prop="count" label="件数" width="70" />
      <el-table-column prop="completeness" label="残整" width="80" />
      <el-table-column label="平面读数 (X,Y,Z)" width="160">
        <template #default="{ row }: { row: Artifact }">{{ row.x }}, {{ row.y }}, {{ row.z }}</template>
      </el-table-column>
      <el-table-column label="进库冻结坐标" min-width="170" show-overflow-tooltip>
        <template #default="{ row }: { row: Artifact }">
          <span v-if="row.frozenNorth !== null" class="mono">
            N{{ row.frozenNorth }} / E{{ row.frozenEast }} · 高程 {{ row.frozenElev }}（v{{ row.frozenVersion }}）
          </span>
          <span v-else class="muted">未进库</span>
        </template>
      </el-table-column>
      <el-table-column prop="tempLocation" label="存放位置" min-width="130" show-overflow-tooltip />
      <el-table-column label="说明" min-width="150" show-overflow-tooltip>
        <template #default="{ row }: { row: Artifact }">
          <span :class="{ 'hold-text': row.holdReason }">{{ row.holdReason || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="{ row }: { row: Artifact }">
          <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
          <el-button
            v-if="row.status === 'pending' || row.status === 'failed'"
            link
            type="success"
            size="small"
            @click="stock(row)"
          >
            进库
          </el-button>
          <el-button v-if="row.status === 'stocked'" link type="warning" size="small" @click="checkStocked(row)">
            对账
          </el-button>
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
.form-head {
  display: flex;
  align-items: center;
  gap: 10px;
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
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.muted {
  color: #a59a8b;
}
.hold-text {
  color: #c45656;
}
</style>
