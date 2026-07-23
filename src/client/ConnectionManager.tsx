import { useEffect, useState } from 'react'
import { CircleAlert, Database, FileUp, LoaderCircle, Pencil, PlugZap, Trash2, X } from 'lucide-react'
import {
  archiveSource, confirmArchiveSource, registerSource, sourceImpact, testSource, updateSource, uploadData,
  type AuthSession, type DataSource,
} from './api'

type SourceType = DataSource['type']
type Props = { auth: AuthSession; sources: DataSource[]; onChange(sources: DataSource[]): void; onDeleted(id: string): void; onClose(): void }

const empty = { id: '', name: '', type: 'rest-json' as SourceType, baseUrl: '', path: '/', region: 'ap-northeast-1',
  tableName: '', partitionKey: '', sortKey: '', logGroupName: '', maxItems: '1000', maxResults: '1000', maxRangeSeconds: '604800',
  driver: 'postgresql' as 'postgresql' | 'sqlite', secretId: '', schema: 'public', table: '', maxRows: '1000',
  database: '', collection: '', maxDocuments: '1000' }

function summary(source: DataSource): string {
  if (source.type === 'rest-json') return `GET ${source.baseUrl}${source.path}`
  if (source.type === 'dynamodb') return `${source.region} · ${source.tableName}`
  if (source.type === 'cloudwatch-logs') return `${source.region} · ${source.logGroupName}`
  if (source.type === 'sql') return `${source.driver} · ${source.schema ? `${source.schema}.` : ''}${source.table}`
  if (source.type === 'mongodb') return `MongoDB · ${source.database}.${source.collection}`
  return `${source.format.toUpperCase()} upload · ${source.artifactId}`
}

