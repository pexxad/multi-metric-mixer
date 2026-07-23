import { CalendarClock, FileText, FolderOpen, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import type { AuthSession, WorkflowListItem } from './api'

const statusLabels: Record<WorkflowListItem['status'], string> = {
  draft: '設定未完了',
  ready: '実行可能',
  stale: '要確認',
  archived: '削除済み',
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '更新日時不明' : new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date)
}

export function WorkflowManager({ auth, workflows, activeWorkflowId, activeDirty, onOpen, onCreate, onDelete, onClose }: {
  auth: AuthSession
  workflows: WorkflowListItem[]
  activeWorkflowId: string
  activeDirty: boolean
  onOpen(id: string): Promise<void>
  onCreate(): void
  onDelete(item: WorkflowListItem): Promise<void>
  onClose(): void
}) {
  const [deleteTarget, setDeleteTarget] = useState<WorkflowListItem>()
  const [busyId, setBusyId] = useState<string>()
  const [error, setError] = useState<string>()
  const canDelete = auth.workspace.role === 'owner' || auth.workspace.role === 'editor'

  async function open(id: string) {
    setError(undefined); setBusyId(id)
    try { await onOpen(id) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Workflowを開けませんでした。') }
    finally { setBusyId(undefined) }
  }

  async function remove() {
    if (!deleteTarget) return
    setError(undefined); setBusyId(deleteTarget.workflow.id)
    try { await onDelete(deleteTarget); setDeleteTarget(undefined) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Workflowを削除できませんでした。') }
    finally { setBusyId(undefined) }
  }

  return <div className="modal-backdrop"><section className="workflow-manager" role="dialog" aria-modal="true" aria-label="Workflow管理">
    <header>
      <div><span>WORKFLOW MANAGEMENT</span><h2>Workflow管理</h2><p>保存済みWorkflowを開く、新規作成する、または削除できます。</p></div>
      <button className="panel-close-button" type="button" onClick={onClose}><X size={14} /><span>閉じる</span></button>
    </header>

    <div className="workflow-manager-toolbar">
      <div><strong>{workflows.length}</strong><span>件の保存済みWorkflow</span></div>
      <button className="primary" type="button" onClick={onCreate}><Plus size={14} /><span>新規Workflow</span></button>
    </div>

    {error && <div className="workflow-manager-error" role="alert">{error}</div>}
    {deleteTarget && <section className="workflow-delete-confirmation" aria-label="Workflow削除の確認">
      <div><strong>「{deleteTarget.workflow.name}」を削除しますか？</strong>
        <p>一覧と編集画面から非表示になります。過去のバージョン・実行履歴・監査記録は保持されます。{deleteTarget.workflow.id === activeWorkflowId && activeDirty ? ' 未保存の変更は失われます。' : ''}</p></div>
      <div><button type="button" onClick={() => setDeleteTarget(undefined)} disabled={Boolean(busyId)}>キャンセル</button>
        <button className="danger" type="button" onClick={() => void remove()} disabled={Boolean(busyId)}><Trash2 size={14} /><span>{busyId ? '削除中…' : '削除する'}</span></button></div>
    </section>}

    <div className="workflow-list">
      {workflows.length === 0 && <div className="workflow-list-empty"><FileText size={24} /><strong>保存済みWorkflowはありません</strong><span>「新規Workflow」から作成を開始できます。</span></div>}
      {workflows.map((item) => {
        const active = item.workflow.id === activeWorkflowId
        return <article className={active ? 'active' : ''} key={item.workflow.id}>
          <div className="workflow-list-main"><span className="workflow-list-icon"><FileText size={17} /></span><div>
            <div className="workflow-list-title"><strong>{item.workflow.name}</strong>{active && <span className="active-label">編集中</span>}</div>
            <p>{item.workflow.description || '説明は登録されていません。'}</p>
            <div className="workflow-list-meta"><span>v{item.version}</span><span className={`workflow-status ${item.status}`}>{statusLabels[item.status]}</span>
              <span><CalendarClock size={12} />{formatUpdatedAt(item.updatedAt)}</span><span>{item.workflow.steps.length}ノード</span></div>
          </div></div>
          <div className="workflow-list-actions">
            <button type="button" onClick={() => void open(item.workflow.id)} disabled={active || Boolean(busyId)}><FolderOpen size={14} /><span>{active ? '編集中' : '開く'}</span></button>
            {canDelete && <button className="danger" type="button" onClick={() => { setError(undefined); setDeleteTarget(item) }} disabled={Boolean(busyId)}><Trash2 size={14} /><span>削除</span></button>}
          </div>
        </article>
      })}
    </div>
    {!canDelete && <p className="workflow-manager-permission">削除はWorkspaceのオーナーまたは編集者だけが実行できます。</p>}
  </section></div>
}
