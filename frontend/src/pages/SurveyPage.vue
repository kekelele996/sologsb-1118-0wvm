<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type {
  Artifact,
  BasePointVersion,
  SuspendResolution,
  Trench
} from '@/types'
import {
  ARTIFACT_STATUS_LABEL,
  SUSPEND_RESOLUTIONS,
  currentBasePoint,
  formatBasePoint,
  parseBasePointText,
  versionsOfTrench
} from '@/types'
import { useStore } from '@/hooks/usePersistentStore'
import { trenchStore } from '@/stores/trenchStore'
import { stratumStore } from '@/stores/stratumStore'
import { artifactStore, buildStratumTrenchMap, reconcileArtifact, resolveSuspendedArtifact } from '@/stores/artifactStore'
import { basePointStore } from '@/stores/basePointStore'
import { uid } from '@/utils/id'

const trenchState = useStore(trenchStore)
const stratumState = useStore(stratumStore)
const artifactState = useStore(artifactStore)
const basePointState = useStore(basePointStore)

const route = useRoute()
const pickTrenchId = ref('')
const baseDialogVisible = ref(false)
const suspendTarget = ref<Artifact | null>(null)

const baseForm = reactive({
  baseText: '',
  elevation: 0,
  effectiveDate: new Date().toISOString().slice(0, 10),
  surveyor: '',
  note: ''
})

const suspendForm = reactive<{ resolution: SuspendResolution; comment: string }>({
  resolution: '确认进库',
  comment: ''
})

watch(
  () => [trenchState.trenches.length, route.query.trench] as const,
  () => {
    const queryTrench = typeof route.query.trench === 'string' ? route.query.trench : ''
    if (queryTrench && trenchState.trenches.some((item) => item.id === queryTrench)) {
      pickTrenchId.value = queryTrench
    } else if (!pickTrenchId.value && trenchState.trenches.length > 0) {
      pickTrenchId.value = trenchState.trenches[0].id
    }
  },
  { immediate: true }
)

const trench = computed<Trench | undefined>(() => trenchState.trenches.find((item) => item.id === pickTrenchId.value))
const versions = computed(() =>
  pickTrenchId.value ? versionsOfTrench(basePointState.versions, pickTrenchId.value) : []
)
const current = computed(() =>
  pickTrenchId.value ? currentBasePoint(basePointState.versions, pickTrenchId.value) : null
)

const stratumMap = computed(() => buildStratumTrenchMap(stratumState.strata))
const trenchArtifacts = computed(() => {
  const unitIds = new Set(
    stratumState.strata.filter((item) => item.trenchId === pickTrenchId.value).map((item) => item.id)
  )
  return artifactState.artifacts.filter((item) => unitIds.has(item.stratumId))
})

const statusCount = computed(() => {
  const count = { pending: 0, stocked: 0, suspended: 0, failed: 0 }
  for (const item of trenchArtifacts.value) count[item.status] += 1
  return count
})

/** 已进库器物按测绘基点记录对账 */
const reconcileRows = computed(() =>
  trenchArtifacts.value
    .filter((item) => item.status === 'stocked')
    .map((item) => ({
      artifact: item,
      diff: reconcileArtifact(item, pickTrenchId.value, basePointState.versions)
    }))
)

const mismatchCount = computed(() => reconcileRows.value.filter((row) => row.diff).length)

const unstockedRows = computed(() => trenchArtifacts.value.filter((item) => item.status !== 'stocked'))

