import { useMemo, useState } from 'react'

import {
  bindingForProfile,
  listProfileVersions,
  pendingJobs,
} from '@/data/retention-domain'
import type { ProfileVersion } from '@/data/types'

type Props = {
  /** 面板刷新序号：父组件执行动作后 +1，面板据此重新读领域状态 */
  tick: number
}

/**
 * 画像版本面板：同一画像的各发布版本并列展示，
 * 统计维度 / 聚合指标 / 分层区间 / 更新周期 / 覆盖用户量全部按版本冻结。
 */
export default function ProfileVersionPanel({ tick }: Props) {
  const profileCodes = useMemo(() => ['PROF-0002', 'PROF-0001'], [])
  const [selected, setSelected] = useState('PROF-0002')

  // tick 变化时重新读取，保证动作后面板立即更新。
  const versions = useMemo(
    () => listProfileVersions(selected),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, tick],
  )
  const latestLabel = versions[0]?.version
  const linkedPlans = bindingForProfile(selected).map((binding) => binding.planCode).join('、') || '无'
  const queuedJobs = pendingJobs().filter((job) => job.profileCode === selected)

  return (
    <section className="domain-panel" data-testid="profile-version-panel">
      <h3>画像版本面板（版本冻结口径，换版不改写历史）</h3>
      <p className="panel-note">
        切换画像查看各已发布版本；引用该画像的留存方案：{linkedPlans}。
        {queuedJobs.length > 0 && (
          <> 当前有 {queuedJobs.length} 个待重算任务（{queuedJobs.map((job) => job.jobId).join('、')}）。</>
        )}
      </p>

      <div className="filter-bar">
        {profileCodes.map((code) => (
          <button
            key={code}
            type="button"
            className={code === selected ? 'btn small primary' : 'btn small'}
            onClick={() => setSelected(code)}
          >
            {code}
          </button>
        ))}
      </div>

      <div className="version-grid">
        {versions.map((version: ProfileVersion) => {
          const isCurrent = version.version === latestLabel
          return (
            <article key={version.version} className={isCurrent ? 'version-card current' : 'version-card'}>
              <div className="version-head">
                <strong>
                  {version.profileCode} · {version.version}
                </strong>
                <span className={isCurrent ? 'badge current' : 'badge'}>{isCurrent ? '当前生效版本' : '历史版本'}</span>
              </div>
              <dl className="kv">
                <dt>发布时间</dt>
                <dd>{version.publishedAt}</dd>
                <dt>覆盖用户量</dt>
                <dd>{version.coverage.toLocaleString()} 人</dd>
                <dt>更新周期</dt>
                <dd>{version.updateCycle}</dd>
              </dl>
              <div>
                <div className="inline-note">统计维度</div>
                <div className="chip-row">
                  {version.dimensions.map((item) => (
                    <span key={item} className="chip">{item}</span>
                  ))}
                </div>
              </div>
              <div>
                <div className="inline-note">聚合指标</div>
                <div className="chip-row">
                  {version.metrics.map((item) => (
                    <span key={item} className="chip">{item}</span>
                  ))}
                </div>
              </div>
              <div>
                <div className="inline-note">分层区间（冻结）</div>
                <table className="layer-table">
                  <thead>
                    <tr><th>分层</th><th>区间</th><th>口径指纹</th></tr>
                  </thead>
                  <tbody>
                    {version.layerSpecs.map((spec) => (
                      <tr key={spec.layerName}>
                        <td>{spec.layerName}</td>
                        <td>{spec.range}</td>
                        <td>{spec.fingerprint}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
