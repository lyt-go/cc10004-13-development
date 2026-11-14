/* 领域链路验证脚本（不进 src，不参与前端构建）：用 esbuild 打包后在 Node 内运行。 */
import { SEED_ROWS } from './src/data/seed'
import { resetRows } from './src/data/local-store'
import {
  loadDomain,
  resetDomain,
  runRecompute,
  pendingJobs,
  latestSnapshot,
  listPlanSnapshots,
  listProfileVersions,
  publishProfileVersion,
  enableRetentionPlan,
  findBinding,
} from './src/data/retention-domain'

let failures = 0
function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  ✅ ${name}`)
  } else {
    failures += 1
    console.error(`  ❌ ${name} ${detail}`)
  }
}

// 每次运行都回到确定性种子。
resetRows('profile')
resetRows('retention')
resetDomain()

console.log('\n[1] 种子状态：PROF-0002 v4/v5 与 RETE-0002 固定 v4')
const versions = listProfileVersions('PROF-0002')
check('PROF-0002 共 5 个已发布版本', versions.length === 5, `实际 ${versions.length}`)
const v4 = versions.find((item) => item.version === 'v4')!
const v5 = versions.find((item) => item.version === 'v5')!
check('v4 发布于 2026-10-28', v4.publishedAt === '2026-10-28')
check('v4 覆盖 18,420 人', v4.coverage === 18420)
check('v4 更新周期 weekly', v4.updateCycle === 'weekly')
check('v5 发布于 2026-11-12', v5.publishedAt === '2026-11-12')
check('v5 覆盖 19,036 人', v5.coverage === 19036)
check('v4 含 4 项统计维度', v4.dimensions.length === 4)
check('v4 含 4 项聚合指标', v4.metrics.length === 4)
check('v4 含 4 个冻结分层区间', v4.layerSpecs.length === 4)

const rete02Current = latestSnapshot('RETE-0002')!
check('RETE-0002 当前快照固定 v4', rete02Current.profileVersion === 'v4')
check('RETE-0002 初始事件保持不变', rete02Current.initialEvent === 'EVEN-0003 首次下单')
const rete01Current = latestSnapshot('RETE-0001')!
check('RETE-0001 仍读取自己的旧画像版本 v2', rete01Current.profileVersion === 'v2')
check('RETE-0001 引用 PROF-0001 而非 PROF-0002', rete01Current.profileCode === 'PROF-0001')

const jobs = pendingJobs()
check('初始只有 1 个待重算任务（RETE-0002 → v5）', jobs.length === 1, `实际 ${jobs.length}`)
check('待重算任务只影响高活跃层', jobs[0]?.affectedLayers.join() === '高活跃', JSON.stringify(jobs[0]?.affectedLayers))
check('任务目标版本为 v5', jobs[0]?.toVersion === 'v5')

console.log('\n[2] 分层覆盖量合计与版本覆盖用户量一致')
for (const snapshot of listPlanSnapshots('RETE-0002')) {
  const sum = snapshot.layers.reduce((acc, layer) => acc + layer.coverage, 0)
  const version = versions.find((item) => item.version === snapshot.profileVersion)!
  check(
    `${snapshot.profileVersion} 各层覆盖量合计=${version.coverage}`,
    sum === version.coverage,
    `实际合计 ${sum}`,
  )
}

console.log('\n[3] 执行 v5 重算：只重算高活跃层，其余沿用 v4，旧快照保留')
const before = listPlanSnapshots('RETE-0002').length
const v4Snapshot = listPlanSnapshots('RETE-0002').find((item) => item.profileVersion === 'v4')!
const v5Snapshot = runRecompute(jobs[0].jobId)
check('重算后当前快照为 v5', v5Snapshot.profileVersion === 'v5')
check('v5 快照仅高活跃层标记 affected', v5Snapshot.layers.filter((l) => l.affected).map((l) => l.layerName).join().startsWith('高活跃'))
check('v5 高活跃层已按 v5 口径重算', v5Snapshot.layers.find((l) => l.layerName.startsWith('高活跃'))!.range === '[70,100]')
const midV4 = v4Snapshot.layers.find((l) => l.layerName.startsWith('中活跃'))!
const midV5 = v5Snapshot.layers.find((l) => l.layerName.startsWith('中活跃'))!
check('中活跃未受影响：留存率沿用 v4', midV4.retentionRate === midV5.retentionRate, `${midV4.retentionRate} vs ${midV5.retentionRate}`)
check('中活跃未受影响：affected=false', midV5.affected === false)
const after = listPlanSnapshots('RETE-0002')
check('旧 v4 快照仍保留且标记 superseded', after.some((s) => s.profileVersion === 'v4' && s.superseded))
check('快照数量 +1（append-only）', after.length === before + 1)
check('待重算队列已清空', pendingJobs().length === 0)
check('RETE-0001 仍停留在 v2，未被 PROF-0002 换版影响', latestSnapshot('RETE-0001')!.profileVersion === 'v2')

console.log('\n[4] 并发/版本守卫：旧版本结果不得覆盖新版本人群')
let guardError = ''
try {
  runRecompute('JOB-RETE-0002-v5')
} catch (error) {
  guardError = error instanceof Error ? error.message : String(error)
}
check('重复执行已出队任务被拒绝', guardError.includes('不存在或已处理'), guardError)

console.log('\n[5] 画像发布新版本：只给引用该画像的方案入队，且同次提交')
resetDomain()
const publishResult = publishProfileVersion({
  profileCode: 'PROF-0002',
  coverage: 19652,
  dimensions: v5.dimensions,
  metrics: v5.metrics,
  updateCycle: v5.updateCycle,
  layerSpecs: v5.layerSpecs,
  changedLayers: ['高活跃'],
  publishedAt: '2026-11-14',
})
check('发布得到 v6', publishResult.version.version === 'v6')
check('只有 RETE-0002 收到待重算（RETE-0001 不引用 PROF-0002）', publishResult.jobs.length === 1 && publishResult.jobs[0].planCode === 'RETE-0002')
check('新任务目标为 v6', pendingJobs('RETE-0002')[0]?.toVersion === 'v6')
const profileRow = (await import('./src/data/local-store')).listRows('profile').find((r) => r['画像编号'] === 'PROF-0002')!
check('画像表已同次提交更新到 v6 与新覆盖率', profileRow['画像版本'] === 'v6' && profileRow['覆盖用户量'] === 19652)

console.log('\n[6] 失败回滚：非法覆盖量时画像与留存都不变')
const stateBefore = JSON.stringify(loadDomain().versions.length)
let rollbackError = ''
try {
  publishProfileVersion({
    profileCode: 'PROF-0002',
    coverage: 0,
    dimensions: v5.dimensions,
    metrics: v5.metrics,
    updateCycle: v5.updateCycle,
    layerSpecs: v5.layerSpecs,
    changedLayers: ['高活跃'],
    publishedAt: '2026-11-15',
  })
} catch (error) {
  rollbackError = error instanceof Error ? error.message : String(error)
}
check('非法覆盖量报错', rollbackError.includes('覆盖用户量必须为正数'))
check('版本数量未增加（事务回滚）', String(loadDomain().versions.length) === stateBefore)
const profileRowAfter = (await import('./src/data/local-store')).listRows('profile').find((r) => r['画像编号'] === 'PROF-0002')!
check('画像表仍停留在 v6，未留下半成品', profileRowAfter['画像版本'] === 'v6')

console.log('\n[7] 启用事务：方案启用固定初始事件/画像版本/分层区间')
let enableError = ''
try {
  enableRetentionPlan('RETE-0002')
} catch (error) {
  enableError = error instanceof Error ? error.message : String(error)
}
check('重复启用被拒绝（防止破坏版本固定）', enableError.includes('已存在启用快照'))
const binding = findBinding('RETE-0002')!
check('绑定的初始事件与种子一致', binding.initialEvent === 'EVEN-0003 首次下单')
check('种子表 RETE-0002 固定版本字段为 v4', SEED_ROWS.retention.find((r) => r['方案编号'] === 'RETE-0002')!['固定画像版本'] === 'v4')

console.log('\n[8] 两处同时触发：排队两个版本时只接受较新版本，旧版本结果禁止覆盖')
resetDomain()
// 模拟 v5 任务尚未处理时又发布 v6：发布逻辑会用 v6 任务取代同方案的旧任务。
const secondPublish = publishProfileVersion({
  profileCode: 'PROF-0002',
  coverage: 19652,
  dimensions: v5.dimensions,
  metrics: v5.metrics,
  updateCycle: v5.updateCycle,
  layerSpecs: v5.layerSpecs,
  changedLayers: ['高活跃'],
  publishedAt: '2026-11-14',
})
const queued = pendingJobs('RETE-0002')
check('同方案只保留 1 个待重算任务（旧任务被取代）', queued.length === 1, `实际 ${queued.length}`)
check('保留的是较新的 v6 任务', queued[0]?.toVersion === 'v6' && secondPublish.jobs[0]?.toVersion === 'v6')
check('v5 旧任务已不在队列', !queued.some((job) => job.toVersion === 'v5'))
// 即便手工构造一个指向旧版本的任务，重算守卫也会拒绝覆盖。
const staleGuard = (() => {
  try {
    runRecompute('JOB-RETE-0002-v5')
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
})()
check('手工触发旧 v5 任务被拒绝（任务已被取代出队）', staleGuard.includes('不存在或已处理'), staleGuard)
runRecompute(queued[0].jobId)
check('执行 v6 重算后当前快照版本为 v6', latestSnapshot('RETE-0002')!.profileVersion === 'v6')
check('v4/v5 旧快照全部保留为历史对照', listPlanSnapshots('RETE-0002').filter((s) => s.superseded).length >= 2)
check('RETE-0001 全程仍固定 v2', latestSnapshot('RETE-0001')!.profileVersion === 'v2')

console.log(`\n${failures === 0 ? '🎉 全部验证通过' : `⚠️ ${failures} 项失败`}`)
if (failures > 0) {
  process.exitCode = 1
}
