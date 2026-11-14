import { listRows, saveRows } from './local-store'
import type {
  EntryRow,
  ProfileVersion,
  RecomputeJob,
  RetentionLayer,
  RetentionSnapshot,
} from './types'

/**
 * 画像版本驱动的留存重算引擎。
 *
 * 设计要点：
 * 1. 方案启用时固定「初始事件 + 画像版本 + 分层区间」，产出首个留存快照；
 * 2. 画像发布新版本时，只给引用该画像的「已启用」方案投递待重算任务，旧快照不删，保留为历史对照；
 * 3. 重算只重算口径指纹变化的分层，未受影响的层沿用上一版结果；
 * 4. 画像换版与留存重算先在内存里完成全部计算，再一次性落库（单次提交），
 *    计算失败整体回滚，不允许只更新画像版本而留下旧覆盖率；
 * 5. 同一方案有多个版本竞争时，只接受最高版本，旧版本结果永远不能覆盖新版本人群。
 */

const DOMAIN_KEY = 'data-product-ops:retention-domain'

/** 补算窗口：重算只回补近 14 天产生初始事件的群组，更早的群组维持原快照口径。 */
export const RECOMPUTE_WINDOW_DAYS = 14

/** 各层基准次日留存率（百分数），再叠加由方案/版本/分层决定的确定性扰动。 */
const BASE_RATE_BY_LAYER = ['高活跃', '中活跃', '低活跃', '沉睡']
const BASE_RATES = [58, 44, 31, 19]

/* ------------------------------------------------------------------ */
/* 领域状态                                                            */
/* ------------------------------------------------------------------ */

export type RetentionDomainState = {
  versions: ProfileVersion[]
  snapshots: RetentionSnapshot[]
  jobs: RecomputeJob[]
}

type Binding = {
  planCode: string
  profileCode: string
  /** 启用时固定的初始事件：画像换版不改变它 */
  initialEvent: string
  returnEvent: string
  observeDays: number
  cohortGranularity: string
  enabledAt: string
}

const PLAN_BINDINGS: Binding[] = [
  {
    planCode: 'RETE-0001',
    profileCode: 'PROF-0001',
    initialEvent: 'EVEN-0001 注册成功',
    returnEvent: 'EVEN-0002 登录回访',
    observeDays: 30,
    cohortGranularity: '周群组',
    enabledAt: '2026-09-21',
  },
  {
    planCode: 'RETE-0002',
    profileCode: 'PROF-0002',
    initialEvent: 'EVEN-0003 首次下单',
    returnEvent: 'EVEN-0004 复购回访',
    observeDays: 30,
    cohortGranularity: '周群组',
    enabledAt: '2026-09-21',
  },
]

type VersionSeed = {
  version: string
  publishedAt: string
  coverage: number
  dimensions: string[]
  metrics: string[]
  updateCycle: string
  /** 与上一版相比，哪些分层的口径指纹发生了变化（首个已发布版本视为全量变化） */
  changedLayers: string[]
  layerSpecs: { layerName: string; range: string; fingerprint: string }[]
}

type ProfileSeed = {
  profileCode: string
  updateCycle: string
  dimensions: string[]
  metrics: string[]
  versions: VersionSeed[]
}

/**
 * 画像版本种子。区间与指纹按版本冻结：
 * PROF-0002 的 v3→v4 调整了中/高活跃区间（全量重算），
 * v4→v5 只进一步抬高了高活跃门槛（只重算高活跃层）。
 */
