import { invoke } from '@tauri-apps/api/core';
import type {
  Settings,
  SettingsStatus,
  D1Database,
  TableInfo,
  QueryOutcome,
  BucketInfo,
  ListPage,
} from './types';

export async function loadSettings(): Promise<SettingsStatus> {
  return invoke<SettingsStatus>('load_settings');
}

export async function saveSettings(settings: Settings): Promise<SettingsStatus> {
  return invoke<SettingsStatus>('save_settings', { settings });
}

export async function d1ListDatabases(): Promise<D1Database[]> {
  return invoke<D1Database[]>('d1_list_databases');
}

export async function d1LoadSchema(databaseId: string): Promise<TableInfo[]> {
  return invoke<TableInfo[]>('d1_load_schema', { databaseId });
}

export async function d1Query(databaseId: string, sql: string): Promise<QueryOutcome> {
  return invoke<QueryOutcome>('d1_query', { databaseId, sql });
}

export async function r2ListBuckets(): Promise<BucketInfo[]> {
  return invoke<BucketInfo[]>('r2_list_buckets');
}

export async function r2ListObjects(
  bucket: string,
  prefix: string,
  continuationToken: string | null
): Promise<ListPage> {
  return invoke<ListPage>('r2_list_objects', { bucket, prefix, continuationToken });
}

export async function r2GetRange(
  bucket: string,
  key: string,
  start: number,
  end: number
): Promise<Uint8Array> {
  const buf = await invoke<ArrayBuffer>('r2_get_range', { bucket, key, start, end });
  return new Uint8Array(buf);
}

export async function r2Download(
  bucket: string,
  key: string,
  dest: string
): Promise<number> {
  return invoke<number>('r2_download', { bucket, key, dest });
}
