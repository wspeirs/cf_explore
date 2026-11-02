<script lang="ts">
import { createPreviewCache } from '../preview';

// Module-level previewCache keyed by `${bucket}\n${key}\n${etag}` (LRU max 16 entries)
const previewCache = createPreviewCache(16);
</script>

<script setup lang="ts">
import { ref, computed, shallowRef, watch } from 'vue';
import { r2GetRange } from '../api';
import { showError } from '../state';
import { decodePreview } from '../format';
import { initialRange, showMoreRange } from '../preview';
export interface PreviewTarget {
  bucket: string;
  key: string;
  size: number;
  etag: string | null;
}

const props = defineProps<{
  target: PreviewTarget | null;
}>();

defineEmits<{
  (e: 'close'): void;
}>();

// Window state & dragging
const windowRef = ref<HTMLElement | null>(null);
const pos = ref({
  left: Math.max(0, Math.floor(((typeof window !== 'undefined' ? window.innerWidth : 1024) - 640) / 2)),
  top: Math.max(0, Math.floor(((typeof window !== 'undefined' ? window.innerHeight : 768) - 420) / 2)),
});

let dragging = false;
let dragOffset = { x: 0, y: 0 };

function onPointerDown(e: PointerEvent) {
  if ((e.target as HTMLElement).closest('button')) return;
  dragging = true;
  dragOffset = {
    x: e.clientX - pos.value.left,
    y: e.clientY - pos.value.top,
  };
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent) {
  if (!dragging) return;
  const width = windowRef.value ? windowRef.value.offsetWidth : 640;
  const rawLeft = e.clientX - dragOffset.x;
  const rawTop = e.clientY - dragOffset.y;
  const minLeft = 60 - width;
  const maxLeft = window.innerWidth - 60;
  const minTop = 0;
  const maxTop = Math.max(0, window.innerHeight - 24);
  pos.value.left = Math.min(Math.max(rawLeft, minLeft), maxLeft);
  pos.value.top = Math.min(Math.max(rawTop, minTop), maxTop);
}

function onPointerUp(e: PointerEvent) {
  if (dragging) {
    dragging = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
  }
}

// Data loading
const bytes = shallowRef<Uint8Array>(new Uint8Array(0));
const loaded = computed(() => bytes.value.length);
const loading = ref(false);
let requestSeq = 0;
const previewResult = computed(() => {
  if (!props.target) {
    return { kind: 'text', kindLabel: 'Text (UTF-8)', text: '' };
  }
  if (props.target.size === 0) {
    return { kind: 'text', kindLabel: 'Text (UTF-8)', text: '(empty object)' };
  }
  const isTruncated = bytes.value.length < props.target.size;
  const res = decodePreview(bytes.value, isTruncated);
  return {
    kind: res.kind,
    kindLabel: res.kind === 'text' ? 'Text (UTF-8)' : 'Hex',
    text: res.text,
  };
});

async function loadTarget(t: PreviewTarget | null) {
  const curSeq = ++requestSeq;
  bytes.value = new Uint8Array(0);

  if (!t) {
    if (curSeq === requestSeq) {
      loading.value = false;
    }
    return;
  }
  if (t.size === 0) {
    if (curSeq === requestSeq) {
      loading.value = false;
    }
    return;
  }
  const cacheKey = `${t.bucket}\n${t.key}\n${t.etag}`;
  const cached = previewCache.get(cacheKey);
  if (cached) {
    bytes.value = cached;
    if (curSeq === requestSeq) {
      loading.value = false;
    }
    return;
  }
  const range = initialRange(t.size);
  if (!range) {
    if (curSeq === requestSeq) {
      loading.value = false;
    }
    return;
  }
  loading.value = true;
  try {
    const chunk = await r2GetRange(t.bucket, t.key, range[0], range[1]);
    previewCache.set(cacheKey, chunk);
    if (curSeq === requestSeq) {
      bytes.value = chunk;
    }
  } catch (err) {
    if (curSeq === requestSeq) {
      showError(err);
    }
  } finally {
    if (curSeq === requestSeq) {
      loading.value = false;
    }
  }
}

async function showMore() {
  if (loading.value) return;
  const t = props.target;
  if (!t || t.size === 0) return;
  const base = bytes.value;
  const range = showMoreRange(t.size, base.length);
  if (!range) return;

  const cacheKey = `${t.bucket}\n${t.key}\n${t.etag}`;
  const curSeq = ++requestSeq;
  loading.value = true;
  try {
    const chunk = await r2GetRange(t.bucket, t.key, range[0], range[1]);
    const combined = new Uint8Array(base.length + chunk.length);
    combined.set(base, 0);
    combined.set(chunk, base.length);
    previewCache.set(cacheKey, combined);
    if (curSeq === requestSeq) {
      bytes.value = combined;
    }
  } catch (err) {
    if (curSeq === requestSeq) {
      showError(err);
    }
  } finally {
    if (curSeq === requestSeq) {
      loading.value = false;
    }
  }
}

watch(
  () => props.target,
  (newTarget) => {
    loadTarget(newTarget);
  },
  { immediate: true }
);
</script>

<template>
  <div
    ref="windowRef"
    class="window floating-window"
    :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
  >
    <div
      class="title-bar"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <div class="title-bar-text">Preview — {{ target?.key }}</div>
      <div class="title-bar-controls">
        <button aria-label="Close" @click="$emit('close')"></button>
      </div>
    </div>
    <div class="window-body preview-body">
      <div class="preview-info">
        <span>Showing {{ loaded }} of {{ target?.size ?? 0 }} bytes · {{ previewResult.kindLabel }}</span>
        <a
          v-if="!loading && loaded < Math.min(target?.size ?? 0, 1048576)"
          href="#"
          @click.prevent="showMore"
        >Show More...</a>
        <span v-if="(target?.size ?? 0) > 1048576 && loaded >= 1048576">
          Only the first 1 MiB is shown; use Download for the full object.
        </span>
      </div>
      <pre class="sunken-panel preview-content">{{ previewResult.text }}</pre>
    </div>
  </div>
</template>

<style scoped>
.floating-window {
  position: fixed;
  z-index: 50;
  resize: both;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-width: 320px;
  min-height: 200px;
  width: 640px;
  height: 420px;
  box-sizing: border-box;
}

.preview-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  margin: 4px;
  gap: 4px;
}

.preview-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.preview-content {
  flex: 1;
  overflow: auto;
  margin: 0;
  white-space: pre-wrap;
  background: #fff;
  padding: 4px;
  font-family: var(--font-mono);
  font-size: 12px;
}
</style>
