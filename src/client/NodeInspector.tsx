import { Database, Plus, Trash2, X } from 'lucide-react'
import type { CatalogField } from '../shared/catalog'
import type { WorkflowStep } from '../shared/workflow'
import type { DataSource } from './api'

type Props = {
  step: WorkflowStep
  availableInputs: WorkflowStep[]
  dataSources: DataSource[]
  selectedInputFields: CatalogField[]
  aggregateFields: CatalogField[]
  leftJoinFields: CatalogField[]
  rightJoinFields: CatalogField[]
  isAdmin: boolean
  onChange(step: WorkflowStep): void
  onOpenCatalog(): void
  onOpenConnections(): void
  onClose(): void
  onDuplicate(): void
  onRemove(): void
}

function datetimeLocalValue(value: string | number): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function CatalogFieldSelect({ label, value, fields, numeric, emptyLabel, onChange, onOpenCatalog }: {
  label: string
  value: string
  fields: CatalogField[]
  numeric?: boolean
  emptyLabel?: string
  onChange(value: string): void
  onOpenCatalog(): void
}) {
  const candidates = numeric ? fields.filter((field) => field.dataTypes.includes('number')) : fields
  if (candidates.length === 0 && !emptyLabel) {
    return <label>{label}<input value={value} onChange={(event) => onChange(event.target.value)} />
      <button type="button" className="catalog-inline-link" onClick={onOpenCatalog}>Catalogを確認・探索</button></label>
  }
  const known = (!value && !!emptyLabel) || candidates.some((field) => field.path === value)
  return <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)}>
    {!known ? <option value={value}>{value}（Catalog未登録）</option> : null}
    {emptyLabel ? <option value="">{emptyLabel}</option> : null}
    {candidates.map((field) => <option key={field.path} value={field.path}>
      {field.businessName ? `${field.businessName} · ` : ''}{field.path} ({field.dataTypes.join('/')})
    </option>)}
  </select></label>
}