const PROFILE_SEEDS: ProfileSeed[] = [
  {
    profileCode: 'PROF-0001',
    updateCycle: 'monthly',
    dimensions: ['注册渠道', '会员等级', '城市线级'],
    metrics: ['累计登录天数', '累计访问时长', '最近活跃距今天数'],
    versions: [
      {
        version: 'v1',
        publishedAt: '2026-08-15',
        coverage: 12600,
        dimensions: ['注册渠道', '会员等级'],
        metrics: ['累计登录天数'],
        updateCycle: 'monthly',
        changedLayers: BASE_RATE_BY_LAYER,
        layerSpecs: [
          { layerName: '高活跃', range: '[60,100]', fingerprint: 'v1:high:logindays>=60' },
          { layerName: '中活跃', range: '[30,60)', fingerprint: 'v1:mid:logindays30-59' },
          { layerName: '低活跃', range: '[7,30)', fingerprint: 'v1:low:logindays7-29' },
          { layerName: '沉睡', range: '[0,7)', fingerprint: 'v1:sleep:logindays0-6' },
        ],
      },
      {
        version: 'v2',
        publishedAt: '2026-09-18',
        coverage: 13850,
        dimensions: ['注册渠道', '会员等级', '城市线级'],
        metrics: ['累计登录天数', '累计访问时长', '最近活跃距今天数'],
        updateCycle: 'monthly',
        changedLayers: ['高活跃', '中活跃'],
        layerSpecs: [
          { layerName: '高活跃', range: '[55,100]', fingerprint: 'v2:high:logindays>=55+duration' },
          { layerName: '中活跃', range: '[28,55)', fingerprint: 'v2:mid:logindays28-54+duration' },
          { layerName: '低活跃', range: '[7,28)', fingerprint: 'v1:low:logindays7-29' },
          { layerName: '沉睡', range: '[0,7)', fingerprint: 'v1:sleep:logindays0-6' },
        ],
      },
    ],
  },
  {
    profileCode: 'PROF-0002',
    updateCycle: 'weekly',
    dimensions: ['行业类目', '消费等级', '活跃频次', '复购周期'],
    metrics: ['近30天下单次数', '近30天支付金额', '近30天活跃天数', '客单价'],
    versions: [
      {
        version: 'v1',
        publishedAt: '2026-08-10',
        coverage: 15200,
        dimensions: ['行业类目', '消费等级'],
        metrics: ['近30天下单次数', '近30天支付金额'],
        updateCycle: 'weekly',
        changedLayers: BASE_RATE_BY_LAYER,
        layerSpecs: [
          { layerName: '高活跃', range: '[55,100]', fingerprint: 'v1:high:orders>=12' },
          { layerName: '中活跃', range: '[25,55)', fingerprint: 'v1:mid:orders6-11' },
          { layerName: '低活跃', range: '[5,25)', fingerprint: 'v1:low:orders2-5' },
          { layerName: '沉睡', range: '[0,5)', fingerprint: 'v1:sleep:orders0-1' },
        ],
      },
      {
        version: 'v2',
        publishedAt: '2026-09-07',
        coverage: 16100,
        dimensions: ['行业类目', '消费等级', '活跃频次'],
        metrics: ['近30天下单次数', '近30天支付金额', '近30天活跃天数'],
        updateCycle: 'weekly',
        changedLayers: ['高活跃'],
        layerSpecs: [
          { layerName: '高活跃', range: '[60,100]', fingerprint: 'v2:high:orders>=14+activedays' },
          { layerName: '中活跃', range: '[25,60)', fingerprint: 'v1:mid:orders6-11' },
          { layerName: '低活跃', range: '[5,25)', fingerprint: 'v1:low:orders2-5' },
          { layerName: '沉睡', range: '[0,5)', fingerprint: 'v1:sleep:orders0-1' },
        ],
      },
      {
        version: 'v3',
        publishedAt: '2026-10-12',
        coverage: 17240,
        dimensions: ['行业类目', '消费等级', '活跃频次'],
        metrics: ['近30天下单次数', '近30天支付金额', '近30天活跃天数'],
        updateCycle: 'weekly',
        changedLayers: ['低活跃', '沉睡'],
        layerSpecs: [
          { layerName: '高活跃', range: '[60,100]', fingerprint: 'v2:high:orders>=14+activedays' },
          { layerName: '中活跃', range: '[25,60)', fingerprint: 'v1:mid:orders6-11' },
          { layerName: '低活跃', range: '[8,25)', fingerprint: 'v3:low:orders3-5+recency' },
          { layerName: '沉睡', range: '[0,8)', fingerprint: 'v3:sleep:orders0-2+recency' },
        ],
      },
      {
        version: 'v4',
        publishedAt: '2026-10-28',
        coverage: 18420,
        dimensions: ['行业类目', '消费等级', '活跃频次', '复购周期'],
        metrics: ['近30天下单次数', '近30天支付金额', '近30天活跃天数', '客单价'],
        updateCycle: 'weekly',
        changedLayers: BASE_RATE_BY_LAYER,
        layerSpecs: [
          { layerName: '高活跃', range: '[65,100]', fingerprint: 'v4:high:orders>=16+gmv+activedays' },
          { layerName: '中活跃', range: '[30,65)', fingerprint: 'v4:mid:orders8-15+gmv' },
          { layerName: '低活跃', range: '[8,30)', fingerprint: 'v4:low:orders3-7+recency' },
          { layerName: '沉睡', range: '[0,8)', fingerprint: 'v4:sleep:orders0-2+recency' },
        ],
      },
      {
        version: 'v5',
        publishedAt: '2026-11-12',
        coverage: 19036,
        dimensions: ['行业类目', '消费等级', '活跃频次', '复购周期'],
        metrics: ['近30天下单次数', '近30天支付金额', '近30天活跃天数', '客单价'],
        updateCycle: 'weekly',
        changedLayers: ['高活跃'],
        layerSpecs: [
          { layerName: '高活跃', range: '[70,100]', fingerprint: 'v5:high:orders>=18+gmv+repurchase' },
          { layerName: '中活跃', range: '[30,70)', fingerprint: 'v4:mid:orders8-15+gmv' },
          { layerName: '低活跃', range: '[8,30)', fingerprint: 'v4:low:orders3-7+recency' },
          { layerName: '沉睡', range: '[0,8)', fingerprint: 'v4:sleep:orders0-2+recency' },
        ],
      },
    ],
  },
]

