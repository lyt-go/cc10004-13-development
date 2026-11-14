import { useMemo } from 'react'

import {
  findBinding,
  latestSnapshot,
  listPlanSnapshots,
  pendingJobs,
  runRecompute,
} from '@/data/retention-domain'
import type { RetentionSnapshot } from '@/data/types'

type Props = {
  tick: number
  onRecomputed: (message: string, ok: boolean) => void
}

/**
 * 留存方案面板：
 * - 初始事件 / 回访事件 / 观察天数 / 群组粒度与方案固定的画像版本一一对应；
 * - 画像发布新版本后这里出现待重算横幅，只重算受影响分层，旧快照保留为历史对照。
 */
export default function RetentionPlanPanel({ tick, onRecomputed }: Props) {
  const planCodes = useMemo(() => ['RETE-0001', 'RETE-0002'], [])

  // tick 驱动重新读取领域状态，保证执行动作后面板立即更新。
  const plans = useMemo(
    () =>
      planCodes.map((planCode) => ({
        planCode,
        binding: findBinding(planCode),
        snapshots: listPlanSnapshots(planCode),
        current: latestSnapshot(planCode),
        jobs: pendingJobs(planCode),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [planCodes, tick],
  )

  function handleRecompute(jobId: string) {
    try {
      const snapshot = runRecompute(jobId)
      const affected = snapshot.layers.filter((layer) => layer.affected).map((layer) => layer.layerName)
      onRecomputed(
        `${jobId} 重算完成：${snapshot.planCode} 已切换到 ${snapshot.profileVersion}，重算分层「${affected.join('、')}」，其余分层沿用旧结果，旧快照保留为历史对照`,
        true,
      )
    } catch (error) {
      onRecomputed(error instanceof Error ? error.message : '重算失败，事务已回滚', false)
    }
  }

  return (
    <section className="domain-panel" data-testid="retention-plan-panel">
      <h3>画像版本驱动的留存重算面板</h3>
      <p className="panel-note">
        方案启用时固定初始事件、画像版本与分层区间；画像发布新版本后只投递待重算任务，
        重算仅覆盖口径变化的分层（补算窗口 14 天），历史快照不删除、可对照。
      </p>

      <div className="plan-grid">
        {plans.map(({ planCode, binding, snapshots, current, jobs }) => {
          if (!binding || !current) {
            return (
              <article key={planCode} className="plan-card">
                <h4>{planCode}</h4>
                <p className="inline-note">方案未启用或缺少画像绑定，暂无留存快照。</p>
              </article>
            )
          }
          return (
            <article key={planCode} className="plan-card">
              <h4>
                {planCode} · 当前固定 {current.profileCode} {current.profileVersion}
              </h4>

              {jobs.map((job) => (
                <div key={job.jobId} className="job-banner">
                  <span>
                    待重算：{job.fromVersion} → {job.toVersion}，受影响分层「{job.affectedLayers.join('、')}」，
                    触发时间 {job.triggeredAt}
                  </span>
                  <button type="button" className="btn small primary" onClick={() => handleRecompute(job.jobId)}>
                    执行重算
                  </button>
                </div>
              ))}

              <dl className="kv">
                <dt>初始事件</dt>
                <dd>{current.initialEvent}（启用后固定，画像换版不变）</dd>
                <dt>回访事件</dt>
                <dd>{current.returnEvent}</dd>
                <dt>观察天数</dt>
                <dd>{current.observeDays} 天</dd>
                <dt>群组粒度</dt>
                <dd>{current.cohortGranularity}</dd>
                <dt>画像版本</dt>
                <dd>{current.profileVersion}（与上方四项一一对应）</dd>
                <dt>补算窗口</dt>
                <dd>近 {current.recomputeWindowDays} 天初始事件群组</dd>
              </dl>

              {snapshots.map((snapshot: RetentionSnapshot) => (
                <div
                  key={snapshot.snapshotId}
                  className={snapshot.superseded ? 'snapshot-block superseded' : 'snapshot-block'}
                >
                  <div className="snapshot-head">
                    <strong>
                      {snapshot.profileVersion} · {snapshot.reason}
                    </strong>
                    <span className={snapshot.superseded ? 'badge' : 'badge current'}>
                      {snapshot.superseded ? '历史对照' : '当前快照'}
                    </span>
                  </div>
                  <p className="inline-note">
                    快照 {snapshot.snapshotId} · 计算于 {snapshot.computedAt} · 初始事件 {snapshot.initialEvent} ·
                    观察 {snapshot.observeDays} 天 · {snapshot.cohortGranularity}
                  </p>
                  <table className="layer-table">
                    <thead>
                      <tr><th>分层</th><th>区间</th><th>覆盖用户量</th><th>分层留存率</th><th>本次重算</th></tr>
                    </thead>
                    <tbody>
                      {snapshot.layers.map((layer) => (
                        <tr key={layer.layerName}>
                          <td>{layer.layerName}</td>
                          <td>{layer.range}</td>
                          <td>{layer.coverage.toLocaleString()}</td>
                          <td>{layer.retentionRate}%</td>
                          <td>
                            {snapshot.reason === '启用固定' ? (
                              <span className="chip">启用计算</span>
                            ) : layer.affected ? (
                              <span className="chip affected">受影响已重算</span>
                            ) : (
                              <span className="chip">沿用旧版</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </article>
          )
        })}
      </div>
    </section>
  )
}
