export interface Settings {
  account_id: string;
  api_token: string;
  r2_access_key_id: string;
  r2_secret_access_key: string;
}

export interface SettingsStatus {
  settings: Settings | null;
  configured: boolean;
  r2_configured: boolean;
}

export interface D1Database {
  uuid: string;
  name: string;
  created_at: string | null;
  jurisdiction: string | null;
}

export interface ColumnInfo {
  name: string;
  col_type: string;
  not_null: boolean;
  pk: boolean;
}

export interface TableInfo {
  name: string;
  kind: string;
  columns: ColumnInfo[];
}

export interface QueryOutcome {
  columns: string[];
  rows: unknown[][];
  result_statement: number | null;
  statement_count: number;
  rows_read: number;
  rows_written: number;
  changes: number;
  duration_ms: number;
  limit_applied: boolean;
}

export interface BucketInfo {
  name: string;
  created: string | null;
}

export interface ObjectInfo {
  key: string;
  size: number;
  last_modified: string | null;
  etag: string | null;
}

export interface ListPage {
  prefixes: string[];
  objects: ObjectInfo[];
  next_token: string | null;
}

export type IconName =
  | 'database'
  | 'table'
  | 'view'
  | 'column'
  | 'bucket'
  | 'folder'
  | 'more'
  | 'magnify'
  | 'download'
  | 'error';

export interface TreeNode {
  id: string;
  label: string;
  icon: IconName;
  depth: number;
  expandable: boolean;
  expanded: boolean;
  loading: boolean;
  data?: unknown;
}