/** 各层人群权重（合计 100），按版本固定；覆盖量按权重拆分，余量并入最后一层。 */
const LAYER_WEIGHTS: Record<string, number[]> = {
  'PROF-0001:v1': [18, 34, 30, 18],
  'PROF-0001:v2': [22, 32, 28, 18],
  'PROF-0002:v1': [16, 32, 32, 20],
  'PROF-0002:v2': [19, 31, 30, 20],
  'PROF-0002:v3': [19, 31, 27, 23],
  'PROF-0002:v4': [24, 33, 24, 19],
  'PROF-0002:v5': [21, 36, 24, 19],
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

/** 稳定字符串哈希：同样的方案/版本/分层永远算出同样的扰动，重算结果可复现。 */
function hashSeed(seed: string): number {
  let hash = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash >>> 0)
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function versionRank(version: string): number {
  const matched = /^v(\d+)$/.exec(version.trim())
  return matched ? Number(matched[1]) : 0
}

/** 按权重拆分版本覆盖量，保证各层合计与版本覆盖用户量一致。 */
function splitCoverage(profileCode: string, version: string, total: number): number[] {
  const weights = LAYER_WEIGHTS[`${profileCode}:${version}`] ?? [25, 25, 25, 25]
  const result = weights.map((weight) => Math.round((total * weight) / 100))
  const diff = total - result.reduce((sum, value) => sum + value, 0)
  result[result.length - 1] += diff
  return result
}

function snapshotId(planCode: string, version: string, seq: number): string {
  return `SNAP-${planCode}-${version}-${String(seq).padStart(2, '0')}`
}

function jobId(planCode: string, version: string): string {
  return `JOB-${planCode}-${version}`
}

/* ------------------------------------------------------------------ */
/* 留存率计算（确定性模拟）                                              */
/* ------------------------------------------------------------------ */

function computeLayer(
  binding: Binding,
  version: ProfileVersion,
  layerIndex: number,
  affected: boolean,
): RetentionLayer {
  const spec = version.layerSpecs[layerIndex]
  const coverage = splitCoverage(version.profileCode, version.version, version.coverage)[layerIndex]
  const jitter = (hashSeed(`${binding.planCode}|${version.version}|${spec.layerName}`) % 80) / 10 - 4
  const rate = round1(BASE_RATES[layerIndex] + jitter + (versionRank(version.version) - 1) * 0.4)
  return {
    layerName: `${spec.layerName}${spec.range}`,
    range: spec.range,
    coverage,
    retentionRate: rate,
    affected,
  }
}

/**
 * 组装某版本的全部分层结果：
 * - 受影响分层：按新版本口径重新计算覆盖率与留存率；
 * - 未受影响分层：覆盖量随新版本总覆盖量重新拆分，但留存率沿用上一版同分层结果，
 *   匹配优先按口径指纹，其次按分层名，保证旧人群口径不被新版本改写。
 */
function buildLayers(
  binding: Binding,
  version: ProfileVersion,
  affectedNames: Set<string>,
  previous: RetentionSnapshot | null,
): RetentionLayer[] {
  return version.layerSpecs.map((spec, index) => {
    const computed = computeLayer(binding, version, index, affectedNames.has(spec.layerName))
    if (affectedNames.has(spec.layerName) || !previous) {
      return computed
    }
    const inherited = previous.layers.find((layer) => layer.layerName.startsWith(spec.layerName))
    if (inherited) {
      return { ...computed, retentionRate: inherited.retentionRate, affected: false }
    }
    return { ...computed, affected: false }
  })
}

/* ------------------------------------------------------------------ */
/* 状态读取 / 持久化（单次提交）                                         */
/* ------------------------------------------------------------------ */

let memoryState: RetentionDomainState | null = null

function seedDomain(): RetentionDomainState {
  const versions: ProfileVersion[] = []
  for (const profile of PROFILE_SEEDS) {
    for (const seed of profile.versions) {
      versions.push({
        profileCode: profile.profileCode,
        version: seed.version,
        publishedAt: seed.publishedAt,
        coverage: seed.coverage,
        dimensions: seed.dimensions,
        metrics: seed.metrics,
        updateCycle: seed.updateCycle,
        layerSpecs: seed.layerSpecs,
        status: '已发布',
      })
    }
  }

  const snapshots: RetentionSnapshot[] = []
  const jobs: RecomputeJob[] = []

  for (const binding of PLAN_BINDINGS) {
    const profileVersions = versions
      .filter((item) => item.profileCode === binding.profileCode)
      .sort((a, b) => versionRank(a.version) - versionRank(b.version))
    // 演示态：PROF-0002 最新版 v5 已发布但重算尚未执行，
    // 因此 RETE-0002 的当前快照停在 v4，v5 只进入待重算队列。
    const pendingVersion = binding.profileCode === 'PROF-0002' ? profileVersions[profileVersions.length - 1] : null
    const materializedVersions = pendingVersion ? profileVersions.slice(0, -1) : profileVersions
    let previous: RetentionSnapshot | null = null
    let seq = 0

    materializedVersions.forEach((version, index) => {
      const seed = PROFILE_SEEDS.find((item) => item.profileCode === binding.profileCode)!.versions[index]
      const affectedSet = new Set(index === 0 ? BASE_RATE_BY_LAYER : seed.changedLayers)
      const layers = buildLayers(binding, version, affectedSet, previous)

      seq += 1
      const snapshot: RetentionSnapshot = {
        snapshotId: snapshotId(binding.planCode, version.version, seq),
        planCode: binding.planCode,
        profileCode: binding.profileCode,
        profileVersion: version.version,
        initialEvent: binding.initialEvent,
        returnEvent: binding.returnEvent,
        observeDays: binding.observeDays,
        cohortGranularity: binding.cohortGranularity,
        reason: index === 0 ? '启用固定' : '画像重算',
        recomputeWindowDays: RECOMPUTE_WINDOW_DAYS,
        layers,
        computedAt: index === 0 ? binding.enabledAt : version.publishedAt,
        superseded: false,
      }
      if (previous) {
        previous.superseded = true
      }
      snapshots.push(snapshot)
      previous = snapshot
    })

    // 最新版本尚未物化快照时，生成一条待重算任务（历史版本任务均已由快照链体现）。
    if (pendingVersion) {
      const lastIndex = profileVersions.length - 1
      const pendingSeed = PROFILE_SEEDS.find((item) => item.profileCode === binding.profileCode)!.versions[lastIndex]
      jobs.push({
        jobId: jobId(binding.planCode, pendingVersion.version),
        planCode: binding.planCode,
        profileCode: binding.profileCode,
        fromVersion: profileVersions[lastIndex - 1].version,
        toVersion: pendingVersion.version,
        affectedLayers: [...pendingSeed.changedLayers],
        triggeredAt: pendingVersion.publishedAt,
        status: '待重算',
      })
    }
  }

  // 当前演示态：PROF-0002 v5 刚发布，RETE-0002 的 v5 重算仍在队列里（只影响高活跃层）。
  return { versions, snapshots, jobs }
}

export function loadDomain(): RetentionDomainState {
  if (memoryState) {
    return memoryState
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    const raw = window.localStorage.getItem(DOMAIN_KEY)
    if (raw) {
      try {
        memoryState = JSON.parse(raw) as RetentionDomainState
        return memoryState
      } catch {
        // 落库内容损坏时回到确定性种子，不让页面崩溃。
      }
    }
  }
  memoryState = seedDomain()
  persistDomain(memoryState)
  return memoryState
}

/** 单次提交：领域状态与受影响的两张业务表一起写入，任一环节失败整体回滚。 */
function commitDomain(next: RetentionDomainState, tableWrites: Record<string, EntryRow[]>): void {
  const previous = memoryState ? (JSON.parse(JSON.stringify(memoryState)) as RetentionDomainState) : null
  const previousTables: Record<string, EntryRow[]> = {}
  for (const key of Object.keys(tableWrites)) {
    previousTables[key] = JSON.parse(JSON.stringify(listRows(key))) as EntryRow[]
  }
  try {
    memoryState = next
    persistDomain(next)
    for (const [key, rows] of Object.entries(tableWrites)) {
      saveRows(key, rows)
    }
  } catch (error) {
    // 回滚：恢复领域状态与业务表，绝不留下“画像已换版、覆盖率仍是旧值”的半成品。
    if (previous) {
      memoryState = previous
      persistDomain(previous)
    }
    for (const [key, rows] of Object.entries(previousTables)) {
      saveRows(key, rows)
    }
    throw error instanceof Error ? error : new Error('留存领域单次提交失败，已整体回滚')
  }
}

function persistDomain(state: RetentionDomainState): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(DOMAIN_KEY, JSON.stringify(state))
  }
}

