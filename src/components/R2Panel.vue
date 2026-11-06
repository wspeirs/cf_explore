<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue';
import VGrid from '@revolist/vue3-datagrid';
import { save } from '@tauri-apps/plugin-dialog';
import { downloadDir, join } from '@tauri-apps/api/path';
import type { BucketInfo, TreeNode } from '../types';
import {
  type Listing,
  buildR2TreeRows,
  pruneForRefresh,
  applyPage,
  listingStatus,
} from '../r2tree';
import { r2ListBuckets, r2ListObjects, r2Download } from '../api';
import { status, settingsStatus, settingsVersion, showError, guardGridCopy } from '../state';
import { formatBytes } from '../format';
import { buildObjectColumns, type ObjectRow } from '../r2grid';
import TreeView from './TreeView.vue';
import PreviewWindow, { type PreviewTarget } from './PreviewWindow.vue';

const props = defineProps<{
  active: boolean;
}>();

const buckets = ref<BucketInfo[] | null>(null);
const listings = reactive(new Map<string, Listing>());
const expanded = reactive(new Set<string>());
const selectedId = ref('');
const current = ref<{ bucket: string; prefix: string } | null>(null);
const previewTarget = ref<PreviewTarget | null>(null);

let generation = 0;
let inFlightBuckets = false;

function resetAll() {
  generation++;
  inFlightBuckets = false;
  buckets.value = null;
  listings.clear();
  expanded.clear();
  current.value = null;
  previewTarget.value = null;
  selectedId.value = '';
}

async function loadBuckets() {
  if (inFlightBuckets || buckets.value !== null) return;
  inFlightBuckets = true;
  const currentGen = generation;
  try {
    const result = await r2ListBuckets();
    if (generation === currentGen) {
      buckets.value = result;
    }
  } catch (err) {
    if (generation === currentGen) {
      showError(err);
    }
  } finally {
    if (generation === currentGen) {
      inFlightBuckets = false;
    }
  }
}

let lastSettingsVersion = settingsVersion.value;

watch(
  [
    () => props.active,
    () => settingsStatus.value.configured,
    () => settingsStatus.value.r2_configured,
    settingsVersion,
  ],
  ([active, configured, r2Configured, ver]) => {
    if (ver !== lastSettingsVersion) {
      lastSettingsVersion = ver;
      resetAll();
    }
    if (active && configured && r2Configured && buckets.value === null) {
      loadBuckets();
    }
  },
  { immediate: true }
);

async function loadListing(bucket: string, prefix: string, more = false) {
  const key = `${bucket}\0${prefix}`;
  const existing = listings.get(key);

  if (existing?.loading) return;
  if (!more && existing) return;
  if (more && (!existing || !existing.nextToken)) return;

  let entry: Listing;
  let isNew = false;
  if (existing) {
    existing.loading = true;
    entry = existing;
  } else {
    isNew = true;
    listings.set(key, {
      prefixes: [],
      objects: [],
      nextToken: null,
      loading: true,
    });
    entry = listings.get(key)!;
  }

  try {
    const continuationToken = more ? (entry.nextToken ?? null) : null;
    const page = await r2ListObjects(bucket, prefix, continuationToken);

    if (listings.get(key) !== entry) return;

    applyPage(entry, page, more);
    entry.loading = false;

    if (current.value?.bucket === bucket && current.value?.prefix === prefix) {
      status.value = listingStatus(entry);
    }
  } catch (err) {
    if (listings.get(key) === entry) {
      if (isNew) {
        listings.delete(key);
      } else {
        entry.loading = false;
      }
      showError(err);
    }
  }
}

const treeRows = computed<TreeNode[]>(() =>
  buildR2TreeRows(buckets.value, listings, expanded)
);

async function onToggle(node: TreeNode) {
  const data = node.data as { bucket: string; prefix: string; more?: boolean } | undefined;
  if (!data) return;

  if (expanded.has(node.id)) {
    expanded.delete(node.id);
  } else {
    const key = `${data.bucket}\0${data.prefix}`;
    if (!listings.has(key)) {
      await loadListing(data.bucket, data.prefix);
    }
    if (listings.has(key)) {
      expanded.add(node.id);
    }
  }
}

async function onSelect(node: TreeNode) {
  selectedId.value = node.id;
  const data = node.data as { bucket: string; prefix: string; more?: boolean } | undefined;
  if (!data) return;

  if (data.more) {
    await loadListing(data.bucket, data.prefix, true);
    return;
  }

  current.value = { bucket: data.bucket, prefix: data.prefix };
  await loadListing(data.bucket, data.prefix);
  const entry = listings.get(`${data.bucket}\0${data.prefix}`);
  if (entry && !entry.loading && current.value?.bucket === data.bucket && current.value?.prefix === data.prefix) {
    status.value = listingStatus(entry);
  }
}

async function onActivate(node: TreeNode) {
  const data = node.data as { bucket: string; prefix: string; more?: boolean } | undefined;
  if (data?.more) {
    await loadListing(data.bucket, data.prefix, true);
    return;
  }
  await onToggle(node);
}