const tagType = (status: Artifact['status']): 'success' | 'warning' | 'danger' | 'info' => {
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

function stratumCodeOf(stratumId: string): string {
  return stratumState.strata.find((item) => item.id === stratumId)?.code ?? '未知单位'
}

/** 打开「改基点」对话框：预填当前坐标，方便在原值上改 */
function openBaseDialog(): void {
  const cur = current.value
  baseForm.baseText = cur ? formatBasePoint(cur) : (trench.value?.basePoint ?? '')
  baseForm.elevation = cur?.elevation ?? 0
  baseForm.effectiveDate = new Date().toISOString().slice(0, 10)
  baseForm.surveyor = cur?.surveyor ?? ''
  baseForm.note = ''
  baseDialogVisible.value = true
}

async function submitBase(): Promise<void> {
  let parsed: { northing: number; easting: number }
  try {
    parsed = parseBasePointText(baseForm.baseText)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '基点坐标无法解析')
    return
  }
  const cur = current.value
  if (cur && cur.northing === parsed.northing && cur.easting === parsed.easting && cur.elevation === baseForm.elevation) {
    ElMessage.warning('新基点坐标与当前生效版本一致，无需改版')
    return
  }
  await ElMessageBox.confirm(
    '改版后旧版本自动归档；本探方未进库器物读数需要随后执行「按新基点重算」。确认改基点？',
    '测绘组改基点',
    { type: 'warning' }
  )
  await basePointStore.getState().changeBase(
    pickTrenchId.value,
    {
      northing: parsed.northing,
      easting: parsed.easting,
      elevation: Number(baseForm.elevation) || 0,
      effectiveDate: baseForm.effectiveDate,
      surveyor: baseForm.surveyor.trim(),
      note: baseForm.note.trim()
    },
    () => uid('bp')
  )
  ElMessage.success('基点已改版，旧版本归档；请对未进库器物执行重算')
  baseDialogVisible.value = false
}

async function recomputeAll(): Promise<void> {
  const result = await artifactStore
    .getState()
    .recomputeTrench(pickTrenchId.value, stratumMap.value, basePointState.versions)
  if (result.failed > 0) {
    ElMessage.warning(`重算完成：成功 ${result.recomputed} 件，失败 ${result.failed} 件（可点「只重试失败件」）`)
  } else {
    ElMessage.success(`重算完成：${result.recomputed} 件未进库读数已按新基点换算`)
  }
}

async function retryFailed(): Promise<void> {
  const result = await artifactStore
    .getState()
    .retryFailed(pickTrenchId.value, stratumMap.value, basePointState.versions)
  if (result.recomputed === 0 && result.failed === 0) {
    ElMessage.info('本探方没有重算失败的器物')
  } else if (result.failed > 0) {
    ElMessage.warning(`重试完成：恢复 ${result.recomputed} 件，仍失败 ${result.failed} 件`)
  } else {
    ElMessage.success(`重试成功：${result.recomputed} 件读数已恢复为未归档`)
  }
}

async function correctVersion(version: BasePointVersion): Promise<void> {
  const { value } = await ElMessageBox.prompt('校正该版本基点坐标（留痕说明必填）', '测绘记录勘误', {
    inputValue: formatBasePoint(version),
    inputPlaceholder: 'N1200 / E3000'
  })
  const parsed = parseBasePointText(value)
  const { value: note } = await ElMessageBox.prompt('勘误说明', '测绘记录勘误', {
    inputValue: version.note,
    inputType: 'textarea'
  })
  await basePointStore.getState().correctBase(version.id, {
    northing: parsed.northing,
    easting: parsed.easting,
    note: `[勘误] ${note}`
  })
  ElMessage.success('基点版本已校正，进库器物将据此重新对账')
}

function openSuspend(artifact: Artifact): void {
  suspendTarget.value = artifact
  suspendForm.resolution = '确认进库'
  suspendForm.comment = ''
}

async function submitSuspend(): Promise<void> {
  if (!suspendTarget.value) return
  if (!suspendForm.comment.trim()) {
    ElMessage.warning('请填写测绘组确认意见')
    return
  }
  const result = await resolveSuspendedArtifact(
    suspendTarget.value,
    pickTrenchId.value,
    suspendForm.resolution,
    suspendForm.comment.trim(),
    basePointState.versions
  )
  if (!result.ok) {
    ElMessage.error(result.reason ?? '处理失败')
    return
  }
  await artifactStore.getState().hydrate()
  ElMessage.success(suspendForm.resolution === '确认进库' ? '已按测绘确认冻结进库' : '已退回，待整理室重新量取')
  suspendTarget.value = null
}

