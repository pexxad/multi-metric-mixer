const labels: Record<string, string> = {
  workflowName: 'Workflow名',
  version: 'バージョン',
  steps: 'ノード数',
  outputFiles: '出力ファイル',
  dataDestination: '保存先',
  externalTransmission: '外部への送信',
  oneTime: '承認の利用回数',
  includes: '書き出す情報',
  excludes: '書き出さない情報',
  artifactName: 'ファイル名',
  rows: '行数',
  classification: '情報区分',
  destination: '保存先',
  checksum: '内容確認用ハッシュ',
}

const valueLabels: Record<string, string> = {
  internal: '社内向け',
  confidential: '機密',
  restricted: '取扱制限',
  'workflow-definition-only': 'Workflow定義のみ',
  'connections,secrets,artifacts,sessions,memberships': '接続情報、秘密情報、成果物、ログイン情報、Workspaceメンバー情報',
}

function displayValue(key: string, value: unknown): string {
  if (key === 'oneTime') return value === true ? '1回のみ' : '制限なし'
  if (typeof value === 'boolean') return value ? 'あり' : 'なし'
  if (Array.isArray(value)) return value.join('、')
  const text = String(value)
  return valueLabels[text] ?? text
}

export function ApprovalSummary({ summary }: { summary: Record<string, unknown> }) {
  return <dl>{Object.entries(summary).map(([key, value]) => <div key={key}><dt>{labels[key] ?? key}</dt><dd>{displayValue(key, value)}</dd></div>)}</dl>
}