export function NodeInspector({
  step,
  availableInputs,
  dataSources,
  selectedInputFields,
  aggregateFields,
  leftJoinFields,
  rightJoinFields,
  isAdmin,
  onChange,
  onOpenCatalog,
  onOpenConnections,
  onClose,
  onDuplicate,
  onRemove,
}: Props) {
  const selectedQuerySource = step.kind === 'query'
    ? dataSources.find((source) => source.id === step.config.source)
    : undefined
  const updateConfig = (key: string, value: unknown) =>
    onChange({ ...step, config: { ...step.config, [key]: value } } as WorkflowStep)
  const inputOptions = <><option value="">未接続</option>
    {availableInputs.map((input) => <option value={input.id} key={input.id}>{input.title}</option>)}</>

  return <aside className="inspector">
    <div className="inspector-head"><div><span>NODE SETTINGS</span><strong>{step.title}</strong></div>
      <button className="panel-close-button" onClick={onClose}><X size={14} /><span>閉じる</span></button></div>
    <label>表示名<input value={step.title} onChange={(event) => onChange({ ...step, title: event.target.value })} /></label>

    {step.kind === 'query' ? <>
      <label>登録済み接続<select value={step.config.source} onChange={(event) => {
        const source = dataSources.find((item) => item.id === event.target.value)
        onChange({ ...step, config: {
          ...step.config,
          source: event.target.value,
          parameters: {},
          template: source?.type === 'cloudwatch-logs' && source.queryMode === 'template-required' && source.queryTemplates[0]
            ? { id: source.queryTemplates[0].id, sourceVersion: source.version, arguments: {} }
            : null,
        } })
      }}><option value="unconfigured" disabled>接続を選択</option>
        {dataSources.map((source) => <option value={source.id} key={source.id}>{source.name}</option>)}
      </select></label>
      {selectedQuerySource?.type === 'cloudwatch-logs' && selectedQuerySource.queryTemplates.length > 0 ? <>
        <label>検索パターン<select value={step.config.template?.id ?? ''} onChange={(event) => updateConfig('template', event.target.value
          ? { id: event.target.value, sourceVersion: selectedQuerySource.version, arguments: {} }
          : null)}>
          {selectedQuerySource.queryMode !== 'template-required' ? <option value="">サンプル取得</option> : null}
          {selectedQuerySource.queryTemplates.map((template) =>
            <option key={template.id} value={template.id}>{template.name}</option>)}
        </select></label>
        {selectedQuerySource.queryTemplates.find((template) => template.id === step.config.template?.id)?.description
          ? <small className="source-admin-note">
            {selectedQuerySource.queryTemplates.find((template) => template.id === step.config.template?.id)?.description}
          </small>
          : null}
        {selectedQuerySource.queryTemplates.find((template) => template.id === step.config.template?.id)?.variables.map((variable) => {
          const value = step.config.template?.arguments[variable.id] ?? ''
          const setArgument = (next: string | number) => updateConfig('template', step.config.template
            ? { ...step.config.template, arguments: { ...step.config.template.arguments, [variable.id]: next } }
            : null)
          if (variable.input === 'select') {
            return <label key={variable.id}>{variable.label}<select required={variable.required} value={value}
              onChange={(event) => setArgument(event.target.value)}><option value="">選択してください</option>
              {variable.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select></label>
          }
          return <label key={variable.id}>{variable.label}<input required={variable.required}
            type={variable.input === 'datetime' ? 'datetime-local' : variable.input === 'number' ? 'number' : 'text'}
            value={variable.input === 'datetime' && value ? datetimeLocalValue(value) : value}
            min={variable.input === 'number' ? variable.minimum : undefined}
            max={variable.input === 'number' ? variable.maximum : undefined}
            maxLength={variable.input === 'text' ? variable.maxLength : undefined}
            onChange={(event) => setArgument(variable.input === 'number' ? Number(event.target.value)
              : variable.input === 'datetime' && event.target.value ? new Date(event.target.value).toISOString() : event.target.value)} /></label>
        })}
      </> : null}
      {isAdmin
        ? <button className="register-inline" onClick={onOpenConnections}><Database size={13} /> データソース管理</button>
        : dataSources.length === 0 ? <small className="source-admin-note">接続設定は管理者が行います。</small> : null}
    </> : null}

    {'input' in step ? <label>入力ノード<select value={step.input ?? ''}
      onChange={(event) => onChange({ ...step, input: event.target.value || null })}>{inputOptions}</select></label> : null}

    {step.kind === 'parseDocuments' ? <>
      <label>レコードパス<input value={step.config.recordPath} onChange={(event) => updateConfig('recordPath', event.target.value)}
        placeholder="例: $[] または $.items[]" /></label>
      <small className="source-admin-note">1ノードで展開できる配列は1つです。列のパスは展開後の各レコードを起点に指定します。</small>
      <div className="filter-editor"><strong>出力列</strong>{step.config.columns.map((column, index) =>
        <div className="parse-column-row" key={`${index}-${column.name}`}>
          <input aria-label={`出力列名 ${index + 1}`} value={column.name} onChange={(event) => updateConfig('columns',
            step.config.columns.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} />
          <input aria-label={`JSONパス ${index + 1}`} value={column.path} onChange={(event) => updateConfig('columns',
            step.config.columns.map((item, itemIndex) => itemIndex === index ? { ...item, path: event.target.value } : item))} />
          <select aria-label={`出力型 ${index + 1}`} value={column.dataType} onChange={(event) => updateConfig('columns',
            step.config.columns.map((item, itemIndex) => itemIndex === index ? { ...item, dataType: event.target.value } : item))}>
            <option value="string">文字列</option><option value="number">数値</option>
            <option value="boolean">真偽値</option><option value="datetime">日時</option>
          </select>
          <button type="button" aria-label={`出力列 ${index + 1}を削除`} disabled={step.config.columns.length === 1}
            onClick={() => updateConfig('columns', step.config.columns.filter((_, itemIndex) => itemIndex !== index))}>
            <Trash2 size={13} /> 削除
          </button>
        </div>)}
        <button type="button" className="register-inline" onClick={() => updateConfig('columns', [...step.config.columns,
          { name: `column_${step.config.columns.length + 1}`, path: '$.field', dataType: 'string' }])}>
          <Plus size={13} /> 列を追加
        </button>
      </div>
      <label>項目がない場合<select value={step.config.onMissing} onChange={(event) => updateConfig('onMissing', event.target.value)}>
        <option value="null">nullにする</option><option value="skip">レコードを除外</option><option value="error">エラーにする</option>
      </select></label>
      <label>型変換できない場合<select value={step.config.onTypeMismatch} onChange={(event) => updateConfig('onTypeMismatch', event.target.value)}>
        <option value="error">エラーにする</option><option value="null">nullにする</option><option value="skip">レコードを除外</option>
      </select></label>
    </> : null}

    {step.kind === 'filterSelect' ? <>
      <label>出力する列（カンマ区切り、空欄は全列）<input value={step.config.columns.join(', ')}
        onChange={(event) => updateConfig('columns', event.target.value.split(',').map((value) => value.trim()).filter(Boolean))} /></label>
      <div className="filter-editor"><strong>絞り込み条件</strong>{step.config.filters.map((filter, index) =>
        <div className="filter-row" key={index}>
          <input aria-label={`条件${index + 1}の列`} list={`filter-fields-${step.id}`} value={filter.field}
            onChange={(event) => updateConfig('filters', step.config.filters.map((item, itemIndex) =>
              itemIndex === index ? { ...item, field: event.target.value } : item))} />
          <select aria-label={`条件${index + 1}の演算子`} value={filter.operator}
            onChange={(event) => updateConfig('filters', step.config.filters.map((item, itemIndex) =>
              itemIndex === index ? { ...item, operator: event.target.value } : item))}>
            <option value="eq">等しい</option><option value="ne">等しくない</option><option value="gt">より大きい</option>
            <option value="gte">以上</option><option value="lt">より小さい</option><option value="lte">以下</option>
            <option value="contains">含む</option><option value="isNull">空である</option><option value="isNotNull">空でない</option>
          </select>
          {!['isNull', 'isNotNull'].includes(filter.operator) ? <input aria-label={`条件${index + 1}の値`}
            value={filter.value === null ? '' : String(filter.value)}
            onChange={(event) => updateConfig('filters', step.config.filters.map((item, itemIndex) =>
              itemIndex === index ? { ...item, value: event.target.value } : item))} /> : null}
          <button type="button" aria-label={`条件${index + 1}を削除`}
            onClick={() => updateConfig('filters', step.config.filters.filter((_, itemIndex) => itemIndex !== index))}>
            <Trash2 size={13} /> 削除
          </button>
        </div>)}
        <datalist id={`filter-fields-${step.id}`}>{selectedInputFields.map((field) =>
          <option value={field.path} key={field.path} />)}</datalist>
        <button type="button" className="register-inline" onClick={() => updateConfig('filters', [...step.config.filters,
          { field: selectedInputFields[0]?.path ?? 'field', operator: 'eq', value: '' }])}>
          <Plus size={13} /> 条件を追加
        </button>
      </div>
    </> : null}

    {step.kind === 'derive' ? <>
      <label>新しい列名<input value={step.config.output} onChange={(event) => updateConfig('output', event.target.value)} /></label>
      <CatalogFieldSelect label="元の列" value={step.config.source} fields={selectedInputFields}
        onChange={(value) => updateConfig('source', value)} onOpenCatalog={onOpenCatalog} />
      <label>計算<select value={step.config.operation} onChange={(event) => updateConfig('operation', event.target.value)}>
        <option value="toNumber">数値へ変換</option><option value="toString">文字列へ変換</option>
        <option value="year">年を抽出</option><option value="month">月を抽出</option><option value="add">加算</option>
        <option value="subtract">減算</option><option value="multiply">乗算</option><option value="divide">除算</option>
      </select></label>
      {['add', 'subtract', 'multiply', 'divide'].includes(step.config.operation) ? <>
        <CatalogFieldSelect label="右辺の列（定数を使う場合は空欄）" value={step.config.operandField ?? ''}
          fields={selectedInputFields} numeric onChange={(value) => updateConfig('operandField', value || null)}
          onOpenCatalog={onOpenCatalog} />
        <label>右辺の定数<input type="number" value={step.config.operandValue ?? ''}
          onChange={(event) => updateConfig('operandValue', event.target.value === '' ? null : Number(event.target.value))} /></label>
      </> : null}
    </> : null}

    {step.kind === 'aggregate' ? <>
      <CatalogFieldSelect label="集計単位" value={step.config.groupBy ?? ''} fields={aggregateFields}
        emptyLabel="グループ化しない（全体）"
        onChange={(value) => updateConfig('groupBy', value || null)} onOpenCatalog={onOpenCatalog} />
      <label>計算<select value={step.config.operation} onChange={(event) => {
        const operation = event.target.value as typeof step.config.operation
        onChange({ ...step, config: {
          ...step.config,
          operation,
          metric: operation === 'count'
            ? null
            : step.config.metric ?? aggregateFields.find((field) => field.dataTypes.includes('number'))?.path ?? null,
        } })
      }}>
        <option value="sum">合計</option><option value="average">平均</option><option value="count">件数</option>
        <option value="min">最小</option><option value="max">最大</option>
      </select></label>
      {step.config.operation !== 'count' ? <CatalogFieldSelect label="数値列" value={step.config.metric ?? ''} fields={aggregateFields} numeric
        onChange={(value) => updateConfig('metric', value || null)} onOpenCatalog={onOpenCatalog} /> : null}
    </> : null}

    {step.kind === 'join' || step.kind === 'joinAggregate' ? <>
      <label>左入力<select value={step.inputs.left ?? ''} onChange={(event) =>
        onChange({ ...step, inputs: { ...step.inputs, left: event.target.value || null } })}>{inputOptions}</select></label>
      <CatalogFieldSelect label="左の結合列" value={step.config.leftKey} fields={leftJoinFields}
        onChange={(value) => updateConfig('leftKey', value)} onOpenCatalog={onOpenCatalog} />
      {step.kind === 'joinAggregate' ? <CatalogFieldSelect label="左の数値列" value={step.config.metric}
        fields={leftJoinFields} numeric onChange={(value) => updateConfig('metric', value)} onOpenCatalog={onOpenCatalog} /> : null}
      <label>右入力<select value={step.inputs.right ?? ''} onChange={(event) =>
        onChange({ ...step, inputs: { ...step.inputs, right: event.target.value || null } })}>{inputOptions}</select></label>
      <CatalogFieldSelect label="右の結合列" value={step.config.rightKey} fields={rightJoinFields}
        onChange={(value) => updateConfig('rightKey', value)} onOpenCatalog={onOpenCatalog} />
      {step.kind === 'joinAggregate' ? <>
        <CatalogFieldSelect label="右のグループ列" value={step.config.groupBy} fields={rightJoinFields}
          onChange={(value) => updateConfig('groupBy', value)} onOpenCatalog={onOpenCatalog} />
        <label>計算<select value={step.config.operation} onChange={(event) => updateConfig('operation', event.target.value)}>
          <option value="sum">合計</option><option value="average">平均</option>
        </select></label>
      </> : <label>結合方式<select value={step.config.joinType} onChange={(event) => updateConfig('joinType', event.target.value)}>
        <option value="inner">内部結合（両方にある行）</option><option value="left">左結合（左の全行）</option>
      </select></label>}
    </> : null}

    {step.kind === 'sortLimit' ? <>
      <CatalogFieldSelect label="並べ替える列" value={step.config.sortBy} fields={selectedInputFields}
        onChange={(value) => updateConfig('sortBy', value)} onOpenCatalog={onOpenCatalog} />
      <label>順序<select value={step.config.direction} onChange={(event) => updateConfig('direction', event.target.value)}>
        <option value="asc">昇順</option><option value="desc">降順</option>
      </select></label>
      <label>最大件数<input type="number" min="1" max="5000" value={step.config.limit}
        onChange={(event) => updateConfig('limit', Number(event.target.value))} /></label>
    </> : null}
    {step.kind === 'preview' ? <label>表示件数<input type="number" min="1" max="100" value={step.config.limit}
      onChange={(event) => updateConfig('limit', Number(event.target.value))} /></label> : null}
    {step.kind === 'csv' ? <>
      <label>ファイル名<input value={step.config.fileName} onChange={(event) => updateConfig('fileName', event.target.value)} /></label>
      <label>CSVの安全モード<select value={step.config.mode} onChange={(event) => updateConfig('mode', event.target.value)}>
        <option value="spreadsheet">表計算向け（数式を無効化）</option><option value="machine">システム連携向け</option>
      </select></label>
    </> : null}

    <div className="inspector-meta"><span>STEP ID</span><code>{step.id}</code></div>
    <button className="duplicate-button" onClick={onDuplicate}><Plus size={14} /> ノードを複製</button>
    <button className="delete-button" onClick={onRemove}><Trash2 size={14} /> ノードを削除</button>
  </aside>
}
