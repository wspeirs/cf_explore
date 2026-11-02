<script setup lang="ts">
import { ref, shallowRef, reactive, computed, watch } from 'vue';
import type { D1Database, TableInfo, TreeNode } from '../types';
import { d1ListDatabases, d1LoadSchema, d1Query } from '../api';
import { status, settingsStatus, settingsVersion, showError } from '../state';
import {
  buildD1TreeRows,
  formatQueryStatus,
  selectTableSql,
  pickRunText,
  refreshTargetDbId,
} from '../d1';
import TreeView from './TreeView.vue';
import ResultGrid from './ResultGrid.vue';

let generation = 0;

const databases = ref<D1Database[]>([]);
const schemas = reactive(new Map<string, TableInfo[]>());
const expanded = reactive(new Set<string>(['root']));
const loading = reactive(new Set<string>());
const selectedId = ref('root');
const activeDbId = ref<string | null>(null);
const sqlText = ref('');
const result = shallowRef<{ columns: string[]; rows: unknown[][] }>({ columns: [], rows: [] });
const running = ref(false);
const editor = ref<HTMLTextAreaElement | null>(null);

const treeRows = computed<TreeNode[]>(() =>
  buildD1TreeRows(databases.value, schemas, expanded, loading)
);

async function loadDatabases(): Promise<void> {
  if (!settingsStatus.value.configured) {
    databases.value = [];
    return;
  }
  loading.add('root');
  const gen = generation;
  try {
    const dbs = await d1ListDatabases();
    if (gen !== generation) return;
    databases.value = dbs;
    status.value = `${dbs.length} databases`;
  } catch (e) {
    if (gen !== generation) return;
    showError(e);
  } finally {
    loading.delete('root');
  }
}

watch(
  [() => settingsStatus.value.configured, settingsVersion],
  ([configured]) => {
    generation++;
    selectedId.value = 'root';
    schemas.clear();
    expanded.clear();
    expanded.add('root');
    databases.value = [];
    activeDbId.value = null;
    if (configured) {
      loadDatabases();
    }
  },
  { immediate: true }
);

async function onToggle(node: TreeNode): Promise<void> {
  if (loading.has(node.id)) return;

  if (expanded.has(node.id)) {
    expanded.delete(node.id);
    return;
  }

  if (node.id.startsWith('db:')) {
    const dbData = node.data as { dbId?: string } | undefined;
    const dbId = dbData?.dbId;
    if (dbId && !schemas.has(dbId)) {
      loading.add(node.id);
      const gen = generation;
      try {
        const schema = await d1LoadSchema(dbId);
        if (gen !== generation) return;
        schemas.set(dbId, schema);
        expanded.add(node.id);
      } catch (e) {
        if (gen !== generation) return;
        showError(e);
      } finally {
        loading.delete(node.id);
      }
      return;
    }
  }

  expanded.add(node.id);
}

function onSelect(node: TreeNode): void {
  selectedId.value = node.id;
  const nodeData = node.data as { dbId?: string } | undefined;
  if (nodeData?.dbId) {
    activeDbId.value = nodeData.dbId;
  }
}

async function onActivate(node: TreeNode): Promise<void> {
  if (node.id.startsWith('tbl:')) {
    const nodeData = node.data as { dbId?: string; table?: string } | undefined;
    if (nodeData?.table) {
      const sql = selectTableSql(nodeData.table);
      sqlText.value = sql;
      if (nodeData.dbId) {
        activeDbId.value = nodeData.dbId;
      }
      await run(sql);
    } else {
      if (nodeData?.dbId) {
        activeDbId.value = nodeData.dbId;
      }
      await run();
    }
  } else if (node.id === 'root' || node.id.startsWith('db:')) {
    await onToggle(node);
  }
}

async function refresh(): Promise<void> {
  const dbId = refreshTargetDbId(selectedId.value);
  if (!dbId) {
    generation++;
    schemas.clear();
    expanded.clear();
    expanded.add('root');
    await loadDatabases();
    return;
  }

  const gen = generation;
  const nodeId = 'db:' + dbId;
  loading.add(nodeId);
  try {
    const schema = await d1LoadSchema(dbId);
    if (gen !== generation) return;
    schemas.set(dbId, schema);
  } catch (e) {
    if (gen !== generation) return;
    showError(e);
  } finally {
    loading.delete(nodeId);
  }
}

async function run(textOverride?: string): Promise<void> {
  if (running.value) return;

  const override = typeof textOverride === 'string' ? textOverride : undefined;
  const ta = editor.value;
  const text =
    override !== undefined
      ? override
      : ta && ta.selectionStart !== ta.selectionEnd
        ? pickRunText(ta.value, ta.selectionStart, ta.selectionEnd)
        : sqlText.value;

  if (!activeDbId.value) {
    showError('Select a database in the tree (or the Database list) first.');
    return;
  }

  running.value = true;
  status.value = 'Running…';

  const gen = generation;
  try {
    const o = await d1Query(activeDbId.value, text);
    if (gen !== generation) return;
    result.value = { columns: o.columns, rows: o.rows };
    status.value = formatQueryStatus(o);
  } catch (e) {
    if (gen !== generation) return;
    showError(e);
  } finally {
    running.value = false;
  }
}

</script>

<template>
  <div class="panel">
    <div class="sidebar">
      <div class="toolbar" style="margin-bottom: 4px">
        <button class="icon-btn" title="Refresh" @click="refresh">⟳</button>
        <span>Databases</span>
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
    </div>
    <div class="main">
      <div class="toolbar">
        <button class="default" :disabled="running" @click="() => run()">Run</button>
        <span class="hint" style="color: #666; font-size: 12px">Ctrl+Enter</span>
        <label style="margin-left: 8px; display: inline-flex; align-items: center; gap: 4px">
          Database:
          <select v-model="activeDbId">
            <option :value="null">(select a database)</option>
            <option v-for="d in databases" :key="d.uuid" :value="d.uuid">
              {{ d.name }}
            </option>
          </select>
        </label>
      </div>
      <textarea
        ref="editor"
        class="sql-editor"
        v-model="sqlText"
        spellcheck="false"
        @keydown.ctrl.enter.prevent="() => run()"
        @keydown.meta.enter.prevent="() => run()"
      ></textarea>
      <div class="grid-box win98-grid">
        <ResultGrid :columns="result.columns" :rows="result.rows" />
      </div>
    </div>
  </div>
</template>