export function resetDomain(): RetentionDomainState {
  memoryState = seedDomain()
  persistDomain(memoryState)
  return memoryState
}

/* ------------------------------------------------------------------ */
/* 查询接口（给面板用）                                                 */
/* ------------------------------------------------------------------ */

export function listProfileVersions(profileCode: string): ProfileVersion[] {
  return loadDomain()
    .versions.filter((item) => item.profileCode === profileCode)
    .sort((a, b) => versionRank(b.version) - versionRank(a.version))
}

export function listPlanSnapshots(planCode: string): RetentionSnapshot[] {
  return loadDomain()
    .snapshots.filter((item) => item.planCode === planCode)
    .sort((a, b) => versionRank(b.profileVersion) - versionRank(a.profileVersion))
}

export function latestSnapshot(planCode: string): RetentionSnapshot | undefined {
  const snapshots = listPlanSnapshots(planCode)
  return snapshots.find((item) => !item.superseded) ?? snapshots[0]
}

export function pendingJobs(planCode?: string): RecomputeJob[] {
  const jobs = loadDomain().jobs.filter((job) => job.status === '待重算')
  if (planCode) {
    return jobs.filter((job) => job.planCode === planCode)
  }
  return jobs
}

export function findBinding(planCode: string): Binding | undefined {
  return PLAN_BINDINGS.find((item) => item.planCode === planCode)
}

