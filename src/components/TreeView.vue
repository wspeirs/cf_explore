<script setup lang="ts">
import { computed, ref } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import { ICONS } from '../icons';
import type { TreeNode } from '../types';

const props = defineProps<{
  rows: TreeNode[];
  selectedId: string | null;
}>();

const emit = defineEmits<{
  (e: 'toggle', node: TreeNode): void;
  (e: 'select', node: TreeNode): void;
  (e: 'activate', node: TreeNode): void;
  (e: 'expandAll', node: TreeNode): void;
}>();

const scrollRef = ref<HTMLDivElement | null>(null);

const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>(
  computed(() => ({
    count: props.rows.length,
    getScrollElement: () => scrollRef.value,
    estimateSize: () => 20,
    overscan: 10,
    getItemKey: (i: number) => props.rows[i]?.id ?? i,
  }))
);
</script>

<template>
  <div ref="scrollRef" class="tree-scroll">
    <div
      :style="{
        height: `${virtualizer.getTotalSize()}px`,
        width: '100%',
        position: 'relative',
      }"
    >
      <div
        v-for="item in virtualizer.getVirtualItems()"
        :key="String(item.key)"
        class="tree-row"
        :style="{
          transform: `translateY(${item.start}px)`,
          paddingLeft: `${(props.rows[item.index]?.depth ?? 0) * 16 + 4}px`,
        }"
        @click="emit('select', props.rows[item.index])"
        @dblclick="emit('activate', props.rows[item.index])"
      >
        <span
          v-if="props.rows[item.index]?.expandable"
          class="tree-twisty"
          @click.stop="emit('toggle', props.rows[item.index])"
          @dblclick.stop
        >
          {{ props.rows[item.index]?.expanded ? '−' : '+' }}
        </span>
        <span v-else class="tree-spacer"></span>

        <span
          v-if="props.rows[item.index]"
          class="tree-icon"
          v-html="ICONS[props.rows[item.index].icon]"
        ></span>

        <span
          v-if="props.rows[item.index]"
          class="tree-label"
          :class="{ selected: selectedId === props.rows[item.index].id }"
        >
          {{ props.rows[item.index].label }}{{ props.rows[item.index].loading ? ' (loading…)' : '' }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tree-scroll {
  overflow: auto;
  height: 100%;
  user-select: none;
}

.tree-row {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 20px;
  display: flex;
  align-items: center;
  box-sizing: border-box;
  cursor: default;
  white-space: nowrap;
}

.tree-twisty {
  width: 9px;
  height: 9px;
  min-width: 9px;
  min-height: 9px;
  box-sizing: border-box;
  border: 1px solid #808080;
  background: #ffffff;
  color: #000000;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  line-height: 1;
  font-family: monospace;
  cursor: pointer;
}

.tree-spacer {
  width: 9px;
  min-width: 9px;
  height: 9px;
  display: inline-block;
}

.tree-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin: 0 4px;
  width: 16px;
  height: 16px;
  min-width: 16px;
}

.tree-label {
  padding: 0 2px;
  font-size: var(--font-size-ui, 12px);
}

.tree-label.selected {
  background: #000080;
  color: #ffffff;
}

.tree-expand-all {
  margin-left: 6px;
  padding: 0 3px;
  cursor: pointer;
  font-size: var(--font-size-ui, 12px);
}
</style>