export function ConnectionManager({ auth, sources, onChange, onDeleted, onClose }: Props) {
  const [form, setForm] = useState(empty)
  const [editing, setEditing] = useState<DataSource>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [file, setFile] = useState<File>()

  useEffect(() => {
    if (!editing) return
    setForm({ ...empty, ...editing,
      maxItems: editing.type === 'dynamodb' ? String(editing.maxItems) : empty.maxItems,
      maxResults: editing.type === 'cloudwatch-logs' ? String(editing.maxResults) : empty.maxResults,
      maxRangeSeconds: editing.type === 'cloudwatch-logs' ? String(editing.maxRangeSeconds) : empty.maxRangeSeconds,
      maxRows: editing.type === 'sql' ? String(editing.maxRows) : empty.maxRows,
      maxDocuments: editing.type === 'mongodb' ? String(editing.maxDocuments) : empty.maxDocuments })
  }, [editing])

  function definition() {
    const common = { id: form.id, name: form.name }
    if (form.type === 'rest-json') return { ...common, type: 'rest-json' as const, baseUrl: form.baseUrl, path: form.path, method: 'GET' as const }
    if (form.type === 'dynamodb') return { ...common, type: 'dynamodb' as const, region: form.region, tableName: form.tableName,
      partitionKey: form.partitionKey, ...(form.sortKey ? { sortKey: form.sortKey } : {}), maxItems: Number(form.maxItems) }
    if (form.type === 'cloudwatch-logs') return { ...common, type: 'cloudwatch-logs' as const, region: form.region, logGroupName: form.logGroupName,
      maxResults: Number(form.maxResults), maxRangeSeconds: Number(form.maxRangeSeconds) }
    if (form.type === 'sql') return { ...common, type: 'sql' as const, driver: form.driver, secretId: form.secretId,
      ...(form.driver === 'postgresql' && form.schema ? { schema: form.schema } : {}), table: form.table, maxRows: Number(form.maxRows) }
    if (form.type === 'mongodb') return { ...common, type: 'mongodb' as const, secretId: form.secretId,
      database: form.database, collection: form.collection, maxDocuments: Number(form.maxDocuments) }
    throw new Error('ファイルを選択してください。')
  }

  async function save(event: React.FormEvent) {
    event.preventDefault(); setError(undefined); setBusy('save')
    try {
      if (form.type === 'upload-artifact') {
        if (!file) throw new Error('JSONまたはCSVファイルを選択してください。')
        const format = file.name.toLowerCase().endsWith('.json') ? 'json' : file.name.toLowerCase().endsWith('.csv') ? 'csv' : undefined
        if (!format) throw new Error('拡張子が.jsonまたは.csvのファイルを選択してください。')
        const result = await uploadData(auth, format, file, form.id, form.name)
        onChange([...sources, result.source]); setFile(undefined)
      } else if (editing) {
        const result = await updateSource(auth, { ...definition(), version: editing.version, accessMode: 'read-only', status: 'active' } as DataSource, editing.version)
        onChange(sources.map((source) => source.id === result.source.id ? result.source : source))
      } else {
        const result = await registerSource(auth, definition())
        onChange([...sources, result.source as DataSource])
      }
      setEditing(undefined); setForm(empty)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(undefined) }
  }

  async function test(source: DataSource) {
    setBusy(`test:${source.id}`); setError(undefined)
    try {
      const parameters: Record<string, string> = source.type === 'dynamodb' ? { operation: 'Scan' }
        : source.type === 'cloudwatch-logs' ? { query: 'fields @timestamp, @message | limit 1' }
          : source.type === 'sql' || source.type === 'mongodb' ? { limit: '10' } : {}
      const result = await testSource(auth, source.id, parameters)
      setError(`接続テスト成功: ${result.artifact.rowCount}行を読み取りました。`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(undefined) }
  }

  function cancelEdit() {
    setEditing(undefined); setForm(empty); setError(undefined)
  }

  async function remove(source: DataSource) {
    setBusy(`delete:${source.id}`); setError(undefined)
    try {
      const impact = await sourceImpact(auth, source.id)
      const detail = impact.workflows.length
        ? `\n\n利用中のWorkflow:\n${impact.workflows.map((item) => `・${item.workflowName} v${item.version}`).join('\n')}` : ''
      if (!window.confirm(`接続「${source.name}」をアーカイブします。参照ノードは未設定になります。${detail}`)) return
      if (impact.workflows.length) await confirmArchiveSource(auth, source.id)
      else await archiveSource(auth, source.id)
      onChange(sources.filter((item) => item.id !== source.id)); onDeleted(source.id)
      if (editing?.id === source.id) { setEditing(undefined); setForm(empty) }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(undefined) }
  }

  return <div className="modal-backdrop" role="presentation">
    <form className="connection-modal connection-manager" onSubmit={save} role="dialog" aria-modal="true" aria-label="データソース管理">
      <div className="connection-modal-head"><div><span>ADMIN SETTINGS</span><h2>データソース管理</h2><p>接続情報は管理者だけが変更できます。データの項目と意味はData Catalogで管理します。</p></div>
        <button className="panel-close-button" type="button" onClick={onClose}><X size={14} /><span>閉じる</span></button></div>
      {sources.length > 0 && <div className="registered-connections"><strong>登録済み接続</strong>{sources.map((source) => <div key={source.id}>
        <span><b>{source.name}</b><small>{summary(source)} · v{source.version}</small></span>
        <div className="connection-row-actions"><button type="button" onClick={() => void test(source)} disabled={Boolean(busy)}>{busy === `test:${source.id}` ? <LoaderCircle className="spin" size={14} /> : <PlugZap size={14} />}<span>接続テスト</span></button>
          {source.type !== 'upload-artifact' && <button type="button" onClick={() => { setError(undefined); setEditing(source) }}><Pencil size={14} /><span>編集</span></button>}
          <button className="danger" type="button" onClick={() => void remove(source)} disabled={Boolean(busy)}><Trash2 size={14} /><span>アーカイブ</span></button></div>
      </div>)}</div>}
      <div className="connection-tabs" aria-label="データソースの種類">
        {([['rest-json', 'REST API'], ['sql', 'SQL'], ['mongodb', 'MongoDB'], ['dynamodb', 'DynamoDB'], ['cloudwatch-logs', 'CloudWatch Logs'], ['upload-artifact', 'JSON / CSV']] as const).map(([type, label]) =>
          <button type="button" className={form.type === type ? 'active' : ''} disabled={Boolean(editing)} onClick={() => { setError(undefined); setForm({ ...empty, type }) }} key={type}>{label}</button>)}
      </div>
      <div className="connection-grid"><label>接続ID<input required pattern="[a-z][a-z0-9_-]*" disabled={Boolean(editing)} value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} /></label>
        <label>表示名<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label></div>
      {form.type === 'rest-json' && <><label>Base URL<input required type="url" placeholder="https://api.example.com" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></label>
        <div className="connection-grid method-path"><label>Method<select value="GET" disabled><option>GET</option></select></label><label>Path<input required value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} /></label></div></>}
      {form.type === 'dynamodb' && <><div className="connection-grid"><label>Region<input required value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} /></label><label>Table<input required value={form.tableName} onChange={(e) => setForm({ ...form, tableName: e.target.value })} /></label></div>
        <div className="connection-grid"><label>Partition key<input required value={form.partitionKey} onChange={(e) => setForm({ ...form, partitionKey: e.target.value })} /></label><label>Sort key（任意）<input value={form.sortKey} onChange={(e) => setForm({ ...form, sortKey: e.target.value })} /></label></div></>}
      {form.type === 'cloudwatch-logs' && <><div className="connection-grid"><label>Region<input required value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} /></label><label>最大結果件数<input required type="number" value={form.maxResults} onChange={(e) => setForm({ ...form, maxResults: e.target.value })} /></label></div>
        <label>Log group<input required value={form.logGroupName} onChange={(e) => setForm({ ...form, logGroupName: e.target.value })} /></label></>}
      {form.type === 'sql' && <><div className="connection-grid"><label>Driver<select value={form.driver} onChange={(e) => setForm({ ...form, driver: e.target.value as 'postgresql' | 'sqlite' })}><option value="postgresql">PostgreSQL</option><option value="sqlite">SQLite</option></select></label>
        <label>Secret ID<input required value={form.secretId} onChange={(e) => setForm({ ...form, secretId: e.target.value })} /></label></div>
        <div className="connection-grid">{form.driver === 'postgresql' && <label>Schema<input required value={form.schema} onChange={(e) => setForm({ ...form, schema: e.target.value })} /></label>}
          <label>Table<input required value={form.table} onChange={(e) => setForm({ ...form, table: e.target.value })} /></label></div>
        <label>最大行数<input required type="number" min="1" max="5000" value={form.maxRows} onChange={(e) => setForm({ ...form, maxRows: e.target.value })} /></label></>}
      {form.type === 'mongodb' && <><label>Secret ID<input required value={form.secretId} onChange={(e) => setForm({ ...form, secretId: e.target.value })} /></label>
        <div className="connection-grid"><label>Database<input required value={form.database} onChange={(e) => setForm({ ...form, database: e.target.value })} /></label>
          <label>Collection<input required value={form.collection} onChange={(e) => setForm({ ...form, collection: e.target.value })} /></label></div>
        <label>最大document数<input required type="number" min="1" max="5000" value={form.maxDocuments} onChange={(e) => setForm({ ...form, maxDocuments: e.target.value })} /></label></>}
      {form.type === 'upload-artifact' && <label className="file-input"><FileUp size={18} /> JSON / CSVファイル<input required type="file" accept=".json,.csv,application/json,text/csv" onChange={(e) => setFile(e.target.files?.[0])} /><small>{file?.name ?? 'ファイルを選択してください'}</small></label>}
      {error && <div className={`connection-error ${error.startsWith('接続テスト成功') ? 'success' : ''}`}><CircleAlert size={14} />{error}</div>}
      <div className="connection-form-actions">{editing && <button className="connection-cancel" type="button" onClick={cancelEdit} disabled={Boolean(busy)}>編集をキャンセル</button>}
        <button className="connection-submit" type="submit" disabled={Boolean(busy)}>{busy === 'save' ? <LoaderCircle className="spin" size={15} /> : <Database size={15} />} {editing ? '変更を保存' : form.type === 'upload-artifact' ? '検証して登録' : '接続を登録'}</button></div>
    </form>
  </div>
}
