<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

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

const overlay = ref<HTMLDivElement | null>(null);

function onKeyDown(e: KeyboardEvent): void {
  // One Escape closes one dialog. For a native key event the browser flushes Vue's DOM updates between
  // listeners, so once the top dialog has closed the next listener would see itself as top and close
  // too: the dialog that handles the key marks the event as handled.
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const all = document.querySelectorAll('.modal-overlay');
  if (all[all.length - 1] === overlay.value) {
    e.preventDefault();
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
  <div ref="overlay" class="modal-overlay">
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
