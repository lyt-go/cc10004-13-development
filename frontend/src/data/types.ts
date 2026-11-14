/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 单个画像分层在某一版留存快照下的计算结果。 */
export type RetentionLayer = {
  /** 分层名称，例如 高活跃[60,100] */
  layerName: string
  /** 该版本固定的分层区间 */
  range: string
  /** 本层覆盖用户量 */
  coverage: number
  /** 分层留存率（百分数，保留 1 位小数，例如 43.6 表示 43.6%） */
  retentionRate: number
  /** 本次重算中该层是否受画像版本变化影响；false 表示沿用上一版结果 */
  affected: boolean
}

/** 画像定义的一个已发布版本：覆盖率与分层口径都按版本冻结。 */
export type ProfileVersion = {
  profileCode: string
  version: string
  publishedAt: string
  /** 该版本覆盖的总用户量 */
  coverage: number
  dimensions: string[]
  metrics: string[]
  updateCycle: string
  /** 各分层的冻结口径：区间 + 指标指纹，指纹变化即视为该层人群变化 */
  layerSpecs: { layerName: string; range: string; fingerprint: string }[]
  status: '已发布' | '已作废'
}

/** 留存快照：方案启用或画像重算时固定，append-only，旧快照保留作历史对照。 */
export type RetentionSnapshot = {
  snapshotId: string
  planCode: string
  profileCode: string
  /** 快照固定的画像版本，之后画像换版不回写旧快照 */
  profileVersion: string
  initialEvent: string
  returnEvent: string
  observeDays: number
  cohortGranularity: string
  reason: '启用固定' | '画像重算'
  /** 补算窗口（天）：只回补该窗口内的初始事件群组 */
  recomputeWindowDays: number
  layers: RetentionLayer[]
  computedAt: string
  /** true 表示已被更新版本的快照取代，但数据保留用于历史对照 */
  superseded: boolean
}

/** 待重算任务：画像发布新版本后，只给引用该画像的方案建任务。 */
export type RecomputeJob = {
  jobId: string
  planCode: string
  profileCode: string
  fromVersion: string
  toVersion: string
  /** 相对上一版本发生口径变化、需要重算的分层 */
  affectedLayers: string[]
  triggeredAt: string
  status: '待重算'
}
