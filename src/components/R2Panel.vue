<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue';
import VGrid from '@revolist/vue3-datagrid';
import { save } from '@tauri-apps/plugin-dialog';
import { downloadDir, join } from '@tauri-apps/api/path';
import type { BucketInfo, ObjectInfo, TreeNode } from '../types';
import { r2ListBuckets, r2ListObjects, r2Download } from '../api';
import { status, settingsStatus, settingsVersion, showError, guardGridCopy } from '../state';
import { formatBytes } from '../format';
import { ICONS } from '../icons';
import TreeView from './TreeView.vue';
import PreviewWindow, { type PreviewTarget } from './PreviewWindow.vue';

const props = defineProps<{
  active: boolean;
}>();

const buckets = ref<BucketInfo[] | null>(null);
const listings = reactive(
  new Map<
    string,
    {
      prefixes: string[];
      objects: ObjectInfo[];
      nextToken: string | null;
      loading: boolean;
    }
  >()
);
const expanded = reactive(new Set<string>(['root']));
const selectedId = ref('root');
const current = ref<{ bucket: string; prefix: string } | null>(null);
const previewTarget = ref<PreviewTarget | null>(null);

async function loadBuckets() {
  if (buckets.value !== null) return;
  try {
    buckets.value = await r2ListBuckets();
  } catch (err) {
    showError(err);
  }
}

watch(
  [() => props.active, () => settingsStatus.value.configured, () => settingsStatus.value.r2_configured],
  ([active, configured, r2Configured]) => {
    if (active && configured && r2Configured && buckets.value === null) {
      loadBuckets();
    }
  },
  { immediate: true }
);

watch(settingsVersion, () => {
  buckets.value = null;
  listings.clear();
  expanded.clear();
  expanded.add('root');
  current.value = null;
  previewTarget.value = null;
  if (props.active && settingsStatus.value.configured && settingsStatus.value.r2_configured) {
    loadBuckets();
  }
});

async function loadListing(bucket: string, prefix: string, more = false) {
  const key = `${bucket}\0${prefix}`;
  const existing = listings.get(key);

  if (existing?.loading) return;
  if (!more && existing) return;
  if (more && (!existing || !existing.nextToken)) return;

  if (existing) {
    existing.loading = true;
  } else {
    listings.set(key, {
      prefixes: [],
      objects: [],
      nextToken: null,
      loading: true,
    });
  }

  try {
    const continuationToken = more ? (existing?.nextToken ?? null) : null;
    const page = await r2ListObjects(bucket, prefix, continuationToken);
    const entry = listings.get(key)!;

    if (more) {
      const newPrefixes = [...entry.prefixes];
      for (const p of page.prefixes) {
        if (!newPrefixes.includes(p)) {
          newPrefixes.push(p);
        }
      }
      entry.prefixes = newPrefixes;
      entry.objects = [...entry.objects, ...page.objects];
    } else {
      entry.prefixes = page.prefixes;
      entry.objects = page.objects;
    }

    entry.nextToken = page.next_token;
    entry.loading = false;

    status.value = `${entry.objects.length} objects, ${entry.prefixes.length} folders${
      entry.nextToken ? ' (more available)' : ''
    }`;
  } catch (err) {
    const entry = listings.get(key);
    if (entry) entry.loading = false;
    showError(err);
  }
}

function appendPrefixRows(bucket: string, parentPrefix: string, depth: number, rows: TreeNode[]) {
  const listingKey = `${bucket}\0${parentPrefix}`;
  const listing = listings.get(listingKey);
  if (!listing) return;

  for (const prefix of listing.prefixes) {
    const prefixId = `p:${bucket}\0${prefix}`;
    const isExpanded = expanded.has(prefixId);
    const childListingKey = `${bucket}\0${prefix}`;
    const childListing = listings.get(childListingKey);
    const isLoading = childListing?.loading ?? false;
    const label = prefix.slice(parentPrefix.length);

    rows.push({
      id: prefixId,
      label,
      icon: 'folder',
      depth: depth + 1,
      expandable: true,
      expanded: isExpanded,
      loading: isLoading,
      data: { bucket, prefix },
    });

    if (isExpanded && childListing) {
      appendPrefixRows(bucket, prefix, depth + 1, rows);
    }
  }

  if (listing.nextToken) {
    rows.push({
      id: `more:${bucket}\0${parentPrefix}`,
      label: '(more…)',
      icon: 'more',
      depth: depth + 1,
      expandable: false,
      expanded: false,
      loading: listing.loading,
      data: { bucket, prefix: parentPrefix, more: true },
    });
  }
}

