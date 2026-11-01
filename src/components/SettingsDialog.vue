<script setup lang="ts">
import { reactive, ref } from 'vue';
import Win98Dialog from './Win98Dialog.vue';
import { saveSettings } from '../api';
import { settingsStatus, settingsVersion, status } from '../state';
import type { Settings } from '../types';

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const form = reactive<Settings>({
  account_id: settingsStatus.value.settings?.account_id ?? '',
  api_token: settingsStatus.value.settings?.api_token ?? '',
  r2_access_key_id: settingsStatus.value.settings?.r2_access_key_id ?? '',
  r2_secret_access_key: settingsStatus.value.settings?.r2_secret_access_key ?? '',
});

const error = ref<string | null>(null);
const saving = ref(false);

async function onSubmit(): Promise<void> {
  try {
    saving.value = true;
    error.value = null;
    const res = await saveSettings({ ...form });
    settingsStatus.value = res;
    settingsVersion.value++;
    status.value = 'Settings saved';
    emit('close');
  } catch (e: unknown) {
    error.value = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Win98Dialog title="Settings" :width="420" @close="emit('close')">
    <form @submit.prevent="onSubmit">
      <fieldset>
        <legend>Cloudflare API (D1)</legend>
        <div class="field-row-stacked">
          <label for="account_id">Account ID</label>
          <input
            id="account_id"
            v-model="form.account_id"
            type="text"
            style="width: 100%; box-sizing: border-box;"
          />
        </div>
        <div class="field-row-stacked" style="margin-top: 6px;">
          <label for="api_token">API token</label>
          <input
            id="api_token"
            v-model="form.api_token"
            type="password"
            style="width: 100%; box-sizing: border-box;"
          />
        </div>
        <p style="margin: 6px 0 0 0; color: #444; font-size: 11px;">
          Token needs Account › D1 › Edit permission.
        </p>
      </fieldset>

      <fieldset style="margin-top: 8px;">
        <legend>R2 S3 API (optional)</legend>
        <div class="field-row-stacked">
          <label for="r2_access_key_id">Access Key ID</label>
          <input
            id="r2_access_key_id"
            v-model="form.r2_access_key_id"
            type="text"
            style="width: 100%; box-sizing: border-box;"
          />
        </div>
        <div class="field-row-stacked" style="margin-top: 6px;">
          <label for="r2_secret_access_key">Secret Access Key</label>
          <input
            id="r2_secret_access_key"
            v-model="form.r2_secret_access_key"
            type="password"
            style="width: 100%; box-sizing: border-box;"
          />
        </div>
        <p style="margin: 6px 0 0 0; color: #444; font-size: 11px;">
          Create keys under R2 › Manage API tokens; use Admin Read only so buckets can be listed.
        </p>
      </fieldset>

      <p
        v-if="error"
        style="color: #c00000; margin: 8px 0 0 0; white-space: pre-wrap; word-break: break-word;"
      >
        {{ error }}
      </p>

      <div
        style="display: flex; justify-content: space-between; align-items: center; margin-top: 12px;"
      >
        <span style="color: #444; font-size: 11px;">Saved to ~/.config/cf_explore.json</span>
        <div style="display: flex; gap: 6px;">
          <button type="submit" class="default" :disabled="saving">OK</button>
          <button type="button" @click="emit('close')">Cancel</button>
        </div>
      </div>
    </form>
  </Win98Dialog>
</template>
