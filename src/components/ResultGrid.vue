<script setup lang="ts">
import { shallowRef, watch } from 'vue';
import VGrid from '@revolist/vue3-datagrid';
import { guardGridCopy } from '../state';

const props = defineProps<{
  columns: string[];
  rows: unknown[][];
}>();

const gridColumns = shallowRef<any[]>([]);
const gridSource = shallowRef<Record<string, unknown>[]>([]);

watch(
  () => props.columns,
  (cols) => {
    gridColumns.value = (cols || []).map((name, i) => ({
      prop: 'c' + i,
      name,
      size: 150,
      minSize: 50,
      sortable: true,
      cellProperties: ({ model, prop }: any) =>
        model && model[prop] === null ? { class: { 'cell-null': true } } : {},
    }));
  },
  { immediate: true }
);

watch(
  () => props.rows,
  (rws) => {
    gridSource.value = (rws || []).map((r) =>
      Object.fromEntries(r.map((v, i) => ['c' + i, v]))
    );
  },
  { immediate: true }
);
</script>

<template>
  <VGrid
    :source="gridSource"
    :columns="gridColumns"
    :readonly="true"
    :range="true"
    :resize="true"
    :row-headers="true"
    theme="default"
    :row-size="22"
    @beforecopy="guardGridCopy"
    style="height: 100%"
  />
</template>
