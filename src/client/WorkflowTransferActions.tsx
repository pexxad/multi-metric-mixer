import { useRef, useState } from 'react'
import { Download, FileUp, LoaderCircle, X } from 'lucide-react'
import { exportWorkflow, importWorkflow, requestWorkflowExport, type AuthSession, type SavedWorkflow } from './api'
import { ApprovalSummary } from './ApprovalSummary'

export function WorkflowTransferActions({ auth, saved, onImported }: { auth: AuthSession; saved?: SavedWorkflow; onImported(value: SavedWorkflow): void }) {
  const input = useRef<HTMLInputElement>(null)
  const [approval, setApproval] = useState<{ id: string; expiresAt: string; summary: Record<string, unknown> }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function prepareExport() {
    if (!saved) return
    setBusy(true); setError(undefined)
    try { setApproval(await requestWorkflowExport(auth, saved.workflow.id, saved.version)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  async function confirmExport() {
    if (!saved || !approval) return
    setBusy(true)
    try {
      const transfer = await exportWorkflow(auth, saved.workflow.id, saved.version, approval.id)
      const url = URL.createObjectURL(new Blob([JSON.stringify(transfer, null, 2)], { type: 'application/json' }))
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${saved.workflow.name}.workflow.json`; anchor.click()
      URL.revokeObjectURL(url); setApproval(undefined)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  async function load(file?: File) {
    if (!file) return
    setBusy(true); setError(undefined)
    try {
      if (file.size > 256 * 1024) throw new Error('Workflowファイルは256 KiB以下にしてください。')
      const result = await importWorkflow(auth, JSON.parse(await file.text()) as unknown)
      onImported(result.saved)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Workflowファイルを読み込めませんでした。') }
    finally { setBusy(false); if (input.current) input.current.value = '' }
  }

  return <div className="transfer-actions">
    <button className="toolbar-button" disabled={!saved || busy} onClick={() => void prepareExport()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}<span>書き出す</span></button>
    <button className="toolbar-button" onClick={() => input.current?.click()}><FileUp size={15} /><span>読み込む</span></button>
    <input ref={input} hidden type="file" accept="application/json,.json" onChange={(event) => void load(event.target.files?.[0])} />
    {error && <span className="transfer-error">{error}</span>}
    {approval && <div className="modal-backdrop"><section className="approval-modal" role="dialog" aria-modal="true" aria-label="Workflow書き出しの確認">
      <header><div><span>EXPORT APPROVAL</span><h2>このWorkflowを書き出しますか？</h2></div><button className="panel-close-button" onClick={() => setApproval(undefined)}><X size={14} /><span>閉じる</span></button></header>
      <ApprovalSummary summary={approval.summary} />
      <p>接続情報、秘密情報、成果物、ログイン情報、Workspaceメンバー情報は含まれません。この確認は表示中のバージョンに一度だけ使用できます。</p>
      <footer><button onClick={() => setApproval(undefined)}>キャンセル</button><button className="primary" disabled={busy} onClick={() => void confirmExport()}>確認して書き出す</button></footer>
    </section></div>}
  </div>
}
