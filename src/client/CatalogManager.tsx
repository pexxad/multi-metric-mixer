import { useEffect, useState } from 'react'
import { Bot, CircleAlert, Database, LoaderCircle, Plus, RotateCcw, Save, Trash2, Upload, X } from 'lucide-react'
import type { CatalogBundle, CatalogDataType, CatalogDefinition, CatalogField, CatalogRelationship } from '../shared/catalog'
import {
  exploreCatalog,
  loadCatalogBundle,
  promotePersonalCatalog,
  resetPersonalCatalog,
  saveCanonicalCatalog,
  savePersonalCatalog,
  type AuthSession,
  type DataSource,
} from './api'

type Props = { auth: AuthSession; sources: DataSource[]; onChange?(): void | Promise<void>; onClose(): void }
type EditScope = 'personal' | 'canonical'
const dataTypes: CatalogDataType[] = ['string', 'number', 'boolean', 'object', 'array', 'null']
const classificationRank = { internal: 0, confidential: 1, restricted: 2 } as const

function emptyDefinition(source: DataSource): CatalogDefinition {
  return { sourceId: source.id, displayName: source.name, description: '',
    policy: source.type === 'sql' || source.type === 'upload-artifact' ? 'curated'
      : source.type === 'rest-json' ? 'hybrid' : 'evolving',
    classification: 'internal', defaultTimeField: null, fields: [], relationships: [] }
}

function cloneDefinition(definition: CatalogDefinition): CatalogDefinition {
  return structuredClone(definition)
}

