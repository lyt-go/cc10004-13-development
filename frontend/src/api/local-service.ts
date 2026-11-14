import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  bindingForProfile,
  enableRetentionPlan,
  findBinding,
  loadDomain,
  publishProfileVersion,
  resetDomain,
} from '@/data/retention-domain'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  // 画像发布：转入版本驱动流程，换版与留存待重算入队必须同一次提交完成。
  if (key === 'profile' && action === '发布画像') {
    return publishProfile(rows[index])
  }
  // 留存方案启用：先固定初始事件、画像版本与分层区间并算出首版快照，再整体落库。
  if (key === 'retention' && action === '启用方案') {
    return enablePlan(rows[index])
  }

  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/** 画像发布入口：基于当前行口径生成下一版本，领域引擎负责单次提交与回滚。 */
function publishProfile(row: EntryRow): ActionResult {
  const profileCode = String(row['画像编号'])
  const domain = loadDomain()
  const previous = domain.versions
    .filter((item) => item.profileCode === profileCode)
    .sort((a, b) => Number(b.version.slice(1)) - Number(a.version.slice(1)))[0]
  if (!previous) {
    return { ok: false, message: `${profileCode} 没有历史画像版本，无法按版本驱动方式发布` }
  }
  const today = new Date().toISOString().slice(0, 10)
  const nextLabel = `v${Number(previous.version.slice(1)) + 1}`
  try {
    const { version, jobs } = publishProfileVersion({
      profileCode,
      coverage: previous.coverage + 616,
      dimensions: previous.dimensions,
      metrics: previous.metrics,
      updateCycle: previous.updateCycle,
      // 默认演示：沿用分层口径并调整高活跃区间，因此只重算高活跃层。
      changedLayers: ['高活跃'],
      layerSpecs: previous.layerSpecs.map((spec) =>
        spec.layerName === '高活跃'
          ? { ...spec, range: '[70,100]', fingerprint: `${nextLabel}:${spec.fingerprint}` }
          : spec,
      ),
      publishedAt: today,
    })
    const targets = bindingForProfile(profileCode)
    const jobText =
      jobs.length > 0
        ? `，已向 ${jobs.map((job) => job.planCode).join('、')} 投递待重算（受影响分层：${jobs[0].affectedLayers.join('、')}）`
        : targets.length === 0
          ? '，当前没有留存方案引用该画像，无需重算'
          : ''
    return {
      ok: true,
      message: `${profileCode} 已发布 ${version.version}（覆盖 ${version.coverage.toLocaleString()} 人），换版与重算入队同次提交完成${jobText}`,
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '画像发布失败，事务已回滚，旧覆盖率保持不变',
    }
  }
}

/** 留存方案启用入口：固定画像版本与分层区间，启用与首版快照同次提交。 */
function enablePlan(row: EntryRow): ActionResult {
  const planCode = String(row['方案编号'])
  if (!findBinding(planCode)) {
    return { ok: false, message: `${planCode} 尚未绑定画像定义，不能固定画像版本，启用已中止` }
  }
  try {
    const snapshot = enableRetentionPlan(planCode)
    return {
      ok: true,
      message: `${planCode} 已启用并固定 ${snapshot.profileCode} ${snapshot.profileVersion}，初始事件「${snapshot.initialEvent}」与 ${snapshot.layers.length} 个分层区间已写入首版快照`,
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '方案启用失败，事务已回滚，未产生半截快照',
    }
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  // 画像 / 留存表回到种子数据时，版本、快照与重算队列也一并回到确定性初始态。
  if (key === 'profile' || key === 'retention') {
    resetDomain()
  }
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
