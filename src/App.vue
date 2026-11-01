<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch } from 'vue';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import { loadSettings } from './api';
import { status, settingsStatus, showError, errorDialog } from './state';
import { ICONS } from './icons';
import D1Panel from './components/D1Panel.vue';
import R2Panel from './components/R2Panel.vue';
import SettingsDialog from './components/SettingsDialog.vue';
import Win98Dialog from './components/Win98Dialog.vue';

const tab = ref<'d1' | 'r2'>('d1');
const showSettings = ref(false);
const showAbout = ref(false);
const appVersion = ref('');
const errorOkBtn = ref<HTMLButtonElement | null>(null);
let unlistenMenu: UnlistenFn | null = null;

function runEditCommand(cmd: string) {
  if (!document.execCommand(cmd)) {
    status.value = 'Clipboard command unavailable; use Ctrl+X / Ctrl+C / Ctrl+V';
  }
}

watch(errorDialog, (val) => {
  if (val !== null) {
    nextTick(() => {
      errorOkBtn.value?.focus();
    });
  }
});

onMounted(async () => {
  try {
    unlistenMenu = await listen<string>('menu', (e) => {
      const payload = e.payload;
      if (payload === 'settings') {
        showSettings.value = true;
      } else if (payload === 'about') {
        showAbout.value = true;
      } else if (payload === 'cut' || payload === 'copy' || payload === 'paste') {
        runEditCommand(payload);
      }
    });
  } catch (err) {
    console.error('Failed to register menu listener', err);
  }

  try {
    appVersion.value = await getVersion();
  } catch {
    appVersion.value = '0.1.0';
  }

  try {
    settingsStatus.value = await loadSettings();
    if (!settingsStatus.value.configured) {
      showSettings.value = true;
      status.value = 'Not configured: use File › Settings...';
    }
  } catch (e) {
    showError(e);
    showSettings.value = true;
  }
});

onUnmounted(() => {
  if (unlistenMenu) {
    unlistenMenu();
    unlistenMenu = null;
  }
});
</script>

<template>
  <menu role="tablist">
    <li role="tab" :aria-selected="tab === 'd1'">
      <a href="#d1" @click.prevent="tab = 'd1'">D1</a>
    </li>
    <li role="tab" :aria-selected="tab === 'r2'">
      <a href="#r2" @click.prevent="tab = 'r2'">R2</a>
    </li>
  </menu>

  <div class="window" role="tabpanel" style="display: flex; flex-direction: column; box-sizing: border-box;">
    <D1Panel v-show="tab === 'd1'" />
    <R2Panel v-show="tab === 'r2'" :active="tab === 'r2'" />
  </div>

  <div class="status-bar">
    <p class="status-bar-field">{{ status }}</p>
  </div>

  <SettingsDialog v-if="showSettings" @close="showSettings = false" />

  <Win98Dialog v-if="showAbout" title="About cf_explore" @close="showAbout = false">
    <div style="display: flex; flex-direction: column; gap: 8px;">
      <div><strong>cf_explore v{{ appVersion }}</strong></div>
      <div>
        A lightweight explorer for Cloudflare D1 databases and R2 buckets. Run SQL against D1 (UPDATE/DELETE require a WHERE clause) and browse, preview, and download R2 objects (read-only). Built with Tauri, Vue and Rust.
      </div>
      <div style="color: #444;">Font: “MS Sans Serif” by lou (FontStruct), CC BY-SA 3.0.</div>
      <div style="display: flex; justify-content: center; margin-top: 8px;">
        <button autofocus @click="showAbout = false" style="min-width: 60px;">OK</button>
      </div>
    </div>
  </Win98Dialog>

  <Win98Dialog v-if="errorDialog !== null" title="Error" @close="errorDialog = null">
    <div style="display: flex; gap: 12px; align-items: flex-start;">
      <span v-html="ICONS.error" style="flex-shrink: 0;"></span>
      <div style="white-space: pre-wrap; word-break: break-word; flex: 1; max-height: 300px; overflow-y: auto;">
        {{ errorDialog }}
      </div>
    </div>
    <div style="display: flex; justify-content: center; margin-top: 12px;">
      <button ref="errorOkBtn" autofocus @click="errorDialog = null" style="min-width: 60px;">OK</button>
    </div>
  </Win98Dialog>
</template>