function formatDiff(delta: number): string {
  return `${delta >= 0 ? '+' : ''}${(Math.round(delta * 1000) / 1000).toFixed(3)}`
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">基点与对账（测绘台账 ↔ 整理室读数）</h2>
        <p class="page-sub">
          测绘组管基点坐标与换算基准（改版留痕、旧版归档）；整理室管器物编号、平面读数与存放。改基点后未进库读数按新基点重算，已进库坐标冻结、只与基点记录对账；对不上的挂起，等测绘组确认，先不进库。
        </p>
      </div>
    </div>

    <div class="toolbar">
      <el-select v-model="pickTrenchId" placeholder="选择探方" style="width: 240px">
        <el-option
          v-for="item in trenchState.trenches"
          :key="item.id"
          :label="`${item.area} · ${item.code}`"
          :value="item.id"
        />
      </el-select>
      <el-tag v-if="current" type="success" effect="dark">
        当前基点 v{{ current.version }}：{{ formatBasePoint(current) }} · 高程 {{ current.elevation }} m
      </el-tag>
    </div>

    <el-row :gutter="16">
      <!-- 测绘组那份：基点版本台账 -->
      <el-col :span="12">
        <el-card shadow="never" class="ledger-card">
          <template #header>
            <div class="card-head">
              <span>基点版本台账（测绘组持）</span>
              <el-button type="primary" size="small" :disabled="!trench" @click="openBaseDialog">改基点（升版）</el-button>
            </div>
          </template>
          <el-table :data="versions" border size="small" row-key="id">
            <el-table-column label="版本" width="70">
              <template #default="{ row }: { row: BasePointVersion }">
                v{{ row.version }}
                <el-tag v-if="row.current" type="success" size="small" effect="plain">现行</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="N / E（米）" width="150">
              <template #default="{ row }: { row: BasePointVersion }">{{ formatBasePoint(row) }}</template>
            </el-table-column>
            <el-table-column prop="elevation" label="高程" width="80" />
            <el-table-column prop="effectiveDate" label="生效日期" width="110" />
            <el-table-column prop="surveyor" label="测绘人" width="80" />
            <el-table-column prop="note" label="改版/勘误说明" min-width="160" show-overflow-tooltip />
            <el-table-column label="操作" width="80" fixed="right">
              <template #default="{ row }: { row: BasePointVersion }">
                <el-button link type="primary" size="small" @click="correctVersion(row)">勘误</el-button>
              </template>
            </el-table-column>
          </el-table>
          <p class="hint">坐标换算基准：新读数 = 旧读数 +（旧基点 − 新基点）。历史版本不删除，进库器物始终按其冻结时的版本对账。</p>

          <el-divider content-position="left">未进库读数重算（整理室持，改基点后执行）</el-divider>
          <div class="recompute-bar">
            <el-button type="warning" :disabled="!trench" @click="recomputeAll">按当前基点重算未进库读数</el-button>
            <el-button :disabled="!trench || statusCount.failed === 0" @click="retryFailed">
              只重试失败件（{{ statusCount.failed }}）
            </el-button>
          </div>
          <div class="status-tags">
            <el-tag effect="plain">未归档 {{ statusCount.pending }}</el-tag>
            <el-tag type="success" effect="plain">已进库 {{ statusCount.stocked }}</el-tag>
            <el-tag type="danger" effect="plain">挂起 {{ statusCount.suspended }}</el-tag>
            <el-tag type="warning" effect="plain">重算失败 {{ statusCount.failed }}</el-tag>
          </div>
        </el-card>
      </el-col>

      <!-- 对账：已进库冻结坐标 vs 基点记录 -->
      <el-col :span="12">
        <el-card shadow="never" class="ledger-card">
          <template #header>
            <div class="card-head">
              <span>进库器物对账（坐标冻结，不随基点变化）</span>
              <el-tag :type="mismatchCount > 0 ? 'danger' : 'success'" effect="dark">
                {{ mismatchCount > 0 ? `${mismatchCount} 件对不上` : '全部吻合' }}
              </el-tag>
            </div>
          </template>
          <el-table :data="reconcileRows" border size="small" row-key="id" max-height="300">
            <el-table-column prop="artifact.code" label="器物编号" width="130" />
            <el-table-column label="冻结版本" width="80">
              <template #default="{ row }">v{{ row.artifact.frozenVersion }}</template>
            </el-table-column>
            <el-table-column label="进库冻结 N/E（米）" min-width="180">
              <template #default="{ row }">
                {{ row.artifact.frozenNorth }}, {{ row.artifact.frozenEast }}
              </template>
            </el-table-column>
            <el-table-column label="按基点重算 N/E" min-width="180">
              <template #default="{ row }">{{ row.diff ? `${row.diff.expected.north}, ${row.diff.expected.east}` : '—' }}</template>
            </el-table-column>
            <el-table-column label="对账" width="100">
              <template #default="{ row }">
                <el-tag v-if="!row.diff" type="success" size="small">吻合</el-tag>
                <div v-else class="diff-cell">
                  <el-tag type="danger" size="small">差异</el-tag>
                  <span class="mono">
                    ΔN {{ formatDiff(row.diff.frozen.north - row.diff.expected.north) }} · ΔE
                    {{ formatDiff(row.diff.frozen.east - row.diff.expected.east) }}
                  </span>
                </div>
              </template>
            </el-table-column>
          </el-table>

          <el-divider content-position="left">未进库 / 挂起 / 失败件（整理室那份）</el-divider>
          <el-table :data="unstockedRows" border size="small" row-key="id" max-height="260">
            <el-table-column prop="code" label="器物编号" width="130" />
            <el-table-column label="单位" width="80">
              <template #default="{ row }: { row: Artifact }">{{ stratumCodeOf(row.stratumId) }}</template>
            </el-table-column>
            <el-table-column label="读数依据" width="90">
              <template #default="{ row }: { row: Artifact }">基点 v{{ row.baseVersion }}</template>
            </el-table-column>
            <el-table-column label="读数 X,Y,Z" width="150">
              <template #default="{ row }: { row: Artifact }">{{ row.x }}, {{ row.y }}, {{ row.z }}</template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }: { row: Artifact }">
                <el-tag :type="tagType(row.status)" size="small">{{ ARTIFACT_STATUS_LABEL[row.status] }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="holdReason" label="原因 / 测绘意见" min-width="160" show-overflow-tooltip />
            <el-table-column label="操作" width="110" fixed="right">
              <template #default="{ row }: { row: Artifact }">
                <el-button
                  v-if="row.status === 'suspended'"
                  link
                  type="primary"
                  size="small"
                  @click="openSuspend(row)"
                >
                  测绘确认
                </el-button>
                <span v-else-if="row.status === 'failed'" class="muted">补齐基点后重试</span>
                <span v-else class="muted">出土物页进库</span>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <!-- 改基点对话框 -->
    <el-dialog v-model="baseDialogVisible" title="测绘组改基点（升版，旧版归档）" width="520px">
      <el-form label-width="110px">
        <el-form-item label="新基点 N/E" required>
          <el-input v-model="baseForm.baseText" placeholder="如 N1200.5 / E3000" />
        </el-form-item>
        <el-form-item label="基准面高程(m)">
          <el-input-number v-model="baseForm.elevation" :step="0.1" :controls="false" style="width: 100%" />
        </el-form-item>
        <el-form-item label="生效日期">
          <el-date-picker v-model="baseForm.effectiveDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="测绘记录人">
          <el-input v-model="baseForm.surveyor" placeholder="测绘组负责人" />
        </el-form-item>
        <el-form-item label="改版说明">
          <el-input v-model="baseForm.note" type="textarea" :rows="2" placeholder="如 原点被施工扰动，北移 0.5 m" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="baseDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitBase">确认升版</el-button>
      </template>
    </el-dialog>

    <!-- 挂起确认对话框 -->
    <el-dialog v-model="suspendTarget" title="挂起器物 · 测绘组确认" width="480px">
      <el-alert
        v-if="suspendTarget"
        :title="suspendTarget.holdReason"
        type="warning"
        :closable="false"
        show-icon
        style="margin-bottom: 12px"
      />
      <el-form label-width="90px">
        <el-form-item label="处理方式">
          <el-radio-group v-model="suspendForm.resolution">
            <el-radio v-for="item in SUSPEND_RESOLUTIONS" :key="item" :value="item">{{ item }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="确认意见">
          <el-input v-model="suspendForm.comment" type="textarea" :rows="3" placeholder="确认进库：差异以测绘基点记录为准；退回重测：说明重测要求" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="suspendTarget = null">取消</el-button>
        <el-button type="primary" @click="submitSuspend">提交确认</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.ledger-card {
  border-radius: 12px;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: #8a8073;
  line-height: 1.6;
}
.recompute-bar {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.status-tags {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.diff-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.muted {
  color: #a59a8b;
  font-size: 12px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}
</style>