export function CatalogManager({ auth, sources, onChange, onClose }: Props) {
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '')
  const [scope, setScope] = useState<EditScope>('personal')
  const [bundle, setBundle] = useState<CatalogBundle>()
  const [draft, setDraft] = useState<CatalogDefinition>()
  const [busy, setBusy] = useState<string>()
  const [message, setMessage] = useState<string>()
  const source = sources.find((item) => item.id === sourceId)

  useEffect(() => {
    if (!sourceId) { setBundle(undefined); setDraft(undefined); return }
    let active = true
    setBusy('load'); setMessage(undefined)
    void loadCatalogBundle(auth, sourceId).then((result) => {
      if (!active) return
      setBundle(result)
      const selected = scope === 'canonical' ? result.canonical : result.personal ?? result.canonical
      setDraft(selected ? cloneDefinition(selected.definition) : source ? emptyDefinition(source) : undefined)
    }).catch((error) => active && setMessage(error instanceof Error ? error.message : String(error)))
      .finally(() => active && setBusy(undefined))
    return () => { active = false }
  }, [auth, sourceId])

  function switchScope(next: EditScope) {
    setScope(next); setMessage(undefined)
    const selected = next === 'canonical' ? bundle?.canonical : bundle?.personal ?? bundle?.canonical
    if (source) setDraft(selected ? cloneDefinition(selected.definition) : emptyDefinition(source))
  }

  function updateField(index: number, update: Partial<CatalogField>) {
    setDraft((current) => current ? { ...current,
      fields: current.fields.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...update } : field) } : current)
  }

  function addField() {
    setDraft((current) => current ? { ...current, fields: [...current.fields, {
      path: `field_${current.fields.length + 1}`, dataTypes: ['string'], nullable: true, presence: 1,
      businessName: '', description: '', unit: '', timezone: '',
    }] } : current)
  }

  function updateRelationship(index: number, update: Partial<CatalogRelationship>) {
    setDraft((current) => current ? { ...current, relationships: current.relationships.map((relationship, relationshipIndex) =>
      relationshipIndex === index ? { ...relationship, ...update } : relationship) } : current)
  }

  function addRelationship() {
    if (!draft || sources.length < 2) return
    const target = sources.find((item) => item.id !== sourceId)
    const localField = draft.fields[0]?.path ?? 'id'
    setDraft({ ...draft, relationships: [...draft.relationships, { id: `relationship_${draft.relationships.length + 1}`,
      targetSourceId: target?.id ?? '', localFields: [localField], targetFields: ['id'], cardinality: 'many-to-one', description: '' }] })
  }

  async function reload(preferredScope = scope) {
    if (!sourceId || !source) return
    const next = await loadCatalogBundle(auth, sourceId)
    setBundle(next); setScope(preferredScope)
    const selected = preferredScope === 'canonical' ? next.canonical : next.personal ?? next.canonical
    setDraft(selected ? cloneDefinition(selected.definition) : emptyDefinition(source))
  }

  async function save() {
    if (!draft || !sourceId) return
    setBusy('save'); setMessage(undefined)
    try {
      if (scope === 'canonical') await saveCanonicalCatalog(auth, sourceId, draft, bundle?.canonical?.version)
      else await savePersonalCatalog(auth, sourceId, draft, bundle?.personal?.version)
      await reload(scope)
      await onChange?.()
      setMessage(scope === 'canonical' ? 'Workspace正本を保存しました。' : '自分用Catalogを保存しました。')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(undefined) }
  }

  async function explore() {
    if (!sourceId) return
    setBusy('explore'); setMessage(undefined)
    try {
      const result = await exploreCatalog(auth, sourceId)
      await reload('personal')
      await onChange?.()
      setMessage(`探索結果を自分用 v${result.catalog.version}へ反映しました（${result.catalog.definition.fields.length} fields）。`)
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(undefined) }
  }

  async function reset() {
    const hasCanonical = Boolean(bundle?.canonical)
    const confirmation = hasCanonical
      ? '自分用Catalogの利用を解除し、Workspace正本へ戻しますか？過去versionは履歴として保持されます。'
      : '自分用Catalogの利用を解除しますか？過去versionは履歴として保持されます。'
    if (!sourceId || !bundle?.personal || !window.confirm(confirmation)) return
    setBusy('reset'); setMessage(undefined)
    try {
      await resetPersonalCatalog(auth, sourceId); await reload('personal'); await onChange?.()
      setMessage(hasCanonical ? 'Workspace正本へ戻しました。' : '自分用Catalogの利用を解除しました。')
    }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(undefined) }
  }

  async function promote() {
    if (!sourceId || !bundle?.personal || !window.confirm(`自分用 v${bundle.personal.version} を新しいWorkspace正本として公開しますか？`)) return
    setBusy('promote'); setMessage(undefined)
    try {
      const result = await promotePersonalCatalog(auth, sourceId, bundle.canonical?.version)
      await reload('canonical'); await onChange?.(); setMessage(`自分用CatalogをWorkspace正本 v${result.catalog.version}へ反映しました。`)
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(undefined) }
  }

  return <div className="modal-backdrop" role="presentation">
    <section className="connection-modal catalog-manager" role="dialog" aria-modal="true" aria-label="Data Catalog管理">
      <header className="connection-modal-head"><div><span>DATA CATALOG</span><h2>スキーマとデータの意味</h2>
        <p>Workspace正本を基点に、自分用の解釈を保存できます。Agent探索も同じCatalog Versionへ記録されます。</p></div>
        <button className="panel-close-button" onClick={onClose}><X size={14} /><span>閉じる</span></button></header>

      {sources.length === 0 ? <div className="catalog-empty"><Database size={20} /><strong>利用可能なデータソースがありません</strong>
        <span>管理者が接続を登録するとCatalogを作成できます。</span></div> : <>
        <div className="catalog-toolbar"><label>データソース<select value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
          {sources.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.type}</option>)}</select></label>
          <button onClick={() => void explore()} disabled={Boolean(busy)}>{busy === 'explore' ? <LoaderCircle className="spin" size={14} /> : <Bot size={14} />}<span>Agentで探索</span></button></div>

        <div className="catalog-scope-tabs" role="tablist" aria-label="Catalogの保存先">
          <button role="tab" aria-selected={scope === 'personal'} className={scope === 'personal' ? 'active' : ''} onClick={() => switchScope('personal')}>自分用</button>
          {auth.applicationRole === 'admin' && <button role="tab" aria-selected={scope === 'canonical'} className={scope === 'canonical' ? 'active' : ''} onClick={() => switchScope('canonical')}>Workspace正本</button>}
        </div>

        <div className="catalog-version-strip">
          <span>正本 <strong>{bundle?.canonical ? `v${bundle.canonical.version}` : '未登録'}</strong></span>
          <span>自分用 <strong>{bundle?.personal ? `v${bundle.personal.version}` : 'なし'}</strong></span>
          {bundle?.personalOutdated && <em><CircleAlert size={12} />正本が更新されています</em>}
        </div>

        {busy === 'load' ? <div className="catalog-loading"><LoaderCircle className="spin" />読込中</div> : draft && <div className="catalog-editor">
          <div className="catalog-definition-grid">
            <label>表示名<input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></label>
            <label>schema運用<select value={draft.policy} onChange={(event) => setDraft({ ...draft, policy: event.target.value as CatalogDefinition['policy'] })}>
              <option value="curated">固定・手動管理</option><option value="evolving">可変・観測を優先</option><option value="hybrid">意味は手動・fieldは追従</option></select></label>
            <label>情報区分<select value={draft.classification} onChange={(event) => setDraft({ ...draft, classification: event.target.value as CatalogDefinition['classification'] })}>
              {([['internal', '社内'], ['confidential', '機密'], ['restricted', '制限付き']] as const).map(([value, label]) => <option key={value} value={value}
                disabled={scope === 'personal' && Boolean(bundle?.canonical) && classificationRank[value] < classificationRank[bundle!.canonical!.definition.classification]}>{label}</option>)}</select></label>
            <label>既定の時刻field<select value={draft.defaultTimeField ?? ''} onChange={(event) => setDraft({ ...draft, defaultTimeField: event.target.value || null })}>
              <option value="">未設定</option>{draft.fields.map((field) => <option key={field.path} value={field.path}>{field.path}</option>)}</select></label>
            <label className="catalog-description">説明<textarea rows={2} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
          </div>

          <div className="catalog-fields-head"><div><strong>Fields</strong><span>{draft.fields.length}件</span></div><button onClick={addField}><Plus size={13} />fieldを追加</button></div>
          <div className="catalog-fields"><table><thead><tr><th>Field path</th><th>型</th><th>業務名</th><th>説明</th><th>単位</th><th>Timezone</th><th>観測率</th><th /></tr></thead>
            <tbody>{draft.fields.map((field, index) => <tr key={`${index}-${field.path}`}>
              <td><input aria-label={`Field path ${index + 1}`} value={field.path} onChange={(event) => updateField(index, { path: event.target.value })} /></td>
              <td><select aria-label={`型 ${field.path}`} value={field.dataTypes[0]} onChange={(event) => updateField(index, { dataTypes: [event.target.value as CatalogDataType] })}>
                {dataTypes.map((type) => <option key={type}>{type}</option>)}</select>{field.dataTypes.length > 1 && <small>観測: {field.dataTypes.join(' / ')}</small>}</td>
              <td><input aria-label={`業務名 ${field.path}`} value={field.businessName} onChange={(event) => updateField(index, { businessName: event.target.value })} /></td>
              <td><input aria-label={`説明 ${field.path}`} value={field.description} onChange={(event) => updateField(index, { description: event.target.value })} /></td>
              <td><input aria-label={`単位 ${field.path}`} value={field.unit} onChange={(event) => updateField(index, { unit: event.target.value })} /></td>
              <td><input aria-label={`Timezone ${field.path}`} value={field.timezone} onChange={(event) => updateField(index, { timezone: event.target.value })} /></td>
              <td><span>{Math.round(field.presence * 100)}%</span>{field.nullable && <small>nullable</small>}</td>
              <td><button aria-label={`${field.path}を削除`} onClick={() => setDraft({ ...draft, fields: draft.fields.filter((_, fieldIndex) => fieldIndex !== index) })}><Trash2 size={13} /></button></td>
            </tr>)}</tbody></table></div>

          <div className="catalog-fields-head"><div><strong>Relationships</strong><span>{draft.relationships.length}件</span></div>
            <button onClick={addRelationship} disabled={sources.length < 2}><Plus size={13} />Relationshipを追加</button></div>
          <div className="catalog-relationships"><table><thead><tr><th>関係名</th><th>自分側field</th><th>相手データソース</th><th>相手側field</th><th>Cardinality</th><th>説明</th><th /></tr></thead>
            <tbody>{draft.relationships.map((relationship, index) => <tr key={`${index}-${relationship.id}`}>
              <td><input aria-label={`Relationship名 ${index + 1}`} value={relationship.id} onChange={(event) => updateRelationship(index, { id: event.target.value })} /></td>
              <td><select aria-label={`自分側field ${relationship.id}`} value={relationship.localFields[0]} onChange={(event) => updateRelationship(index, { localFields: [event.target.value] })}>
                {!draft.fields.some((field) => field.path === relationship.localFields[0]) && <option value={relationship.localFields[0]}>{relationship.localFields[0]}</option>}
                {draft.fields.map((field) => <option key={field.path} value={field.path}>{field.businessName || field.path}</option>)}</select></td>
              <td><select aria-label={`相手データソース ${relationship.id}`} value={relationship.targetSourceId} onChange={(event) => updateRelationship(index, { targetSourceId: event.target.value })}>
                {sources.filter((item) => item.id !== sourceId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></td>
              <td><input aria-label={`相手側field ${relationship.id}`} value={relationship.targetFields[0]} onChange={(event) => updateRelationship(index, { targetFields: [event.target.value] })} /></td>
              <td><select aria-label={`Cardinality ${relationship.id}`} value={relationship.cardinality} onChange={(event) => updateRelationship(index, { cardinality: event.target.value as CatalogRelationship['cardinality'] })}>
                <option value="one-to-one">1 : 1</option><option value="one-to-many">1 : N</option><option value="many-to-one">N : 1</option><option value="many-to-many">N : N（要注意）</option></select></td>
              <td><input aria-label={`Relationship説明 ${relationship.id}`} value={relationship.description} onChange={(event) => updateRelationship(index, { description: event.target.value })} /></td>
              <td><button aria-label={`${relationship.id}を削除`} onClick={() => setDraft({ ...draft, relationships: draft.relationships.filter((_, relationshipIndex) => relationshipIndex !== index) })}><Trash2 size={13} /></button></td>
            </tr>)}</tbody></table></div>
        </div>}
      </>}

      {message && <div className="catalog-message" role="status"><CircleAlert size={14} />{message}</div>}
      {draft && <footer className="catalog-actions">
        {scope === 'personal' && bundle?.personal && <button onClick={() => void reset()} disabled={Boolean(busy)}><RotateCcw size={14} />{bundle.canonical ? '正本へ戻す' : '自分用Catalogを解除'}</button>}
        {auth.applicationRole === 'admin' && scope === 'personal' && bundle?.personal && <button onClick={() => void promote()} disabled={Boolean(busy)}><Upload size={14} />正本へ反映</button>}
        <button className="primary" onClick={() => void save()} disabled={Boolean(busy)}>{busy === 'save' ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}
          {scope === 'canonical' ? '正本を保存' : '自分用に保存'}</button>
      </footer>}
    </section>
  </div>
}
