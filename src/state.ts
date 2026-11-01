import { ref } from 'vue';
import type { SettingsStatus } from './types';

export const status = ref('Ready');

export const settingsStatus = ref<SettingsStatus>({
  settings: null,
  configured: false,
  r2_configured: false,
});

export const settingsVersion = ref(0);

export const errorDialog = ref<string | null>(null);

export function showError(e: unknown): void {
  errorDialog.value = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
}

export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

export function guardGridCopy(e: Event): void {
  const el = document.activeElement as HTMLElement | null;
  const isInput =
    el !== null &&
    (el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' ||
      el.isContentEditable);
  const sel = window.getSelection();
  const hasSel = sel !== null && !sel.isCollapsed && sel.toString().length > 0;
  if (isInput || hasSel) {
    e.preventDefault();
  }
}