export function bindingForProfile(profileCode: string): Binding[] {
  return PLAN_BINDINGS.filter((item) => item.profileCode === profileCode)
}

/* ------------------------------------------------------------------ */
/* 事务一：发布画像新版本（同一次提交完成换版 + 待重算入队）               */
/* ------------------------------------------------------------------ */

export function publishProfileVersion(input: {
  profileCode: string
  coverage: number
  dimensions: string[]
  metrics: string[]
  updateCycle: string
  layerSpecs: ProfileVersion['layerSpecs']
  changedLayers: string[]
  publishedAt: string
}): { version: ProfileVersion; jobs: RecomputeJob[] } {
  const state = loadDomain()
  const existing = state.versions
    .filter((item) => item.profileCode === input.profileCode)
    .sort((a, b) => versionRank(b.version) - versionRank(a.version))
  const previousVersion = existing[0]
  if (!previousVersion) {
    throw new Error(`${input.profileCode} 尚未建立画像版本，不能直接发布新版本`)
  }
  if (input.coverage <= 0) {
    throw new Error('新版本覆盖用户量必须为正数，发布已中止，画像版本与留存覆盖率均未改动')
  }

  const nextVersionNo = versionRank(previousVersion.version) + 1
  const nextLabel = `v${nextVersionNo}`
  const version: ProfileVersion = {
    profileCode: input.profileCode,
    version: nextLabel,
    publishedAt: input.publishedAt,
    coverage: input.coverage,
    dimensions: input.dimensions,
    metrics: input.metrics,
    updateCycle: input.updateCycle,
    layerSpecs: input.layerSpecs,
    status: '已发布',
  }

  // 只给引用该画像的方案投递待重算；没有方案引用则只换版、不产生任务。
  const newJobs: RecomputeJob[] = []
  for (const binding of bindingForProfile(input.profileCode)) {
    const planEnabled = listRows('retention').some(
      (row) => String(row['方案编号']) === binding.planCode && String(row.status) === '已启用',
    )
    if (!planEnabled) {
      continue
    }
    const job: RecomputeJob = {
      jobId: jobId(binding.planCode, nextLabel),
      planCode: binding.planCode,
      profileCode: input.profileCode,
      fromVersion: previousVersion.version,
      toVersion: nextLabel,
      affectedLayers: [...input.changedLayers],
      triggeredAt: input.publishedAt,
      status: '待重算',
    }
    newJobs.push(job)
  }

  const nextState: RetentionDomainState = {
    ...state,
    versions: [...state.versions, version],
    // 同一方案若已排队更低版本的任务，新版本入队即取代它：旧版本结果不得覆盖新人群。
    jobs: [
      ...state.jobs.filter((job) => !newJobs.some((fresh) => fresh.planCode === job.planCode)),
      ...newJobs,
    ],
  }

  const profileRows = listRows('profile').map((row) =>
    String(row['画像编号']) === input.profileCode
      ? {
          ...row,
          status: '已发布',
          pending: false,
          abnormal: false,
          '画像版本': nextLabel,
          '覆盖用户量': input.coverage,
          '统计维度': input.dimensions.join('、'),
          '聚合指标': input.metrics.join('、'),
          '分层区间': input.layerSpecs.map((spec) => `${spec.layerName}${spec.range}`).join(' / '),
          '更新周期': input.updateCycle,
          '发布时间': input.publishedAt,
        }
      : row,
  )

  // 单次提交：版本、任务队列与画像表同时落库。
  commitDomain(nextState, { profile: profileRows })
  return { version, jobs: newJobs }
}

