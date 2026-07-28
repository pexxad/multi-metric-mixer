import { useEffect, useState } from 'react'
import { CircleAlert, Database, FileUp, LoaderCircle, Pencil, PlugZap, Trash2, X } from 'lucide-react'
import {
  archiveSource, confirmArchiveSource, loadAdminDataSources, loadConnectionProfiles, registerSource, sourceImpact, testSource, updateSource, uploadData,
  type AdminDataSource, type AuthSession, type ConnectionProfile, type DataSource,
} from './api'
import type { QueryTemplate, QueryVariable } from '../shared/query-template'

type SourceType = AdminDataSource['type']
type Props = { auth: AuthSession; onSaved(source: DataSource, isNew: boolean): void; onDeleted(id: string): void; onClose(): void }

const empty = { id: '', name: '', type: 'rest-json' as SourceType, baseUrl: '', path: '/', region: 'ap-northeast-1',
  tableName: '', partitionKey: '', sortKey: '', logGroupName: '', maxItems: '1000', maxResults: '1000', maxRangeSeconds: '604800',
  queryMode: 'sample' as 'sample' | 'template-required', templateId: '', templateName: '', templateDescription: '',
  templateOutput: 'documents' as 'documents' | 'table', templateOutputFields: '',
  templateQuery: 'fields @timestamp, @message | filter @message like {{keyword}} | sort @timestamp desc',
  connectionId: '', schema: 'public', table: '', maxRows: '1000',
  database: '', collection: '', maxDocuments: '1000' }

function summary(source: AdminDataSource, profiles: ConnectionProfile[]): string {
  if (source.type === 'rest-json') return `GET ${source.baseUrl}${source.path}`
  if (source.type === 'dynamodb') return `${source.region} · ${source.tableName}`
  if (source.type === 'cloudwatch-logs') return `${source.region} · ${source.logGroupName}`
  if (source.type === 'database-table') return `${profiles.find((item) => item.id === source.connectionId)?.displayName ?? source.connectionId} · ${source.schema ? `${source.schema}.` : ''}${source.table}`
  if (source.type === 'database-documents') return `${profiles.find((item) => item.id === source.connectionId)?.displayName ?? source.connectionId} · ${source.database}.${source.collection}`
  return `${source.format.toUpperCase()} upload · ${source.artifactId}`
}