async function openFolder(bucket: string, prefix: string) {
  expanded.add(`b:${bucket}`);
  let p = '';
  for (const part of prefix.split('/').filter(Boolean)) {
    p += `${part}/`;
    expanded.add(`p:${bucket}\0${p}`);
  }
  focusedRow = null;
  await onSelect({
    id: prefix ? `p:${bucket}\0${prefix}` : `b:${bucket}`,
    data: { bucket, prefix },
  } as TreeNode);
}

let focusedRow: ObjectRow | null = null;

function onGridFocus(e: CustomEvent) {
  focusedRow = (e.detail?.model as ObjectRow | undefined) ?? null;
}

function onGridDblclick(e: MouseEvent) {
  if ((e.target as HTMLElement).closest('revogr-header')) return;
  if (focusedRow?.dir && current.value) {
    openFolder(current.value.bucket, focusedRow.key);
  }
}

// Refreshes the directory shown in the grid (not merely the selected tree node).
async function refresh() {
  const cur = current.value;
  if (!cur) {
    resetAll();
    await loadBuckets();
    return;
  }

  const selfId = cur.prefix ? `p:${cur.bucket}\0${cur.prefix}` : `b:${cur.bucket}`;
  const { deleteKeys, deleteExpanded } = pruneForRefresh(
    Array.from(listings.keys()),
    Array.from(expanded),
    cur.bucket,
    cur.prefix,
    selfId
  );

  for (const k of deleteKeys) {
    listings.delete(k);
  }
  for (const id of deleteExpanded) {
    expanded.delete(id);
  }

  await loadListing(cur.bucket, cur.prefix);
}

const pathLabel = computed(() => {
  if (!current.value) return 'Select a bucket or folder';
  return `${current.value.bucket}/${current.value.prefix}`;
});

const objectRows = computed<ObjectRow[]>(() => {
  if (!current.value) return [];
  const key = `${current.value.bucket}\0${current.value.prefix}`;
  const listing = listings.get(key);
  if (!listing) return [];
  const prefixLen = current.value.prefix.length;
  const dirs = listing.prefixes.map((p) => ({
    name: p.slice(prefixLen),
    size: 0,
    last_modified: '',
    key: p,
    etag: null,
    dir: true,
  }));
  const files = listing.objects.map((obj) => ({
    name: obj.key.slice(prefixLen),
    size: obj.size,
    last_modified: obj.last_modified ?? '',
    key: obj.key,
    etag: obj.etag,
    dir: false,
  }));
  return [...dirs, ...files];
});

const hasNextToken = computed(() => {
  if (!current.value) return false;
  const key = `${current.value.bucket}\0${current.value.prefix}`;
  return Boolean(listings.get(key)?.nextToken);
});

function openPreview(row: { key: string; size: number; etag: string | null }) {
  if (!current.value) return;
  previewTarget.value = {
    bucket: current.value.bucket,
    key: row.key,
    size: row.size,
    etag: row.etag,
  };
}

async function download(row: { key: string; size: number }) {
  if (!current.value) return;
  const bucket = current.value.bucket;
  const key = row.key;
  const name = key.split('/').pop() || 'download';
  let defaultPath = name;
  try {
    const dir = await downloadDir();
    defaultPath = await join(dir, name);
  } catch {
    defaultPath = name;
  }

  const dest = await save({ title: 'Download object', defaultPath });
  if (!dest) return;

  status.value = `Downloading ${key}…`;
  try {
    const n = await r2Download(bucket, key, dest);
    status.value = `Saved ${key} to ${dest} (${formatBytes(n)})`;
  } catch (err) {
    showError(err);
  }
}

const objectColumns = buildObjectColumns({ openPreview, download });
</script>

<template>
  <div class="panel">
    <div class="sidebar">
      <template v-if="!settingsStatus.r2_configured">
        <div class="tree-box" style="padding: 8px;">
          R2 credentials are not configured. Use File › Settings... to add them.
        </div>
      </template>
      <template v-else>
        <div class="toolbar">
          <button class="icon-btn" title="Refresh" @click="refresh">↻</button>
        </div>
        <div class="tree-box">
          <TreeView
            :rows="treeRows"
            :selected-id="selectedId"
            @toggle="onToggle"
            @select="onSelect"
            @activate="onActivate"
          />
        </div>
      </template>
    </div>

    <div class="main">
      <div class="path-label">{{ pathLabel }}</div>
      <div class="grid-box win98-grid">
        <VGrid
          :source="objectRows"
          :columns="objectColumns"
          @beforecellfocus="onGridFocus"
          @dblclick="onGridDblclick"
          :readonly="true"
          :resize="true"
          theme="default"
          :row-size="22"
          @beforecopy="guardGridCopy"
          style="height: 100%"
        />
      </div>
      <div v-if="hasNextToken" class="load-more-bar">
        <button @click="loadListing(current!.bucket, current!.prefix, true)">Load more…</button>
      </div>
    </div>

    <PreviewWindow
      v-if="previewTarget"
      :target="previewTarget"
      @close="previewTarget = null"
    />
  </div>
</template>

<style scoped>
.path-label {
  padding: 2px 4px;
  font-weight: bold;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.load-more-bar {
  display: flex;
  justify-content: flex-start;
  padding: 2px 0;
}

:deep(.obj-actions) {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 100%;
}

:deep(.dir-name) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
</style>
