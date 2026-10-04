<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Trench } from '@/types'
import type { BasePoint } from '@/types/basepoint'
import { TRENCH_SIZES, basePointLabel, findTrenchConflict, isBasePointComplete, parseBasePointNote, trenchKey } from '@/types'
import TrenchTag from '@/components/common/TrenchTag.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { trenchStore } from '@/stores/trenchStore'
import { stratumStore } from '@/stores/stratumStore'
import { artifactStore } from '@/stores/artifactStore'
import { relationStore } from '@/stores/relationStore'
import { basePointStore } from '@/stores/basePointStore'
import { rebaseArtifact } from '@/utils/reconcile'
import { uid } from '@/utils/id'

const trenchState = useStore(trenchStore)
const stratumState = useStore(stratumStore)
const artifactState = useStore(artifactStore)
const relationState = useStore(relationStore)
const basePointState = useStore(basePointStore)

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const filterArea = ref('')

/** 基点台账弹窗当前查看的探方 */
const ledgerTrench = ref<Trench | null>(null)
const bpDialogVisible = ref(false)
const bpForm = reactive({
  north: 0 as number | null,
  east: 0 as number | null,
  elevation: null as number | null,
  note: '',
  recorder: '',
  effectiveDate: new Date().toISOString().slice(0, 10)
})
/** 旧数据补录目标（坐标不完整的基点版本） */
const backfillTarget = ref<BasePoint | null>(null)
const backfillForm = reactive({ north: 0 as number | null, east: 0 as number | null, note: '' })

const form = reactive({
  code: '',
  area: '',
  size: '5×5 米' as Trench['size'],
  basePoint: '',
  baseNorth: null as number | null,
  baseEast: null as number | null,
  baseRecorder: '',
  openLayer: '第①层',
  startDate: new Date().toISOString().slice(0, 10),
  endDate: '',
  leader: '',
  wallNote: '',
  backfilled: false
})

const areas = computed(() => Array.from(new Set(trenchState.trenches.map((item) => item.area))))
const visible = computed(() =>
  filterArea.value ? trenchState.trenches.filter((item) => item.area === filterArea.value) : trenchState.trenches
)

watch(
  () => trenchState.trenches.length,
  () => {
    if (!form.area && trenchState.trenches.length > 0) {
      form.area = trenchState.trenches[0].area
    }
  },
  { immediate: true }
)

/** 单位数与出土物件数 */
function unitsOf(trenchId: string): number {
  return stratumState.strata.filter((item) => item.trenchId === trenchId).length
}

function artifactsOf(trenchId: string): number {
  const unitIds = stratumState.strata.filter((item) => item.trenchId === trenchId).map((item) => item.id)
  return artifactState.artifacts.filter((item) => unitIds.includes(item.stratumId)).reduce((sum, item) => sum + item.count, 0)
}

function relationsOf(trenchId: string): number {
  const unitIds = stratumState.strata.filter((item) => item.trenchId === trenchId).map((item) => item.id)
  return relationState.relations.filter((item) => unitIds.includes(item.unitAId) || unitIds.includes(item.unitBId)).length
}

/** 发掘进度状态 */
function progressOf(trench: Trench): { label: string; type: 'success' | 'warning' | 'info' } {
  if (trench.backfilled) return { label: '已回填', type: 'info' }
  if (unitsOf(trench.id) === 0) return { label: '待发掘', type: 'warning' }
  if (trench.endDate) return { label: '发掘完成', type: 'success' }
  return { label: '发掘中', type: 'success' }
}

function resetForm(): void {
  editingId.value = null
  form.code = ''
  form.area = trenchState.trenches[0]?.area ?? ''
  form.size = '5×5 米'
  form.basePoint = ''
  form.baseNorth = null
  form.baseEast = null
  form.baseRecorder = ''
  form.openLayer = '第①层'
  form.startDate = new Date().toISOString().slice(0, 10)
  form.endDate = ''
  form.leader = ''
  form.wallNote = ''
  form.backfilled = false
}