export function ConnectionManager({ auth, onSaved, onDeleted, onClose }: Props) {
  const [sources, setSources] = useState<AdminDataSource[]>([])
  const [form, setForm] = useState(empty)
  const [editing, setEditing] = useState<AdminDataSource>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [file, setFile] = useState<File>()
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([])
  const [templateVariables, setTemplateVariables] = useState<QueryVariable[]>([])
  const [queryTemplates, setQueryTemplates] = useState<QueryTemplate[]>([])

  useEffect(() => {
    void Promise.all([loadConnectionProfiles(), loadAdminDataSources()]).then(([profileResult, sourceResult]) => {
      setProfiles(profileResult.connections)
      setSources(sourceResult.sources)
    })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [])

  useEffect(() => {
    if (!editing) return
    setForm({ ...empty, ...editing,
      maxItems: editing.type === 'dynamodb' ? String(editing.maxItems) : empty.maxItems,
      maxResults: editing.type === 'cloudwatch-logs' ? String(editing.maxResults) : empty.maxResults,
      maxRangeSeconds: editing.type === 'cloudwatch-logs' ? String(editing.maxRangeSeconds) : empty.maxRangeSeconds,
      maxRows: editing.type === 'database-table' ? String(editing.maxRows) : empty.maxRows,
      maxDocuments: editing.type === 'database-documents' ? String(editing.maxDocuments) : empty.maxDocuments })
    if (editing.type === 'cloudwatch-logs' && editing.queryTemplates[0]) {
      const template = editing.queryTemplates[0]
      setForm((current) => ({ ...current, templateId: template.id, templateName: template.name,
        templateDescription: template.description, templateOutput: template.outputDataModel,
        templateOutputFields: template.outputFields.join(','), templateQuery: template.execution?.query ?? current.templateQuery }))
      setTemplateVariables(template.variables)
      setQueryTemplates(editing.queryTemplates.slice(1).filter((item): item is QueryTemplate => Boolean(item.execution)))
    } else { setTemplateVariables([]); setQueryTemplates([]) }
  }, [editing])

  function currentQueryTemplate(): QueryTemplate | undefined {
    if (!form.templateId) return undefined
    return {
      id: form.templateId, name: form.templateName, description: form.templateDescription, outputDataModel: form.templateOutput,
      outputFields: form.templateOutputFields.split(',').map((value) => value.trim()).filter(Boolean),
      variables: templateVariables, execution: { kind: 'cloudwatch-logs-insights', query: form.templateQuery,
        startTimeVariable: 'startTime', endTimeVariable: 'endTime' },
    }
  }

  function clearTemplateDraft() {
    setForm((current) => ({ ...current, templateId: '', templateName: '', templateDescription: '',
      templateOutput: 'documents', templateOutputFields: '', templateQuery: 'fields @timestamp, @message | sort @timestamp desc' }))
    setTemplateVariables([
      { id: 'startTime', label: '開始日時', description: '', required: true, input: 'datetime', type: 'datetime' },
      { id: 'endTime', label: '終了日時', description: '', required: true, input: 'datetime', type: 'datetime' },
    ])
  }

  function stageTemplate() {
    const template = currentQueryTemplate()
    if (!template) { setError('検索パターンIDを入力してください。'); return }
    setQueryTemplates((items) => [...items.filter((item) => item.id !== template.id), template])
    clearTemplateDraft()
  }

  function editTemplate(template: QueryTemplate) {
    setQueryTemplates((items) => items.filter((item) => item.id !== template.id))
    setForm((current) => ({ ...current, templateId: template.id, templateName: template.name,
      templateDescription: template.description, templateOutput: template.outputDataModel,
      templateOutputFields: template.outputFields.join(','), templateQuery: template.execution?.query ?? current.templateQuery }))
    setTemplateVariables(template.variables)
  }

  function definition() {
    const common = { id: form.id, name: form.name }
    if (form.type === 'rest-json') return { ...common, type: 'rest-json' as const, baseUrl: form.baseUrl, path: form.path, method: 'GET' as const }
    if (form.type === 'dynamodb') return { ...common, type: 'dynamodb' as const, region: form.region, tableName: form.tableName,
      partitionKey: form.partitionKey, ...(form.sortKey ? { sortKey: form.sortKey } : {}), maxItems: Number(form.maxItems) }
    if (form.type === 'cloudwatch-logs') {
      const current = currentQueryTemplate()
      const templates: QueryTemplate[] = [...queryTemplates, ...(current ? [current] : [])]
      const deduplicated = [...new Map(templates.map((template) => [template.id, template])).values()]
      const registeredTemplates: QueryTemplate[] = form.queryMode === 'template-required' ? deduplicated : []
      return { ...common, type: 'cloudwatch-logs' as const, region: form.region, logGroupName: form.logGroupName,
        maxResults: Number(form.maxResults), maxRangeSeconds: Number(form.maxRangeSeconds), queryMode: form.queryMode,
        queryTemplates: registeredTemplates }
    }
    if (form.type === 'database-table') return { ...common, type: 'database-table' as const, connectionId: form.connectionId,
      ...(form.schema ? { schema: form.schema } : {}), table: form.table, maxRows: Number(form.maxRows) }
    if (form.type === 'database-documents') return { ...common, type: 'database-documents' as const, connectionId: form.connectionId,
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
        setSources((items) => [...items, result.source]); onSaved(result.capability, true); setFile(undefined)
      } else if (editing) {
        const result = await updateSource(auth, { ...definition(), version: editing.version,
          accessMode: 'read-only', status: 'active' } as AdminDataSource, editing.version)
        setSources((items) => items.map((source) => source.id === result.source.id ? result.source : source))
        onSaved(result.capability, false)
      } else {
        const result = await registerSource(auth, definition())
        setSources((items) => [...items, result.source])
        onSaved(result.capability, true)
      }
      setEditing(undefined); setForm(empty); setTemplateVariables([]); setQueryTemplates([])
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(undefined) }
  }

  async function test(source: AdminDataSource) {
    setBusy(`test:${source.id}`); setError(undefined)
    try {
      const result = await testSource(auth, source.id)
      const unit = result.artifact.type === 'table' ? '行' : '件'
      setError(`接続テスト成功: ${result.artifact.rowCount}${unit}を読み取りました。`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(undefined) }
  }

  function cancelEdit() {
    setEditing(undefined); setForm(empty); setTemplateVariables([]); setQueryTemplates([]); setError(undefined)
  }

  async function remove(source: AdminDataSource) {
    setBusy(`delete:${source.id}`); setError(undefined)
    try {
      const impact = await sourceImpact(source.id)
      const detail = impact.workflows.length
        ? `\n\n利用中のWorkflow:\n${impact.workflows.map((item) => `・${item.workflowName} v${item.version}`).join('\n')}` : ''
      if (!window.confirm(`接続「${source.name}」をアーカイブします。参照ノードは未設定になります。${detail}`)) return
      if (impact.workflows.length) await confirmArchiveSource(auth, source.id)
      else await archiveSource(auth, source.id)
      setSources((items) => items.filter((item) => item.id !== source.id)); onDeleted(source.id)
      if (editing?.id === source.id) { setEditing(undefined); setForm(empty) }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(undefined) }
  }

  return <div className="modal-backdrop" role="presentation">
    <form className="connection-modal connection-manager" onSubmit={save} role="dialog" aria-modal="true" aria-label="データソース管理">
      <div className="connection-modal-head"><div><span>ADMIN SETTINGS</span><h2>データソース管理</h2><p>接続情報は管理者だけが変更できます。データの項目と意味はData Catalogで管理します。</p></div>
        <button className="panel-close-button" type="button" onClick={onClose}><X size={14} /><span>閉じる</span></button></div>
      {sources.length > 0 && <div className="registered-connections"><strong>登録済み接続</strong>{sources.map((source) => <div key={source.id}>
        <span><b>{source.name}</b><small>{summary(source, profiles)} · v{source.version}</small></span>
        <div className="connection-row-actions">{(source.type !== 'cloudwatch-logs' || source.queryMode === 'sample') && <button type="button" onClick={() => void test(source)} disabled={Boolean(busy)}>{busy === `test:${source.id}` ? <LoaderCircle className="spin" size={14} /> : <PlugZap size={14} />}<span>接続テスト</span></button>}
          {source.type !== 'upload-artifact' && <button type="button" onClick={() => { setError(undefined); setEditing(source) }}><Pencil size={14} /><span>編集</span></button>}
          <button className="danger" type="button" onClick={() => void remove(source)} disabled={Boolean(busy)}><Trash2 size={14} /><span>アーカイブ</span></button></div>
      </div>)}</div>}
      <div className="connection-tabs" aria-label="データソースの種類">
        {([['rest-json', 'REST API'], ['database-table', '表形式DB'], ['database-documents', 'JSONライクDB'], ['dynamodb', 'DynamoDB'], ['cloudwatch-logs', 'CloudWatch Logs'], ['upload-artifact', 'JSON / CSV']] as const).map(([type, label]) =>
          <button type="button" className={form.type === type ? 'active' : ''} disabled={Boolean(editing)} onClick={() => { setError(undefined); setForm({ ...empty, type }) }} key={type}>{label}</button>)}
      </div>
      <div className="connection-grid"><label>接続ID<input required pattern="[a-z][a-z0-9_-]*" disabled={Boolean(editing)} value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} /></label>
        <label>表示名<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label></div>
      {form.type === 'rest-json' && <><label>Base URL<input required type="url" placeholder="https://api.example.com" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></label>
        <div className="connection-grid method-path"><label>Method<select value="GET" disabled><option>GET</option></select></label><label>Path<input required value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} /></label></div></>}
      {form.type === 'dynamodb' && <><div className="connection-grid"><label>Region<input required value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} /></label><label>Table<input required value={form.tableName} onChange={(e) => setForm({ ...form, tableName: e.target.value })} /></label></div>
        <div className="connection-grid"><label>Partition key<input required value={form.partitionKey} onChange={(e) => setForm({ ...form, partitionKey: e.target.value })} /></label><label>Sort key（任意）<input value={form.sortKey} onChange={(e) => setForm({ ...form, sortKey: e.target.value })} /></label></div></>}
      {form.type === 'cloudwatch-logs' && <><div className="connection-grid"><label>Region<input required value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} /></label><label>最大結果件数<input required type="number" value={form.maxResults} onChange={(e) => setForm({ ...form, maxResults: e.target.value })} /></label></div>
        <label>Log group<input required value={form.logGroupName} onChange={(e) => setForm({ ...form, logGroupName: e.target.value })} /></label>
        <label>取得方式<select value={form.queryMode} onChange={(e) => {
          const queryMode = e.target.value as 'sample' | 'template-required'
          setForm({ ...form, queryMode })
          if (queryMode === 'template-required' && templateVariables.length === 0) setTemplateVariables([
            { id: 'startTime', label: '開始日時', description: '', required: true, input: 'datetime', type: 'datetime' },
            { id: 'endTime', label: '終了日時', description: '', required: true, input: 'datetime', type: 'datetime' },
          ])
        }}><option value="sample">小規模サンプル取得</option><option value="template-required">検索パターン必須</option></select></label>
        {form.queryMode === 'template-required' && <fieldset className="query-template-editor"><legend>検索パターン</legend>
          {queryTemplates.length > 0 && <div className="registered-query-templates"><strong>追加済みパターン</strong>{queryTemplates.map((template) =>
            <div key={template.id}><span><b>{template.name}</b><small>{template.id} · {template.variables.length}変数</small></span>
              <button type="button" onClick={() => editTemplate(template)}><Pencil size={13} />編集</button>
              <button type="button" onClick={() => setQueryTemplates((items) => items.filter((item) => item.id !== template.id))}><Trash2 size={13} />削除</button></div>)}</div>}
          <div className="connection-grid"><label>パターンID<input required={queryTemplates.length === 0} pattern="[a-z][a-z0-9_-]*" value={form.templateId} onChange={(e) => setForm({ ...form, templateId: e.target.value })} /></label>
            <label>表示名<input required={queryTemplates.length === 0} value={form.templateName} onChange={(e) => setForm({ ...form, templateName: e.target.value })} /></label></div>
          <label>説明<textarea value={form.templateDescription} onChange={(e) => setForm({ ...form, templateDescription: e.target.value })} /></label>
          <label>出力形式<select value={form.templateOutput} onChange={(e) => setForm({ ...form, templateOutput: e.target.value as 'documents' | 'table' })}>
            <option value="documents">JSONライク</option><option value="table">表形式</option></select></label>
          <label>出力項目（カンマ区切り）<input value={form.templateOutputFields}
            onChange={(e) => setForm({ ...form, templateOutputFields: e.target.value })} placeholder="@timestamp,service,message" /></label>
          <label>Logs Insightsパターン<textarea required={queryTemplates.length === 0} rows={4} value={form.templateQuery} onChange={(e) => setForm({ ...form, templateQuery: e.target.value })}
            aria-describedby="query-template-help" /></label>
          <small id="query-template-help">変数は&#123;&#123;variableId&#125;&#125;で埋め込みます。開始・終了日時は検索期間として別途適用されます。</small>
          <div className="template-variable-list"><strong>入力変数</strong>{templateVariables.map((variable, index) => <div className="template-variable-row" key={`${variable.id}-${index}`}>
            <input aria-label={`変数ID ${index + 1}`} disabled={variable.id === 'startTime' || variable.id === 'endTime'} value={variable.id}
              onChange={(e) => setTemplateVariables((items) => items.map((item, i) => i === index ? { ...item, id: e.target.value } : item))} />
            <input aria-label={`変数ラベル ${index + 1}`} value={variable.label}
              onChange={(e) => setTemplateVariables((items) => items.map((item, i) => i === index ? { ...item, label: e.target.value } : item))} />
            <select aria-label={`入力方法 ${index + 1}`} disabled={variable.type === 'datetime'} value={variable.input}
              onChange={(e) => {
                const input = e.target.value
                setTemplateVariables((items) => items.map((item, i) => i !== index ? item
                  : input === 'select' ? { id: item.id, label: item.label, description: item.description, required: item.required,
                    input: 'select', type: 'string', options: [{ value: 'value', label: '選択肢' }] }
                    : input === 'number' ? { id: item.id, label: item.label, description: item.description, required: item.required,
                      input: 'number', type: 'integer' }
                      : { id: item.id, label: item.label, description: item.description, required: item.required,
                        input: 'text', type: 'string', maxLength: 100 }))
              }}><option value="text">自由入力</option><option value="select">プルダウン</option><option value="number">数値</option><option value="datetime">日時</option></select>
            {variable.input === 'select' && <input aria-label={`選択肢 ${index + 1}`} value={variable.options.map((option) => option.value).join(',')}
              onChange={(e) => setTemplateVariables((items) => items.map((item, i) => i === index && item.input === 'select'
                ? { ...item, options: e.target.value.split(',').map((value) => value.trim()).filter(Boolean).map((value) => ({ value, label: value })) } : item))} />}
            <label className="inline-check"><input type="checkbox" checked={variable.required}
              onChange={(e) => setTemplateVariables((items) => items.map((item, i) => i === index ? { ...item, required: e.target.checked } : item))} />必須</label>
            <button type="button" disabled={variable.type === 'datetime'} onClick={() => setTemplateVariables((items) => items.filter((_, i) => i !== index))}><Trash2 size={13} />削除</button>
          </div>)}</div>
          <button type="button" className="register-inline" onClick={() => setTemplateVariables((items) => [...items,
            { id: `filter${items.length - 1}`, label: '検索条件', description: '', required: false, input: 'text', type: 'string', maxLength: 100 }])}>
            変数を追加</button>
          <button type="button" className="register-inline" onClick={stageTemplate}>このパターンを追加して次を作る</button>
        </fieldset>}
      </>}
      {form.type === 'database-table' && <><label>接続先<select required value={form.connectionId} onChange={(e) => setForm({ ...form, connectionId: e.target.value })}><option value="">選択してください</option>
        {profiles.filter((profile) => profile.dataModel === 'table').map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)}</select></label>
        {profiles.every((profile) => profile.dataModel !== 'table') && <p className="connection-help">表形式DBの接続先がサーバーに構成されていません。運用管理者へ確認してください。</p>}
        <div className="connection-grid"><label>Schema<input value={form.schema} onChange={(e) => setForm({ ...form, schema: e.target.value })} /></label>
          <label>Table<input required value={form.table} onChange={(e) => setForm({ ...form, table: e.target.value })} /></label></div>
        <label>最大行数<input required type="number" min="1" max="5000" value={form.maxRows} onChange={(e) => setForm({ ...form, maxRows: e.target.value })} /></label></>}
      {form.type === 'database-documents' && <><label>接続先<select required value={form.connectionId} onChange={(e) => setForm({ ...form, connectionId: e.target.value })}><option value="">選択してください</option>
        {profiles.filter((profile) => profile.dataModel === 'documents').map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)}</select></label>
        {profiles.every((profile) => profile.dataModel !== 'documents') && <p className="connection-help">JSONライクDBの接続先がサーバーに構成されていません。運用管理者へ確認してください。</p>}
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
