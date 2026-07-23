const MCP_TOOL_NAMES = [
  'data_source_list',
  'data_source_describe',
  'data_source_read',
  'data_source_profile',
  'table_filter_select',
  'table_derive',
  'table_join',
  'table_aggregate',
  'table_join_aggregate',
  'table_sort_limit',
  'artifact_preview',
  'csv_export',
  'workflow_validate',
  'workflow_execute',
] as const

export const MCP_TOOL_COUNT = MCP_TOOL_NAMES.length
export const MCP_DATA_SOURCE_ACCESS = 'read-only' as const
