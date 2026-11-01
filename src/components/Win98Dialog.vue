<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';

const props = withDefaults(
  defineProps<{
    title: string;
    width?: number;
  }>(),
  {
    width: 380,
  }
);

const emit = defineEmits<{
  (e: 'close'): void;
}>();

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    emit('close');
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown);
});
</script>

<template>
  <div class="modal-overlay">
    <div class="window" :style="{ width: `${props.width}px` }">
      <div class="title-bar">
        <div class="title-bar-text">{{ props.title }}</div>
        <div class="title-bar-controls">
          <button aria-label="Close" @click="emit('close')"></button>
        </div>
      </div>
      <div class="window-body">
        <slot />
      </div>
    </div>
  </div>
</template>