/* ------------------------------------------------------------------ */
/* 事务二：启用留存方案（同一次提交完成启用 + 首版快照固定）               */
/* ------------------------------------------------------------------ */

export function enableRetentionPlan(planCode: string): RetentionSnapshot {
  const binding = findBinding(planCode)
  if (!binding) {
    throw new Error(`${planCode} 没有绑定画像定义，无法固定画像版本与分层区间`)
  }
  const state = loadDomain()
  const currentVersion = state.versions
    .filter((item) => item.profileCode === binding.profileCode)
    .sort((a, b) => versionRank(b.version) - versionRank(a.version))[0]
  if (!currentVersion) {
    throw new Error(`${binding.profileCode} 还没有已发布版本，留存方案不能启用`)
  }
  if (state.snapshots.some((snap) => snap.planCode === planCode)) {
    throw new Error(`${planCode} 已存在启用快照，重复启用会破坏版本固定关系`)
  }

  const layers = currentVersion.layerSpecs.map((_, index) =>
    computeLayer(binding, currentVersion, index, true),
  )
  const seq = state.snapshots.filter((snap) => snap.planCode === planCode).length + 1
  const snapshot: RetentionSnapshot = {
    snapshotId: snapshotId(planCode, currentVersion.version, seq),
    planCode,
    profileCode: binding.profileCode,
    profileVersion: currentVersion.version,
    initialEvent: binding.initialEvent,
    returnEvent: binding.returnEvent,
    observeDays: binding.observeDays,
    cohortGranularity: binding.cohortGranularity,
    reason: '启用固定',
    recomputeWindowDays: RECOMPUTE_WINDOW_DAYS,
    layers,
    computedAt: currentVersion.publishedAt,
    superseded: false,
  }

  const retentionRows = listRows('retention').map((row) =>
    String(row['方案编号']) === planCode
      ? {
          ...row,
          status: '已启用',
          pending: false,
          abnormal: false,
          '关联画像': binding.profileCode,
          '固定画像版本': currentVersion.version,
          '初始事件': binding.initialEvent,
          '回访事件': binding.returnEvent,
          '观察天数': binding.observeDays,
          '群组粒度': binding.cohortGranularity,
        }
      : row,
  )

  commitDomain({ ...state, snapshots: [...state.snapshots, snapshot] }, { retention: retentionRows })
  return snapshot
}

