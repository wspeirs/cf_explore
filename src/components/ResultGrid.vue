<script setup lang="ts">
import { shallowRef, watch } from 'vue';
import VGrid from '@revolist/vue3-datagrid';
import { guardGridCopy } from '../state';
import { toGridColumns, toGridSource, type GridColumn } from '../d1';

const props = defineProps<{
  columns: string[];
  rows: unknown[][];
}>();

const gridColumns = shallowRef<GridColumn[]>([]);
const gridSource = shallowRef<Record<string, unknown>[]>([]);

watch(
  () => props.columns,
  (cols) => {
    gridColumns.value = toGridColumns(cols);
  },
  { immediate: true }
);

watch(
  () => props.rows,
  (rws) => {
    gridSource.value = toGridSource(rws);
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
