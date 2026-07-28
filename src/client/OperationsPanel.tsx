import { useEffect, useMemo, useState } from 'react'
import { CircleAlert, FileText, History, LoaderCircle, X } from 'lucide-react'
import { loadArtifacts, loadRuns, type AuthSession, type RunRecord, type WorkflowListItem } from './api'
import type { ArtifactSummary } from '../shared/workflow'
import { ArtifactDownloadButton } from './ArtifactDownloadButton'

const runStatusLabels: Record<string, string> = { completed: '完了', failed: '失敗', running: '実行中' }
const classificationLabels: Record<ArtifactSummary['classification'], string> = { internal: '社内向け', confidential: '機密', restricted: '取扱制限' }

export function OperationsPanel({ auth, workflows, onClose }: { auth: AuthSession; workflows: WorkflowListItem[]; onClose(): void }) {
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([])
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const workflowNames = useMemo(() => new Map(workflows.map((item) => [item.workflow.id, item.workflow.name])), [workflows])
  useEffect(() => {
    let active = true
    void Promise.all([loadRuns(), loadArtifacts()]).then(([runResult, artifactResult]) => {
      if (active) { setRuns(runResult.runs); setArtifacts(artifactResult.artifacts) }
    }).catch((cause) => active && setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => active && setLoading(false))
    return () => { active = false }
  }, [auth])
  return <div className="modal-backdrop"><section className="operations-modal" role="dialog" aria-modal="true" aria-label="実行と成果物の履歴">
    <header><div><span>OPERATIONS</span><h2>実行と成果物</h2><p>このWorkspaceに永続化された履歴です。</p></div><button className="panel-close-button" onClick={onClose}><X size={14} /><span>閉じる</span></button></header>
    {loading && <div className="operations-empty"><LoaderCircle className="spin" size={18} /> 読み込み中</div>}
    {error && <div className="connection-error"><CircleAlert size={14} />{error}</div>}
    {!loading && <div className="operations-columns"><section><h3><History size={15} /> 実行履歴</h3>{runs.length === 0 ? <p className="operations-empty">実行履歴はありません。</p> : runs.map((run) => <article key={run.id}>
      <div><strong>{workflowNames.get(run.workflowId) ?? '削除済みまたは参照できないWorkflow'} · v{run.workflowVersion}</strong><span className={`status ${run.status}`}>{runStatusLabels[run.status] ?? run.status}</span></div>
      <small>{new Date(run.startedAt).toLocaleString('ja-JP')} · 実行ID: {run.id}</small>
      {run.status === 'failed' && <p>{failureReason(run.summary)}</p>}
    </article>)}</section><section><h3><FileText size={15} /> 成果物</h3>{artifacts.length === 0 ? <p className="operations-empty">成果物はありません。</p> : artifacts.map((artifact) => <article key={artifact.id}>
      <div><strong>{artifact.name}</strong><span>{artifact.rowCount}行</span></div><small>{new Date(artifact.createdAt).toLocaleString('ja-JP')} · {classificationLabels[artifact.classification]}</small>
      <p>{artifact.columns.join(', ') || '列情報なし'}</p>{artifact.type === 'csv' && <ArtifactDownloadButton auth={auth} artifact={artifact} />}
    </article>)}</section></div>}
  </section></div>
}

function failureReason(summary: unknown): string {
  if (!summary || typeof summary !== 'object') return '失敗理由は記録されていません。'
  const code = (summary as { errorCode?: unknown }).errorCode
  return typeof code === 'string' ? `失敗理由: ${code}` : '失敗理由は記録されていません。'
}