/* ------------------------------------------------------------------ */
/* 事务三：执行待重算（只重算受影响分层，其余沿用旧快照，结果整体提交）      */
/* ------------------------------------------------------------------ */

export function runRecompute(jobIdValue: string): RetentionSnapshot {
  const state = loadDomain()
  const job = state.jobs.find((item) => item.jobId === jobIdValue && item.status === '待重算')
  if (!job) {
    throw new Error('待重算任务不存在或已处理')
  }
  const binding = findBinding(job.planCode)
  if (!binding) {
    throw new Error(`${job.planCode} 的画像绑定缺失，重算已中止`)
  }

  const targetVersion = state.versions.find(
    (item) => item.profileCode === job.profileCode && item.version === job.toVersion,
  )
  if (!targetVersion) {
    throw new Error(`目标版本 ${job.toVersion} 不存在，重算已中止，旧覆盖率保持不变`)
  }
  const previous = latestSnapshot(job.planCode)
  if (!previous) {
    throw new Error(`${job.planCode} 缺少启用快照，不能执行画像重算`)
  }
  // 新版本为准：当前快照版本若已不低于目标版本，说明旧任务过期，直接拒绝覆盖。
  if (versionRank(previous.profileVersion) >= versionRank(job.toVersion)) {
    throw new Error(
      `${job.planCode} 当前已是 ${previous.profileVersion}，旧版本 ${job.toVersion} 的重算结果禁止覆盖新分层人群`,
    )
  }

  const affectedSet = new Set(job.affectedLayers)
  const layers = buildLayers(binding, targetVersion, affectedSet, previous)

  const seq = state.snapshots.filter((snap) => snap.planCode === job.planCode).length + 1
  const snapshot: RetentionSnapshot = {
    snapshotId: snapshotId(job.planCode, job.toVersion, seq),
    planCode: job.planCode,
    profileCode: job.profileCode,
    profileVersion: job.toVersion,
    initialEvent: binding.initialEvent,
    returnEvent: binding.returnEvent,
    observeDays: binding.observeDays,
    cohortGranularity: binding.cohortGranularity,
    reason: '画像重算',
    recomputeWindowDays: RECOMPUTE_WINDOW_DAYS,
    layers,
    computedAt: targetVersion.publishedAt,
    superseded: false,
  }

  const nextSnapshots = state.snapshots.map((snap) =>
    snap.planCode === job.planCode ? { ...snap, superseded: true } : snap,
  )
  nextSnapshots.push(snapshot)

  const nextJobs = state.jobs.filter((item) => item.jobId !== job.jobId)
  const retentionRows = listRows('retention').map((row) =>
    String(row['方案编号']) === job.planCode
      ? {
          ...row,
          '固定画像版本': job.toVersion,
          '关联画像': job.profileCode,
          '初始事件': binding.initialEvent,
          '回访事件': binding.returnEvent,
          '观察天数': binding.observeDays,
          '群组粒度': binding.cohortGranularity,
        }
      : row,
  )

  // 单次提交：新快照、任务出队、方案版本更新同时落库；失败则旧快照与旧覆盖率原样保留。
  commitDomain(
    { ...state, snapshots: nextSnapshots, jobs: nextJobs },
    { retention: retentionRows },
  )
  return snapshot
}
