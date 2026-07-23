import { useState } from 'react'
import { Download, LoaderCircle, X } from 'lucide-react'
import type { ArtifactSummary } from '../shared/workflow'
import { downloadArtifact, requestArtifactDownload, type AuthSession } from './api'
import { ApprovalSummary } from './ApprovalSummary'

export function ArtifactDownloadButton({ auth, artifact }: { auth: AuthSession; artifact: ArtifactSummary }) {
  const [approval, setApproval] = useState<{ id: string; expiresAt: string; summary: Record<string, unknown> }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  async function prepare() {
    setBusy(true); setError(undefined)
    try { setApproval(await requestArtifactDownload(auth, artifact.id)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  async function confirm() {
    if (!approval) return
    setBusy(true); setError(undefined)
    try {
      const blob = await downloadArtifact(auth, artifact.id, approval.id)
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a')
      anchor.href = url; anchor.download = artifact.name; anchor.click(); URL.revokeObjectURL(url); setApproval(undefined)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return <span className="artifact-download-action">
    <button disabled={busy} onClick={() => void prepare()}>{busy ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />} ダウンロード</button>
    {error && <small>{error}</small>}
    {approval && <div className="modal-backdrop"><section className="approval-modal" role="dialog" aria-modal="true" aria-label="成果物ダウンロードの確認">
      <header><div><span>DOWNLOAD APPROVAL</span><h2>この成果物を端末へ保存しますか？</h2></div><button className="panel-close-button" onClick={() => setApproval(undefined)}><X size={14} /><span>閉じる</span></button></header>
      <ApprovalSummary summary={approval.summary} />
      <p>内容確認用ハッシュが一致するこの成果物だけを、一度ダウンロードできます。この確認は他の成果物には使用できません。</p>
      <footer><button onClick={() => setApproval(undefined)}>キャンセル</button><button className="primary" disabled={busy} onClick={() => void confirm()}>確認してダウンロード</button></footer>
    </section></div>}
  </span>
}
