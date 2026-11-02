// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  status,
  settingsStatus,
  settingsVersion,
  errorDialog,
  showError,
  quoteIdent,
  guardGridCopy,
} from './state';

describe('state module', () => {
  beforeEach(() => {
    status.value = 'Ready';
    settingsStatus.value = {
      settings: null,
      configured: false,
      r2_configured: false,
    };
    settingsVersion.value = 0;
    errorDialog.value = null;
  });

  describe('quoteIdent', () => {
    it('quotes identifiers and escapes double-quote characters', () => {
      expect(quoteIdent('users')).toBe('"users"');
      expect(quoteIdent('a"b')).toBe('"a""b"');
      expect(quoteIdent('""')).toBe('""""""');
      expect(quoteIdent('""')).toHaveLength(6);
      expect(quoteIdent('')).toBe('""');
      expect(quoteIdent('a b;--')).toBe('"a b;--"');
    });
  });

  describe('showError', () => {
    it('sets errorDialog from strings, errors, objects, numbers, and null', () => {
      showError('boom');
      expect(errorDialog.value).toBe('boom');

      showError(new Error('bad'));
      expect(errorDialog.value).toBe('bad');

      showError({ a: 1 });
      expect(errorDialog.value).toBe('[object Object]');

      showError(42);
      expect(errorDialog.value).toBe('42');

      showError(null);
      expect(errorDialog.value).toBe('null');

      errorDialog.value = null;
      showError('x');
      expect(errorDialog.value).toBe('x');
    });
  });

  describe('guardGridCopy', () => {
    const elementsToClean: HTMLElement[] = [];

    afterEach(() => {
      for (const el of elementsToClean) {
        el.remove();
      }
      elementsToClean.length = 0;
      window.getSelection()?.removeAllRanges();
      (document.activeElement as HTMLElement | null)?.blur();
    });

    it('prevents default when an input is focused', () => {
      const input = document.createElement('input');
      document.body.appendChild(input);
      elementsToClean.push(input);
      input.focus();

      const e = new CustomEvent('beforecopy', { cancelable: true });
      guardGridCopy(e);
      expect(e.defaultPrevented).toBe(true);
    });

    it('prevents default when a textarea is focused', () => {
      const textarea = document.createElement('textarea');
      document.body.appendChild(textarea);
      elementsToClean.push(textarea);
      textarea.focus();

      const e = new CustomEvent('beforecopy', { cancelable: true });
      guardGridCopy(e);
      expect(e.defaultPrevented).toBe(true);
    });

    it('prevents default when a select is focused', () => {
      const select = document.createElement('select');
      document.body.appendChild(select);
      elementsToClean.push(select);
      select.focus();

      const e = new CustomEvent('beforecopy', { cancelable: true });
      guardGridCopy(e);
      expect(e.defaultPrevented).toBe(true);
    });

    it('prevents default when a contenteditable element is focused', () => {
      const div = document.createElement('div');
      Object.defineProperty(div, 'isContentEditable', { get: () => true, configurable: true });
      div.tabIndex = 0;
      document.body.appendChild(div);
      elementsToClean.push(div);
      div.focus();

      const e = new CustomEvent('beforecopy', { cancelable: true });
      guardGridCopy(e);
      expect(e.defaultPrevented).toBe(true);
    });

    it('prevents default with a non-empty selection and nothing focused', () => {
      (document.activeElement as HTMLElement | null)?.blur();
      const p = document.createElement('p');
      p.textContent = 'hello';
      document.body.appendChild(p);
      elementsToClean.push(p);

      const sel = window.getSelection();
      expect(sel).not.toBeNull();
      const range = document.createRange();
      range.selectNodeContents(p);
      sel?.removeAllRanges();
      sel?.addRange(range);

      const e = new CustomEvent('beforecopy', { cancelable: true });
      guardGridCopy(e);
      expect(e.defaultPrevented).toBe(true);
    });

    it('does not prevent default when nothing is focused and selection is empty', () => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.getSelection()?.removeAllRanges();

      const e = new CustomEvent('beforecopy', { cancelable: true });
      guardGridCopy(e);
      expect(e.defaultPrevented).toBe(false);
    });

    it('does not prevent default when a button is focused with no selection', () => {
      window.getSelection()?.removeAllRanges();
      const button = document.createElement('button');
      document.body.appendChild(button);
      elementsToClean.push(button);
      button.focus();

      const e = new CustomEvent('beforecopy', { cancelable: true });
      guardGridCopy(e);
      expect(e.defaultPrevented).toBe(false);
    });
  });
});