const treeRows = computed<TreeNode[]>(() => {
  const rows: TreeNode[] = [];
  const rootExpanded = expanded.has('root');

  rows.push({
    id: 'root',
    label: 'R2 Buckets',
    icon: 'bucket',
    depth: 0,
    expandable: true,
    expanded: rootExpanded,
    loading: false,
    data: null,
  });

  if (!rootExpanded || !buckets.value) {
    return rows;
  }

  for (const b of buckets.value) {
    const bucketId = `b:${b.name}`;
    const isBucketExpanded = expanded.has(bucketId);
    const rootListingKey = `${b.name}\0`;
    const rootListing = listings.get(rootListingKey);
    const isLoading = rootListing?.loading ?? false;

    rows.push({
      id: bucketId,
      label: b.name,
      icon: 'bucket',
      depth: 1,
      expandable: true,
      expanded: isBucketExpanded,
      loading: isLoading,
      data: { bucket: b.name, prefix: '' },
    });

    if (isBucketExpanded && rootListing) {
      appendPrefixRows(b.name, '', 1, rows);
    }
  }

  return rows;
});

async function onToggle(node: TreeNode) {
  if (node.id === 'root') {
    if (expanded.has('root')) {
      expanded.delete('root');
    } else {
      expanded.add('root');
    }
    return;
  }

  const data = node.data as { bucket: string; prefix: string; more?: boolean } | undefined;
  if (!data) return;

  if (expanded.has(node.id)) {
    expanded.delete(node.id);
  } else {
    const key = `${data.bucket}\0${data.prefix}`;
    if (!listings.has(key)) {
      await loadListing(data.bucket, data.prefix);
    }
    expanded.add(node.id);
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
}

async function onActivate(node: TreeNode) {
  const data = node.data as { bucket: string; prefix: string; more?: boolean } | undefined;
  if (data?.more) {
    await loadListing(data.bucket, data.prefix, true);
    return;
  }
  await onToggle(node);
}

async function refresh() {
  if (selectedId.value === 'root') {
    buckets.value = null;
    listings.clear();
    expanded.clear();
    expanded.add('root');
    current.value = null;
    previewTarget.value = null;
    await loadBuckets();
    return;
  }

  const selNode = treeRows.value.find((r) => r.id === selectedId.value);
  const data = selNode?.data as { bucket: string; prefix: string } | undefined;
  if (!data || !data.bucket) return;

  const prefixKey = `${data.bucket}\0${data.prefix}`;
  for (const k of Array.from(listings.keys())) {
    if (k.startsWith(prefixKey)) {
      listings.delete(k);
    }
  }

  const expPrefix = `p:${data.bucket}\0${data.prefix}`;
  for (const id of Array.from(expanded)) {
    if (id.startsWith(expPrefix) && id !== selectedId.value) {
      expanded.delete(id);
    }
  }

  await loadListing(data.bucket, data.prefix);
}

const pathLabel = computed(() => {
  if (!current.value) return 'Select a bucket or folder';
  return `${current.value.bucket}/${current.value.prefix}`;
});

const objectRows = computed(() => {
  if (!current.value) return [];
  const key = `${current.value.bucket}\0${current.value.prefix}`;
  const listing = listings.get(key);
  if (!listing) return [];
  const prefixLen = current.value.prefix.length;
  return listing.objects.map((obj) => ({
    name: obj.key.slice(prefixLen),
    size: obj.size,
    last_modified: obj.last_modified ?? '',
    key: obj.key,
    etag: obj.etag,
  }));
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

const objectColumns = [
  {
    prop: 'name',
    name: 'Name',
    size: 320,
    sortable: true,
  },
  {
    prop: 'size',
    name: 'Size',
    size: 100,
    sortable: true,
    cellTemplate: (h: any, p: any) => h('span', formatBytes(p.model.size)),
  },
  {
    prop: 'last_modified',
    name: 'Last Modified',
    size: 190,
    sortable: true,
  },
  {
    prop: 'key',
    name: 'Actions',
    size: 64,
    sortable: false,
    cellTemplate: (h: any, p: any) =>
      h('span', { class: 'obj-actions' }, [
        h('button', {
          class: 'icon-btn',
          title: 'Preview',
          innerHTML: ICONS.magnify,
          onClick: () => openPreview(p.model),
        }),
        h('button', {
          class: 'icon-btn',
          title: 'Download',
          innerHTML: ICONS.download,
          onClick: () => download(p.model),
        }),
      ]),
  },
];
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
</style>