function openCreate(): void {
  resetForm()
  dialogVisible.value = true
}

function openEdit(trench: Trench): void {
  editingId.value = trench.id
  const active = basePointState.activeOf(trench.id)
  Object.assign(form, {
    code: trench.code,
    area: trench.area,
    size: trench.size,
    basePoint: trench.basePoint,
    baseNorth: active?.north ?? null,
    baseEast: active?.east ?? null,
    baseRecorder: active?.recorder ?? '',
    openLayer: trench.openLayer,
    startDate: trench.startDate,
    endDate: trench.endDate,
    leader: trench.leader,
    wallNote: trench.wallNote,
    backfilled: trench.backfilled
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  if (!form.code.trim() || !form.area.trim()) {
    ElMessage.warning('探方号与发掘区必填')
    return
  }
  const candidate = { id: editingId.value ?? uid('tr'), area: form.area.trim(), code: form.code.trim().toUpperCase() }
  const conflict = findTrenchConflict(trenchState.trenches, candidate)
  if (conflict) {
    ElMessage.error(`「${trenchKey(candidate)}」已存在（同发掘区探方号必须唯一）`)
    return
  }
  const row: Trench = {
    id: candidate.id,
    code: candidate.code,
    area: candidate.area,
    size: form.size,
    basePoint: form.basePoint.trim(),
    openLayer: form.openLayer.trim(),
    startDate: form.startDate,
    endDate: form.endDate,
    leader: form.leader.trim(),
    wallNote: form.wallNote.trim(),
    backfilled: form.backfilled
  }
  await trenchStore.getState().save(row)
  // 新探方：测绘组基点建立 v1（坐标允许暂缺，之后在基点台账补录；改基点只能追加新版本）
  if (!editingId.value) {
    await basePointStore.getState().addVersion(row.id, {
      north: form.baseNorth,
      east: form.baseEast,
      elevation: null,
      note: form.basePoint || (form.baseNorth !== null && form.baseEast !== null ? `N${form.baseNorth} / E${form.baseEast}` : ''),
      recorder: form.baseRecorder,
      effectiveDate: form.startDate
    })
  }
  ElMessage.success(`探方 ${trenchKey(row)} 已保存`)
  dialogVisible.value = false
}

async function remove(trench: Trench): Promise<void> {
  const units = unitsOf(trench.id)
  if (units > 0) {
    ElMessage.error(`${trenchKey(trench)} 下仍有 ${units} 个地层单位，请先清理下级记录`)
    return
  }
  await ElMessageBox.confirm(`确认删除探方「${trenchKey(trench)}」？`, '删除确认', { type: 'warning' })
  await trenchStore.getState().remove(trench.id)
  ElMessage.success('探方已删除')
}

/** 该探方基点台账（测绘组那份） */
const ledgerBasePoints = computed<BasePoint[]>(() =>
  ledgerTrench.value ? basePointState.listByTrench(ledgerTrench.value.id) : []
)

/** 当前生效基点 */
const activeBasePoint = computed<BasePoint | null>(() =>
  ledgerTrench.value ? basePointState.activeOf(ledgerTrench.value.id) : null
)

/** 探方卡片上显示的基点文字与基点台账是否一致（对账提示） */
function basePointConsistent(trench: Trench): boolean {
  const active = basePointState.activeOf(trench.id)
  if (!active) return false
  const parsed = parseBasePointNote(trench.basePoint)
  if (parsed.north === null && parsed.east === null) return true // 卡片只作文字描述时不强制
  return (
    (parsed.north === null || parsed.north === active.north) &&
    (parsed.east === null || parsed.east === active.east)
  )
}

function openLedger(trench: Trench): void {
  ledgerTrench.value = trench
  bpDialogVisible.value = true
  resetBpForm()
  backfillTarget.value = null
}

function resetBpForm(): void {
  const active = activeBasePoint.value
  bpForm.north = active?.north ?? 0
  bpForm.east = active?.east ?? 0
  bpForm.elevation = active?.elevation ?? null
  bpForm.note = ''
  bpForm.recorder = ''
  bpForm.effectiveDate = new Date().toISOString().slice(0, 10)
}

/** 测绘组改基点：追加新版本，并重算该探方未归档器物读数（已进库坐标不动） */
async function submitBasePoint(): Promise<void> {
  if (!ledgerTrench.value) return
  if (typeof bpForm.north !== 'number' || typeof bpForm.east !== 'number') {
    ElMessage.warning('请填写完整的基点北/东坐标，换算基准缺失时器物无法重算')
    return
  }
  const trench = ledgerTrench.value
  const { added, previous } = await basePointStore.getState().addVersion(trench.id, {
    north: Number(bpForm.north),
    east: Number(bpForm.east),
    elevation: bpForm.elevation,
    note: bpForm.note || `N${bpForm.north} / E${bpForm.east}`,
    recorder: bpForm.recorder,
    effectiveDate: bpForm.effectiveDate
  })

  // 仅整理室自己那份：把该探方未归档（含挂起）器物读数各自按其依据基点换算到新版本；已进库保持冻结
  {
    const unitIds = new Set(stratumState.strata.filter((item) => item.trenchId === trench.id).map((item) => item.id))
    const pending = artifactState.artifacts.filter(
      (item) => unitIds.has(item.stratumId) && item.status !== 'archived'
    )
    const rebased = pending.map((item) => {
      const referenced =
        (item.basePointId ? basePointState.basePoints.find((bp) => bp.id === item.basePointId) : undefined) ?? previous
      return referenced ? rebaseArtifact(item, referenced, added) : item
    })
    await artifactStore.getState().bulkSave(rebased)
    const moved = rebased.filter((item) => item.status === 'recorded').length
    const held = rebased.filter((item) => item.status === 'held').length
    ElMessage.success(`基点已更新为 ${basePointLabel(added)}：${moved} 件未归档读数已按新基点重算${held ? `，${held} 件基点未补齐暂挂起` : ''}；已进库坐标不变`)
  }
  bpDialogVisible.value = false
}

function openBackfill(point: BasePoint): void {
  backfillTarget.value = point
  backfillForm.north = null
  backfillForm.east = null
  backfillForm.note = point.note
}

/** 旧数据升级后基点坐标仍缺：补录只写测绘组那份基点记录 */
async function submitBackfill(): Promise<void> {
  if (!backfillTarget.value) return
  if (typeof backfillForm.north !== 'number' || typeof backfillForm.east !== 'number') {
    ElMessage.warning('请填写北/东坐标数值')
    return
  }
  try {
    await basePointStore.getState().backfill(backfillTarget.value.id, {
      north: Number(backfillForm.north),
      east: Number(backfillForm.east),
      note: backfillForm.note
    })
    ElMessage.success('基点坐标已按当时记录补齐，相关挂起器物可重新对账')
    backfillTarget.value = null
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">探方清单</h2>
        <p class="page-sub">
          按「发掘区-探方号」校验唯一性；卡片展示地层单位数、出土物件数、层位关系数与发掘进度状态。
        </p>
      </div>
      <el-button type="primary" @click="openCreate">
        <el-icon><Plus /></el-icon>新建探方
      </el-button>
    </div>

    <div class="toolbar">
      <el-select v-model="filterArea" placeholder="全部发掘区" clearable style="width: 180px">
        <el-option v-for="area in areas" :key="area" :label="area" :value="area" />
      </el-select>
      <el-tag effect="plain">命中 {{ visible.length }} / {{ trenchState.trenches.length }} 个探方</el-tag>
    </div>

    <div class="card-grid">
      <el-card v-for="trench in visible" :key="trench.id" shadow="hover" class="trench-card">
        <div class="card-top">
          <TrenchTag :trench="trench" />
          <el-tag :type="progressOf(trench).type" size="small" effect="plain">{{ progressOf(trench).label }}</el-tag>
        </div>
        <div class="metrics">
          <div class="metric"><span>地层单位</span><b>{{ unitsOf(trench.id) }}</b></div>
          <div class="metric"><span>出土物件数</span><b>{{ artifactsOf(trench.id) }}</b></div>
          <div class="metric"><span>层位关系</span><b>{{ relationsOf(trench.id) }}</b></div>
          <div class="metric"><span>规格</span><b>{{ trench.size }}</b></div>
        </div>
        <el-descriptions :column="1" size="small" border class="desc">
          <el-descriptions-item label="基点坐标">
            <span :class="{ 'bp-mismatch': !basePointConsistent(trench) }">{{ trench.basePoint || '—' }}</span>
            <el-tag v-if="!basePointConsistent(trench)" type="danger" size="small" effect="plain" class="bp-flag">
              与基点台账不符
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="开口层位">{{ trench.openLayer || '—' }}</el-descriptions-item>
          <el-descriptions-item label="发掘日期">
            {{ trench.startDate }} ~ {{ trench.endDate || '进行中' }}
          </el-descriptions-item>
          <el-descriptions-item label="负责人">{{ trench.leader || '—' }}</el-descriptions-item>
          <el-descriptions-item label="四壁方向备注">{{ trench.wallNote || '—' }}</el-descriptions-item>
        </el-descriptions>
        <div class="card-actions">
          <el-button size="small" @click="openEdit(trench)">编辑</el-button>
          <el-button size="small" @click="openLedger(trench)">基点台账</el-button>
          <el-button size="small" @click="trenchStore.getState().setBackfilled(trench.id, !trench.backfilled)">
            {{ trench.backfilled ? '取消回填标记' : '标记已回填' }}
          </el-button>
          <el-button size="small" type="danger" plain @click="remove(trench)">删除</el-button>
        </div>
      </el-card>
      <el-empty v-if="visible.length === 0" description="暂无探方，先新建一个探方" />
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑探方' : '新建探方'" width="640px">
      <el-form label-width="110px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="发掘区" required>
              <el-input v-model="form.area" placeholder="如 Ⅱ区" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="探方号" required>
              <el-input v-model="form.code" placeholder="如 T0501" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="规格">
              <el-select v-model="form.size" style="width: 100%">
                <el-option v-for="item in TRENCH_SIZES" :key="item" :label="item" :value="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="基点坐标">
              <el-input v-model="form.basePoint" placeholder="如 N1200 / E3000" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-alert
          v-if="editingId"
          type="warning"
          :closable="false"
          show-icon
          class="bp-tip"
          title="基点坐标与换算基准由测绘组在「基点台账」维护：改基点会追加新版本并重算未归档器物读数，这里不再直接改动基点。"
        />
        <el-row v-else :gutter="12">
          <el-col :span="8">
            <el-form-item label="基点 N(m)">
              <el-input-number v-model="form.baseNorth" :step="0.1" :controls="false" placeholder="可暂缺" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="基点 E(m)">
              <el-input-number v-model="form.baseEast" :step="0.1" :controls="false" placeholder="可暂缺" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="测绘登记人">
              <el-input v-model="form.baseRecorder" placeholder="测绘组" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="开口层位">
              <el-input v-model="form.openLayer" placeholder="如 第①层" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="负责人">
              <el-input v-model="form.leader" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="发掘起始">
              <el-date-picker v-model="form.startDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="发掘结束">
              <el-date-picker v-model="form.endDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="四壁备注">
          <el-input v-model="form.wallNote" type="textarea" :rows="2" placeholder="如 北壁、东壁保存较好；南壁被现代扰坑破坏" />
        </el-form-item>
        <el-form-item label="是否已回填">
          <el-switch v-model="form.backfilled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 测绘组基点台账：只追加版本、旧记录补录，不覆盖历史 -->
    <el-dialog
      v-model="bpDialogVisible"
      :title="ledgerTrench ? `基点台账 · ${trenchKey(ledgerTrench)}（测绘组）` : '基点台账'"
      width="720px"
    >
      <el-alert
        type="info"
        :closable="false"
        show-icon
        class="bp-tip"
        title="基点坐标与换算基准由测绘组维护：改基点只追加新版本，历史版本保留作对账依据。保存后整理室未归档器物读数自动按新基点重算，已进库坐标冻结不变。"
      />

      <el-table :data="ledgerBasePoints" border stripe size="small" class="bp-table">
        <el-table-column label="版本" width="80">
          <template #default="{ row }: { row: BasePoint }">
            <el-tag v-if="row.active" type="success" size="small" effect="dark">v{{ row.version }} · 生效</el-tag>
            <el-tag v-else size="small" effect="plain">v{{ row.version }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="基点坐标（N / E）" width="180">
          <template #default="{ row }: { row: BasePoint }">
            <span v-if="isBasePointComplete(row)" class="mono">N{{ row.north }} / E{{ row.east }}</span>
            <el-button v-else link type="warning" size="small" @click="openBackfill(row)">坐标待补录</el-button>
          </template>
        </el-table-column>
        <el-table-column prop="elevation" label="高程(m)" width="90">
          <template #default="{ row }: { row: BasePoint }">{{ row.elevation ?? '—' }}</template>
        </el-table-column>
        <el-table-column prop="effectiveDate" label="启用日期" width="110" />
        <el-table-column prop="recorder" label="登记人" width="100" />
        <el-table-column prop="note" label="测绘记录" min-width="140" show-overflow-tooltip />
      </el-table>

      <el-divider content-position="left">测绘组改基点（追加新版本）</el-divider>
      <el-form label-width="100px">
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="北坐标 N(m)" required>
              <el-input-number v-model="bpForm.north" :step="0.1" :controls="false" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="东坐标 E(m)" required>
              <el-input-number v-model="bpForm.east" :step="0.1" :controls="false" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="高程(m)">
              <el-input-number v-model="bpForm.elevation" :step="0.1" :controls="false" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="启用日期">
              <el-date-picker v-model="bpForm.effectiveDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="登记人">
              <el-input v-model="bpForm.recorder" placeholder="测绘组" />
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="测绘记录">
              <el-input v-model="bpForm.note" placeholder="如 基点西移 0.5m，复核后 N1199.5 / E3000" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>

      <template #footer>
        <el-button @click="bpDialogVisible = false">关闭</el-button>
        <el-button type="primary" @click="submitBasePoint">保存新版本并重算未归档读数</el-button>
      </template>
    </el-dialog>

    <!-- 旧数据基点坐标补录 -->
    <el-dialog v-model="backfillTarget" title="按当时基点补齐坐标（旧数据升级）" width="460px" append-to-body>
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        class="bp-tip"
        title="仅当该版本基点坐标缺失时补录；坐标已完整的基点要修正只能追加新版本，不得覆盖测绘记录。"
      />
      <el-form label-width="100px">
        <el-form-item label="北坐标 N(m)" required>
          <el-input-number v-model="backfillForm.north" :step="0.1" :controls="false" style="width: 100%" />
        </el-form-item>
        <el-form-item label="东坐标 E(m)" required>
          <el-input-number v-model="backfillForm.east" :step="0.1" :controls="false" style="width: 100%" />
        </el-form-item>
        <el-form-item label="测绘记录">
          <el-input v-model="backfillForm.note" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="backfillTarget = null">取消</el-button>
        <el-button type="primary" @click="submitBackfill">补齐坐标</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.trench-card {
  border-radius: 12px;
}
.card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.metrics {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  margin-bottom: 12px;
}
.metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #f7f4ee;
  font-size: 12px;
  color: #7d7264;
}
.metric b {
  font-size: 14px;
  color: #3c2f1f;
}
.desc {
  margin-bottom: 12px;
}
.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.bp-mismatch {
  color: #c0392b;
  font-weight: 600;
}
.bp-flag {
  margin-left: 6px;
}
.bp-tip {
  margin-bottom: 12px;
}
.bp-table {
  margin-bottom: 8px;
}
</style>
