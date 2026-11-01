<script setup lang="ts">
import { ref, shallowRef, reactive, computed, watch } from 'vue';
import type { D1Database, TableInfo, TreeNode, IconName } from '../types';
import { d1ListDatabases, d1LoadSchema, d1Query } from '../api';
import { status, settingsStatus, settingsVersion, showError, quoteIdent } from '../state';
import TreeView from './TreeView.vue';
import ResultGrid from './ResultGrid.vue';

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

const treeRows = computed<TreeNode[]>(() => {
  const rows: TreeNode[] = [];

  const isRootExpanded = expanded.has('root');
  rows.push({
    id: 'root',
    label: 'D1 Databases',
    icon: 'database',
    depth: 0,
    expandable: true,
    expanded: isRootExpanded,
    loading: loading.has('root'),
  });

  if (!isRootExpanded) {
    return rows;
  }

  for (const db of databases.value) {
    const dbNodeId = 'db:' + db.uuid;
    const isDbExpanded = expanded.has(dbNodeId);
    rows.push({
      id: dbNodeId,
      label: db.name,
      icon: 'database',
      depth: 1,
      expandable: true,
      expanded: isDbExpanded,
      loading: loading.has(dbNodeId),
      data: { dbId: db.uuid },
    });

    if (isDbExpanded && schemas.has(db.uuid)) {
      const tables = schemas.get(db.uuid) || [];
      for (const t of tables) {
        const tblNodeId = 'tbl:' + db.uuid + ':' + t.name;
        const isTblExpanded = expanded.has(tblNodeId);
        const hasCols = Boolean(t.columns && t.columns.length > 0);
        rows.push({
          id: tblNodeId,
          label: t.name,
          icon: (t.kind === 'view' ? 'view' : 'table') as IconName,
          depth: 2,
          expandable: hasCols,
          expanded: isTblExpanded,
          loading: false,
          data: { dbId: db.uuid, table: t.name },
        });

        if (isTblExpanded && hasCols) {
          for (const col of t.columns) {
            const colNodeId = 'col:' + db.uuid + ':' + t.name + ':' + col.name;
            rows.push({
              id: colNodeId,
              label: `${col.name} ${col.col_type}${col.pk ? ' (PK)' : ''}`,
              icon: 'column',
              depth: 3,
              expandable: false,
              expanded: false,
              loading: false,
              data: { dbId: db.uuid },
            });
          }
        }
      }
    }
  }

  return rows;
});

async function loadDatabases(): Promise<void> {
  if (!settingsStatus.value.configured) {
    databases.value = [];
    return;
  }
  loading.add('root');
  try {
    const dbs = await d1ListDatabases();
    databases.value = dbs;
    status.value = `${dbs.length} database(s)`;
  } catch (e) {
    showError(e);
  } finally {
    loading.delete('root');
  }
}

watch(
  [() => settingsStatus.value.configured, settingsVersion],
  ([configured]) => {
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
  if (expanded.has(node.id)) {
    expanded.delete(node.id);
    return;
  }

  if (node.id.startsWith('db:')) {
    const dbData = node.data as { dbId?: string } | undefined;
    const dbId = dbData?.dbId;
    if (dbId && !schemas.has(dbId)) {
      loading.add(node.id);
      try {
        const schema = await d1LoadSchema(dbId);
        schemas.set(dbId, schema);
        expanded.add(node.id);
      } catch (e) {
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
      sqlText.value = 'SELECT * FROM ' + quoteIdent(nodeData.table) + ' LIMIT 100;';
    }
    if (nodeData?.dbId) {
      activeDbId.value = nodeData.dbId;
    }
    await run();
  } else if (node.id === 'root' || node.id.startsWith('db:')) {
    await onToggle(node);
  }
}

async function refresh(): Promise<void> {
  if (!selectedId.value || selectedId.value === 'root') {
    schemas.clear();
    expanded.clear();
    expanded.add('root');
    await loadDatabases();
    return;
  }

  let dbId: string | null = null;
  const parts = selectedId.value.split(':');
  if (parts.length >= 2 && (parts[0] === 'db' || parts[0] === 'tbl' || parts[0] === 'col')) {
    dbId = parts[1];
  } else if (activeDbId.value) {
    dbId = activeDbId.value;
  }

  if (dbId) {
    const nodeId = 'db:' + dbId;
    loading.add(nodeId);
    try {
      const schema = await d1LoadSchema(dbId);
      schemas.set(dbId, schema);
    } catch (e) {
      showError(e);
    } finally {
      loading.delete(nodeId);
    }
  }
}

async function run(): Promise<void> {
  const ta = editor.value;
  const text =
    ta && ta.selectionStart !== ta.selectionEnd
      ? ta.value.slice(ta.selectionStart, ta.selectionEnd)
      : sqlText.value;

  if (!activeDbId.value) {
    showError('Select a database in the tree (or the Database list) first.');
    return;
  }

  running.value = true;
  status.value = 'Running…';

  try {
    const o = await d1Query(activeDbId.value, text);
    result.value = { columns: o.columns, rows: o.rows };

    let msg = '';
    if (o.statement_count > 1 && o.result_statement) {
      msg += `Showing result of statement ${o.result_statement} of ${o.statement_count} · `;
    }
    if (o.columns.length > 0) {
      msg += `${o.rows.length} row(s)${o.limit_applied ? ' (auto LIMIT 1000)' : ''} · read ${o.rows_read} · written ${o.rows_written} · ${o.duration_ms.toFixed(1)} ms`;
    } else {
      msg += `Executed ${o.statement_count} statement(s) · ${o.changes} row(s) changed · read ${o.rows_read} · written ${o.rows_written} · ${o.duration_ms.toFixed(1)} ms`;
    }
    status.value = msg;
  } catch (e) {
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
        <button class="default" :disabled="running" @click="run">Run</button>
        <span class="hint" style="color: #666; font-size: 11px">Ctrl+Enter</span>
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
        @keydown.ctrl.enter.prevent="run"
        @keydown.meta.enter.prevent="run"
      ></textarea>
      <div class="grid-box win98-grid">
        <ResultGrid :columns="result.columns" :rows="result.rows" />
      </div>
    </div>
  </div>
</template>
